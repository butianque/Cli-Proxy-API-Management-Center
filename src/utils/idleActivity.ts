/**
 * 空闲计时用的「最近一次用户活动」时刻。
 *
 * 放在独立模块里，是为了让 `useSecretGateStore`（登出时清掉它）与
 * `SessionIdleGuard`（读取并写入它）共用同一份实现，而不产生循环依赖。
 *
 * **必须用 `localStorage`**：同源共享，所有标签页看到同一个值。`sessionStorage`
 * 是每标签页独立的——两个页面互相看不见对方的活动，多开时必然算错空闲时长。
 *
 * 语义：**只要还有任何一个标签页在操作，就不算空闲。**
 */

export const SHARED_ACTIVITY_KEY = 'cpa.session.lastActivity';

/** 最近一次用户活动的时刻（同源共享）；没记录过则返回 null。 */
export function readSharedActivity(): number | null {
  try {
    const raw = window.localStorage.getItem(SHARED_ACTIVITY_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** 记录一次用户活动（同源共享）。 */
export function writeSharedActivity(at: number): void {
  try {
    window.localStorage.setItem(SHARED_ACTIVITY_KEY, String(at));
  } catch {
    // Private mode / storage disabled: 退回内存时钟（本页仍然可用）。
  }
}

/** 会话结束时清掉，避免下一个会话继承上一次的活动时刻。 */
export function clearSharedActivity(): void {
  try {
    window.localStorage.removeItem(SHARED_ACTIVITY_KEY);
  } catch {
    // 写不进去自然也删不掉，忽略。
  }
}
