/**
 * 空闲守卫（SecretGateIdleGuard）。
 *
 * 用户 2026-10-10 拍板的语义：
 *
 * > **用户长时间没有操作 → 自动强行登出账号 + 清空会话。**
 * > **不管开了多少标签页，只管前端交互。**
 *
 * - 只把**用户主动操作**算作活动（鼠标移动/按下、滚屏、按键、点击、切页）；
 * - 后台轮询/自动刷新**不算**（否则永远不会超时）；
 * - 面板内任何主动操作都重置计时器（活动事件节流，避免 mousemove 高频触发）；
 * - 超时 → `logout()`（回登录页 + 结束会话 + 丢掉令牌）；
 * - **已验证态与锁定态都计时**：只要已登录，停手满超时即登出。
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
 * ## 服务端才是真正的裁判
 *
 * 本地计时只负责「及时把人送回登录页」；会话是否还活着由服务端说了算（它自己
 * 也有空闲与绝对两个上限）。所以主动操作除了写本地时钟，还要 `POST /session/touch`
 * 去续服务端那一份——否则前端以为自己还在活动，服务端那边已经判死了。
 * 续期请求自身失败（401）会由 `apiClient` 统一转成登出，这里不重复处理。
 *
 * 无 UI；挂在 RootShell 里，只在已登录时生效。
 */

import { useEffect, useRef } from 'react';
import { useAuthStore } from '@/stores/useAuthStore';
import { useSecretGateStore, ACTIVITY_THROTTLE_MS } from '@/stores/useSecretGateStore';
import { touchSession } from '@/services/api/session';
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

/** 检查间隔取超时的 1/4 与 15s 中的较小者，保证短超时也能及时触发。 */
const CHECK_INTERVAL_FLOOR_MS = 5_000;

export function SecretGateIdleGuard() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const idleTimeoutMs = useSecretGateStore((state) => state.idleTimeoutMs);
  const touch = useSecretGateStore((state) => state.touch);
  const reset = useSecretGateStore((state) => state.reset);
  const logout = useAuthStore((state) => state.logout);
  const lastThrottleRef = useRef(0);
  const firingRef = useRef(false);

  // 活动监听：本地时钟与服务端会话一起续。
  useEffect(() => {
    if (!isAuthenticated) return undefined;

    const onActivity = () => {
      const now = Date.now();
      if (now - lastThrottleRef.current < ACTIVITY_THROTTLE_MS) return;
      lastThrottleRef.current = now;
      writeSharedActivity(now);
      touch();
      void touchSession();
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

  // 判定是否超时
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const interval = Math.max(
      CHECK_INTERVAL_FLOOR_MS,
      Math.min(15_000, Math.floor(idleTimeoutMs / 4))
    );

    const timer = window.setInterval(() => {
      if (firingRef.current) return;
      // 取**最近**的一次活动：内存值与共享值一起看，跨标签页时以别人写的为准。
      const inMemory = useSecretGateStore.getState().lastActivityAt;
      const shared = readSharedActivity();
      const lastActivity = Math.max(inMemory, shared ?? 0);
      if (lastActivity === 0) {
        // 还没有任何活动记录（刚登录、或存储被清过）：从现在开始计时，
        // 而不是立刻判定为超时。
        writeSharedActivity(Date.now());
        return;
      }
      if (Date.now() - lastActivity < idleTimeoutMs) return;

      firingRef.current = true;
      // 超时 = 会话结束：清门状态 + 回登录页（`logout()` 会结束服务端会话）。
      reset();
      void logout();
      firingRef.current = false;
    }, interval);

    return () => window.clearInterval(timer);
  }, [isAuthenticated, idleTimeoutMs, reset, logout]);

  return null;
}
