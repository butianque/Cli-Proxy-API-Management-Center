/**
 * 空闲守卫（SecretGateIdleGuard）。
 *
 * 用户 2026-10-10 拍板的语义：
 *
 * > **用户长时间没有操作 → 自动强行登出账号 + 清空会话 + 锁库。**
 * > **不管开了多少标签页，只管前端交互。**
 *
 * - 只把**用户主动操作**算作活动（鼠标移动/按下、滚屏、按键、点击、切页）；
 * - 后台轮询/自动刷新**不算**（否则永远不会超时）；
 * - 面板内任何主动操作都重置计时器（活动事件节流，避免 mousemove 高频触发）；
 * - 超时 → `logout()`（回登录页 + 清会话 + `POST /secrets/lock` 锁库）；
 * - **已验证态与锁定态都计时**：只要已登录，停手满超时即登出。
 *
 * ## 计时必须「跨标签页共享」且「取最近的活动」
 *
 * 每个标签页都各自跑一遍这个守卫，所以时钟不能放在 `sessionStorage`（那是
 * **每标签页独立**的：两个页面互相看不见对方的活动，必然算错——取较早者会在
 * 你正用一个页面时被另一个闲置页面踢下线；取较晚者又会让一个被遗忘的页面把
 * 会话永远续下去）。「关闭标签页就锁库」同样行不通：多开时关掉其中一个，
 * 并不代表用户不再使用，而另一个页面无法可靠地判定这一点。
 *
 * 因此最后活动时刻写进 **`localStorage`**（同源共享，所有标签页看到同一个值），
 * 判定取 **最近（最大）的那个时刻** ——「只要还有任何一个标签页在操作，就不算
 * 空闲」。每个标签页都会独立地在超时后强行登出自己；由于登出会清掉共享的
 * `isLoggedIn` 并锁库，其余页面在下一次检查时也会跟着登出。
 *
 * 判定条件只有一条：**距最近一次用户操作用了多久**。与后端是否仍有数据无关：
 * 前端登出后就不再持有可用凭据，泄露面被切掉（除非服务器本身被人登录）。
 *
 * 无 UI；挂在 RootShell 里，只在已登录时生效。
 */

import { useEffect, useRef } from 'react';
import { useAuthStore } from '@/stores/useAuthStore';
import { useSecretGateStore, ACTIVITY_THROTTLE_MS } from '@/stores/useSecretGateStore';
import { readSharedActivity, writeSharedActivity } from './idleActivity';

const ACTIVITY_EVENTS: Array<keyof WindowEventMap> = [
  'mousemove',
  'mousedown',
  'wheel',
  'keydown',
  'touchstart',
  'scroll',
  'hashchange',
  'focusin',
];

/** 检查间隔：取超时的 1/4 与 15s 中的较小者，保证短超时也能及时触发。 */
const CHECK_INTERVAL_FLOOR_MS = 5_000;

export function SecretGateIdleGuard() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const idleTimeoutMs = useSecretGateStore((state) => state.idleTimeoutMs);
  const touch = useSecretGateStore((state) => state.touch);
  const reset = useSecretGateStore((state) => state.reset);
  const logout = useAuthStore((state) => state.logout);
  const lastThrottleRef = useRef(0);
  const firingRef = useRef(false);

  // 活动监听：节流后重置计时器。只要已登录就监听（锁定态同样重置）。
  useEffect(() => {
    if (!isAuthenticated) return undefined;

    const onActivity = () => {
      const now = Date.now();
      if (now - lastThrottleRef.current < ACTIVITY_THROTTLE_MS) return;
      lastThrottleRef.current = now;
      writeSharedActivity(now);
      touch();
    };

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }
    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity);
      }
    };
  }, [isAuthenticated, touch]);

  // 检查器：定时看一次是否超时。
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const interval = Math.max(
      CHECK_INTERVAL_FLOOR_MS,
      Math.min(15_000, Math.floor(idleTimeoutMs / 4))
    );

    const timer = window.setInterval(() => {
      if (firingRef.current) return;
      // 取**最近**的一次活动：内存值（本页）与共享值（可能是别的标签页写的）。
      // 「最近」而不是「较早」：只要还有任何一个标签页在操作，就不算空闲。
      const inMemory = useSecretGateStore.getState().lastActivityAt;
      const shared = readSharedActivity();
      const lastActivity = shared === null ? inMemory : Math.max(inMemory, shared);
      if (Date.now() - lastActivity < idleTimeoutMs) return;

      firingRef.current = true;
      // 超时 = 会话结束：清空会话、回登录页，并由 logout() 锁死密钥库。
      reset();
      void logout();
      firingRef.current = false;
    }, interval);

    return () => window.clearInterval(timer);
  }, [isAuthenticated, idleTimeoutMs, reset, logout]);

  return null;
}
