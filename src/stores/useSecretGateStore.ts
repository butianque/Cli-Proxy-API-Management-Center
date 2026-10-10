/**
 * 主密码门（Secret Gate）。
 *
 * 用户 2026-10-10 拍板的安全机制，语义如下：
 *
 * 1. **登录后验证**：进入面板后弹窗要求验证主密码；**可不填、可填错、可关闭**，
 *    失败/跳过 → **锁住所有加密数据访问**（非加密功能照常可用）。
 * 2. **验证通过 = 解锁密钥库**（基座侧真解锁，不是前端假装）：先 `verify` 再 `unlock`，
 *    因为 `verify` 只验口令、不改变解锁状态。
 * 3. **空闲 10 分钟 → 直接登出**：从「最后一次用户主动操作」起算；
 *    面板内任何主动操作（鼠标/点击/滚屏/键盘/切页）都重置计时器；后台轮询不算。
 * 4. **登出 = 清除会话，密钥库对新会话锁死**（`useAuthStore.logout()` 里发
 *    `POST /secrets/lock`），登出后回登录页，下次登录自然重走第 1 步
 *    ——**一个计时器管两件事**（已验证态与 CPA 会话同生命周期）。
 *    锁库必须落在 `logout()` 本身而不是某一条调用路径上：空闲超时与手动登出
 *    都走 `logout()`，任何一处漏掉，「登出后换新会话」就能绕过主密码。
 * 5. **「已验证」绑 CPA 会话，不绑页面加载**（2026-10-10 修正）：按第 4 条，
 *    「已验证」的生命周期就等于 CPA 会话的生命周期，所以**同一会话内刷新（F5）
 *    不该要求重新验证** —— 那时后端密钥库仍是解锁的，再问一次既是多余的打扰，
 *    又与「会话边界才是失效点」矛盾。故验证通过后记一个**仅含事实、不含密码**
 *    的会话标记（`sessionStorage`：同一标签页存续、关页即失效）；刷新时若标记在
 *    **且**后端确实仍解锁，就直接恢复为「已验证」。
 *    **跳过验证不记标记** → 刷新后仍会再问（顶栏常驻锁定条也仍是入口）。
 *
 * ⚠️ 本 store 只负责「门」的状态与计时；真正的锁定/解锁请求在 `smsApi`。
 * 主密码明文只活在内存（`passphrase`），**不落盘**（persist 只存 `idleTimeoutMs`）。
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { clearSharedActivity } from '@/features/sms/idleActivity';

/** 空闲超时默认 10 分钟（用户拍板）。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** 活动事件的节流窗口：避免 mousemove 每毫秒都重置计时器。 */
const ACTIVITY_THROTTLE_MS = 1000;

/**
 * 「本 CPA 会话已验证主密码」的标记。
 *
 * 用 `sessionStorage` 而非 `localStorage`，因为它要表达的正是「**这个会话**」：
 * 同一标签页刷新（F5）后仍在，关掉标签页/浏览器即消失。登出时显式清除。
 *
 * **只存一个事实性标记，绝不存主密码。** 它本身不是安全边界——每次恢复都会
 * 再去问后端「库现在到底锁没锁」（见 `SecretGateModal`），标记只是让同会话内
 * 不重复打扰。清掉标记的唯一后果是「下次加载多问一遍」。
 */
const SESSION_VERIFIED_KEY = 'cpa.secret-gate.verified';

export function markSessionVerified(): void {
  try {
    window.sessionStorage.setItem(SESSION_VERIFIED_KEY, '1');
  } catch {
    // Private mode / storage disabled: the gate simply asks again on reload.
  }
}

export function clearSessionVerified(): void {
  try {
    window.sessionStorage.removeItem(SESSION_VERIFIED_KEY);
  } catch {
    // Nothing to do; the marker could not have been set either.
  }
}

/** 本会话是否验证过主密码（不检查后端是否仍解锁——那是调用方的事）。 */
export function isSessionVerified(): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_VERIFIED_KEY) === '1';
  } catch {
    return false;
  }
}

export type SecretGatePhase =
  /** 未询问（登录前 / 未开始校验）。 */
  | 'idle'
  /** 正在校验主密码。 */
  | 'verifying'
  /** 已验证：密钥库已解锁，加密数据可访问。 */
  | 'unlocked'
  /** 已锁定：用户跳过 / 填错 / 或超时后——加密数据不可访问。 */
  | 'locked';

interface SecretGateState {
  phase: SecretGatePhase;
  /** 验证失败的原因（口令错 / 其它），供弹窗展示。 */
  errorKey: string | null;
  /** 上次成功解锁时用户输入的主密码（仅内存，用于随写请求传 passphrase）。 */
  passphrase: string;
  /** 是否已安装主密码（false = 纯机器模式库，无需验证）。 */
  passphraseSet: boolean;
  /** 密钥库是否可用（enabled + initialized）。 */
  storeAvailable: boolean;
  /** 密钥库功能是否启用（安全分区据此决定是否展示主密码管理）。 */
  storeEnabled: boolean;
  /** 空闲超时（毫秒），可配。 */
  idleTimeoutMs: number;
  /** 空闲计时器的最后活动时间戳（内存，不持久化）。 */
  lastActivityAt: number;

