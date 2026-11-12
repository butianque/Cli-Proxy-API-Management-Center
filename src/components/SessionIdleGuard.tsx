/**
 * 会话空闲守卫（SessionIdleGuard）。
 *
 * > **10 分钟没有真实操作 → 结束会话。**
 * > **不管开了多少标签页，只管前端交互。**
 * > **服务端把窗口配成 0 = 关掉空闲时钟，这里就整条不参与。**
 *
 * 结束会话 = 服务端令牌作废、cookie 清掉、凭据授权撤销，回来时管理密钥和主密码
 * 都要重新过一遍。这是本面板对「人离开了」的判定：不是锁一下凭据库，而是这个人
 * 不再被认作已登录。
 *
 * - 只把**用户主动操作**算作活动（鼠标移动/按下、滚屏、按键、点击、切页）；
 * - 后台轮询/自动刷新**不算**（否则永远不会超时）；
 * - 面板内任何主动操作都重置计时器（活动事件节流，避免 mousemove 高频触发）；
 * - 超时 → `logout()`：前端立即回登录页，同时让服务端把会话删掉。
 *
 * ## 为什么前端这条计时不够，服务端也必须是 10 分钟
 *
 * 标签页关掉的时候这个守卫根本不运行。只靠前端的话，「关掉页面去吃个饭再打开」
 * 会被当成同一个会话继续用 —— cookie 还活着，人已经离开。所以服务端也把
 * 「浏览器会话」的空闲窗口压到同一档（`CPA_PANEL_IDLE_MINUTES`）：没有任何页面
 * 在跑的时候，由服务端判死。这里做的是让过程不必等一次 401、也不必看到一次报错。
 *
 * ## 计时要「跨标签页共享」且「取最近的活动」
 *
 * 每个标签页都各自跑一遍这个守卫，所以时钟不能放在 `sessionStorage`（那是
 * **每标签页独立**的：两个页面互相看不见对方的活动，必然算错——取较早者会在
 * 你正用一个页面时被另一个闲置页面踢下线；取较晚者又会让一个被遗忘的页面把
 * 会话永远续下去）。
 *
 * 因此最后活动时刻写进 **`localStorage`**（同源共享，所有标签页看到同一个值），
 * 判定取 **最近（最大）的那个时刻** ——「只要还有任何一个标签页在操作，就不算
 * 空闲」。
 *
 * ## 服务端那份计时也要一起续
 *
 * 主动操作除了写本地时钟，还要 `POST /session/touch` 去续服务端那一份——否则
 * 前端以为自己还在活动，服务端那边已经判死了。
 *
 * 续期被拒（401）**不**等于登出：`touchSession` 按服务端给的原因分流——「不认识
 * 这个令牌」（服务端重启过、会话被清）会先试着把会话悄悄接回来（cookie 优先，
 * 其次内存里的管理密钥），接上了就返回 `renewed`，这里把空闲时钟重新起算；
 * 而「空闲超时 / 绝对上限 / 地址绑定拒绝」是真的该下线，直接登出。只有重建也
 * 接不上时才结束登录态。把任何一条续期的 401 都当成登出，正是「人一直在操作却被
 * 弹回登录页」的成因；反过来，把「你该下线了」也悄悄接上，就等于废掉了这条规则。
 *
 * 无 UI；挂在 RootShell 里，只在已登录时生效。
 */

import { useEffect, useRef } from 'react';
import { useAuthStore } from '@/stores/useAuthStore';
import { useSecretGateStore, ACTIVITY_THROTTLE_MS } from '@/stores/useSecretGateStore';
import { touchSession } from '@/services/api/session';
import { readSharedActivity, writeSharedActivity } from '@/utils/idleActivity';

const ACTIVITY_EVENTS: Array<keyof WindowEventMap> = [
  'mousemove',
  'mousedown',
  'pointerdown',
  'wheel',
  'keydown',
  'touchstart',
  'scroll',
  'hashchange',
  'focusin',
];

/** 检查间隔取超时的 1/4 与 15s 中的较小者，保证短超时也能及时触发。 */
const CHECK_INTERVAL_FLOOR_MS = 5_000;

