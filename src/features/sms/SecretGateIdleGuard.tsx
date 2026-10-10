/**
 * 空闲守卫（SecretGateIdleGuard）。
 *
 * 用户 2026-10-10 拍板：**空闲 10 分钟 → 直接登出**（并锁定后端密钥库）。
 *
 * - 只把**用户主动操作**算作活动（鼠标移动/按下、滚屏、按键、点击、切页）；
 * - 后台轮询/自动刷新**不算**（否则永远不会超时）；
 * - 面板内任何主动操作都重置计时器（活动事件节流，避免 mousemove 高频触发）；
 * - 超时 → 既有 `logout()`（回登录页；`logout()` 内部会 `POST /secrets/lock` 真锁）；
 * - **已验证态与锁定态都计时**：只要已登录，停手满超时即登出（用户 2026-10-10 明确）。
 *
 * ## 计时起点必须落在「标签页」上，而不是「页面加载」上
 *
 * 起算时刻记在 **`sessionStorage`** 里（`cpa.secret-gate.lastActivity`），
 * 因为 `lastActivityAt` 只是内存状态、**刷新即重置**：若拿内存值判断，
 * 那么「**加载页面 → 在超时窗口内不做任何操作**」永远等不到超时——每刷新一次
 * 就把时钟拨回当前时刻。用 sessionStorage 表示「这个标签页里的会话」，
 * 于是刷新**不会**把无操作时长清零：
 *
 * - 标签页已空置超过阈值 → **下一次检查立即登出**（而不是再续一个整窗口）；
 * - 标签页仍在活动 → 照常从最后一次操作起算。
 *
 * 标签页关掉后会话随之消失，这里也不需要清理这个键。
 *
 * 无 UI；挂在 RootShell 里，只在已登录时生效。
 */

import { useEffect, useRef } from 'react';
import { useAuthStore } from '@/stores/useAuthStore';
import { useSecretGateStore, ACTIVITY_THROTTLE_MS } from '@/stores/useSecretGateStore';

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

/**
 * 最后一次用户活动的时刻，跨刷新有效。
 * 与 `useSecretGateStore` 的 `SESSION_VERIFIED_KEY` 一样，sessionStorage
 * 表达的正是「这个标签页里的会话」。
 */
const LAST_ACTIVITY_KEY = 'cpa.secret-gate.lastActivity';

function readLastActivity(): number | null {
  try {
    const raw = window.sessionStorage.getItem(LAST_ACTIVITY_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeLastActivity(at: number): void {
  try {
    window.sessionStorage.setItem(LAST_ACTIVITY_KEY, String(at));
  } catch {
    // Private mode / storage disabled: fall back to the in-memory clock.
  }
}

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
      writeLastActivity(now);
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
      // 两个起算点取较早者：内存值（本页活动）与持久值（上次活动，可能是刷新前）。
      // 用「较早」而不是「刷新即重置」，无操作时长才能跨刷新累积。
      const inMemory = useSecretGateStore.getState().lastActivityAt;
      const persisted = readLastActivity();
      const lastActivity = persisted === null ? inMemory : Math.min(inMemory, persisted);
      if (Date.now() - lastActivity < idleTimeoutMs) return;

      firingRef.current = true;
      // 超时 = 会话结束：先让门回到未询问，再登出。
      // 登出会拿当前会话的密钥把密钥库锁死（见 useAuthStore.logout），这里不再单独调用。
      // `void`：登出必须立即生效，锁库在后台收尾。
      reset();
      void logout();
      firingRef.current = false;
    }, interval);

    return () => window.clearInterval(timer);
  }, [isAuthenticated, idleTimeoutMs, reset, logout]);

  return null;
}