  /** 查询并返回密钥库是否能被本面板使用；同时刷新 passphraseSet/storeAvailable。 */
  refreshStoreState: (status: {
    enabled: boolean;
    initialized: boolean;
    passphrase: boolean;
  }) => void;
  /** 校验主密码：成功 → verify+unlock → phase=unlocked；失败 → phase=locked。 */
  verifyAndUnlock: (passphrase: string, unlock: (p: string) => Promise<void>) => Promise<boolean>;
  /** 用户跳过 / 关闭弹窗 → 进入锁定态（密钥库保持或转为锁定）。 */
  skip: () => void;
  /**
   * 更换主密码成功后采用新值：解着锁继续用（否则后续写凭据还在送旧密码）。
   * 能提供正确的当前主密码，等于已证明身份，故同时标记本会话已验证。
   */
  adoptPassphrase: (passphrase: string) => void;
  /** 记录一次用户主动活动，重置空闲计时器。 */
  touch: () => void;
  /** 完全重置（登出时调用）。 */
  reset: () => void;
  setIdleTimeout: (ms: number) => void;
}

export const useSecretGateStore = create<SecretGateState>()(
  persist(
    (set, get) => ({
      phase: 'idle',
      errorKey: null,
      passphrase: '',
      passphraseSet: false,
      storeAvailable: false,
      storeEnabled: false,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      lastActivityAt: Date.now(),

      refreshStoreState: (status) => {
        set({
          storeAvailable: status.enabled && status.initialized,
          storeEnabled: status.enabled,
          passphraseSet: status.passphrase,
        });
      },

      verifyAndUnlock: async (passphrase, unlock) => {
        set({ phase: 'verifying', errorKey: null });
        try {
          await unlock(passphrase);
        } catch (error) {
          // The operator may have skipped or logged out while the round-trip was
          // in flight; their choice wins. Only a still-open dialog returns to
          // `idle` (with the error shown in place) so they can retry.
          if (get().phase !== 'verifying') return false;
          const data = (error as { data?: { error?: string } })?.data;
          set({
            phase: 'idle',
            errorKey: data?.error ?? 'verify_failed',
            passphrase: '',
          });
          return false;
        }
        // Same rule on success: if the gate already moved on (skip / reset), do
        // not force it open. The backend is unlocked either way, but the page
        // keeps credentials hidden until a session actually verifies.
        if (get().phase !== 'verifying') return false;
        markSessionVerified();
        set({
          phase: 'unlocked',
          errorKey: null,
          passphrase,
          lastActivityAt: Date.now(),
        });
        return true;
      },

      skip: () => set({ phase: 'locked', errorKey: null, passphrase: '' }),

      touch: () => {
        // Any activity resets the idle clock, in the unlocked and the locked
        // state alike: the CPA session itself is what times out.
        if (get().phase === 'idle') return;
        set({ lastActivityAt: Date.now() });
      },

      // 登出 = 门回到「未询问」：连「库是否可用 / 是否装了主密码」也要清掉。
      // 否则登录页会拿着上一次会话的 storeAvailable/passphraseSet 把弹窗又弹出来。
      // 同时清掉「本会话已验证」标记：登出即会话结束，下次登录必须重新验证。
      reset: () => {
        clearSessionVerified();
        clearSharedActivity();
        set({
          phase: 'idle',
          errorKey: null,
          passphrase: '',
          passphraseSet: false,
          storeAvailable: false,
          storeEnabled: false,
          lastActivityAt: Date.now(),
        });
      },

      // Floor is 10s so the guard can be exercised end-to-end; the shipped
      // default remains the user-approved 10 minutes.
      setIdleTimeout: (ms) => set({ idleTimeoutMs: Math.max(10_000, ms) }),

      // Placed last on purpose: source-contract tests slice an action's body up
      // to the next action's name, so this must not sit between two actions they
      // inspect (`skip`→`touch`, `reset`→`setIdleTimeout`).
      adoptPassphrase: (passphrase) => {
        markSessionVerified();
        set({
          phase: 'unlocked',
          errorKey: null,
          passphrase,
          // A passphrase now exists and the store just answered, so it is
          // enabled, initialized, and usable.
          passphraseSet: true,
          storeAvailable: true,
          lastActivityAt: Date.now(),
        });
      },
    }),
    {
      name: 'cpa.secret-gate',
      storage: createJSONStorage(() => localStorage),
      // 只持久化可配项；phase/passphrase/lastActivityAt 必须每次会话重来。
      partialize: (state) => ({ idleTimeoutMs: state.idleTimeoutMs }),
    }
  )
);

/** 供非组件代码读取（如 API 层要取 passphrase 时）。 */
export const getSecretGate = () => useSecretGateStore.getState();

export { ACTIVITY_THROTTLE_MS };