/** 最近一次真实活动：内存值、本轮会话起点与共享值取**最大**（跨标签页时以别人写的为准）。 */
function newestActivity(): number {
  const { lastActivityAt, sessionStartedAt } = useSecretGateStore.getState();
  const shared = readSharedActivity();
  // `sessionStartedAt` 是地板：上一个会话留在 localStorage 里的时间戳不能把
  // 一个刚建立的会话判成「已经空闲超时」（否则登录后的第一次鼠标移动就会登出，
  // 操作者看到的是「密钥输对了又被弹回登录页」）。
  return Math.max(lastActivityAt, sessionStartedAt, shared ?? 0);
}

export function SessionIdleGuard() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const logout = useAuthStore((state) => state.logout);
  const idleTimeoutMs = useSecretGateStore((state) => state.idleTimeoutMs);
  const touch = useSecretGateStore((state) => state.touch);
  const lastThrottleRef = useRef(0);
  const firingRef = useRef(false);

  // 活动监听：本地时钟与服务端会话一起续。
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    // 空闲时钟被关掉（`idleTimeoutMs <= 0`，服务端把窗口配成 0）时，这里不能只
    // 跳过比较：`now - last >= 0` 恒真，第一次鼠标移动就会登出 —— 比原来的 10 秒
    // 兜底更糟。整条守卫在这档下不参与。
    if (idleTimeoutMs <= 0) return undefined;

    const onActivity = () => {
      const now = Date.now();
      if (now - lastThrottleRef.current < ACTIVITY_THROTTLE_MS) return;
      lastThrottleRef.current = now;
      // 越过窗口之后的第一下「活动」不是活动，是有人回来了。这条判断必须排在续期
      // 之前：`touchSession` 现在会自己把被判死的会话悄悄接上，如果让它先跑，「回来
      // 了」就会被当成「一直在用」，这条规则也就永远不会触发。
      const last = newestActivity();
      if (last > 0 && now - last >= idleTimeoutMs) {
        void logout();
        return;
      }
      writeSharedActivity(now);
      touch();
      // A refused touch is recovered inside touchSession: the cookie first, then
      // the management key. A session that came back is a new session, so its idle
      // floor starts now; a recovery that also failed has already dispatched the
      // global sign-out.
      void touchSession({ persistent: useAuthStore.getState().rememberPassword }).then(
        (outcome) => {
          if (outcome === 'renewed') useSecretGateStore.getState().beginSession();
        }
      );
    };

    for (const event of ACTIVITY_EVENTS) {
      // capture: `scroll` 不冒泡，挂在 window 的冒泡阶段收不到弹窗/表格这类
      // 内部容器的滚动；捕获阶段能收到，于是「在表格里翻页看日志」也算活动。
      window.addEventListener(event, onActivity, { passive: true, capture: true });
    }
    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity, { capture: true });
      }
    };
  }, [isAuthenticated, idleTimeoutMs, logout, touch]);

  // 判定是否超时
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    // 同上：关掉空闲时钟时连定时器都不该起。
    if (idleTimeoutMs <= 0) return undefined;
    const interval = Math.max(
      CHECK_INTERVAL_FLOOR_MS,
      Math.min(15_000, Math.floor(idleTimeoutMs / 4))
    );

    const timer = window.setInterval(() => {
      if (firingRef.current) return;
      const lastActivity = newestActivity();
      if (lastActivity === 0) {
        // 还没有任何活动记录（刚登录、或存储被清过）：从现在开始计时，
        // 而不是立刻判定为超时。
        writeSharedActivity(Date.now());
        return;
      }
      if (Date.now() - lastActivity < idleTimeoutMs) return;

      firingRef.current = true;
      // 超时 = 结束会话，不是只锁凭据库：会话本身就是「这个浏览器还签着」的凭证，
      // 人离开十分钟之后它不该继续有效。`logout()` 会同步清掉前端状态，所以这里
      // 不必等它落地。
      void logout();
      firingRef.current = false;
    }, interval);

    return () => window.clearInterval(timer);
  }, [isAuthenticated, idleTimeoutMs, logout]);

  return null;
}
