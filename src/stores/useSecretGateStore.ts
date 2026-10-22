/**
 * 主密码门（Secret Gate）。
 *
 * 用户 2026-10-10 拍板的安全机制，语义如下：
 *
 * 1. **登录后验证**：进入面板后弹窗要求验证主密码；**可不填、可填错、可关闭**，
 *    失败/跳过 → **锁住所有加密数据访问**（非加密功能照常可用）。
 * 2. **验证通过 = 解锁凭据**（基座侧真解锁，不是前端假装）：先 `verify` 再 `unlock`，
 *    因为 `verify` 只验口令、不改变解锁状态。
 * 3. **空闲 10 分钟 → 直接登出**：从「最后一次用户主动操作」起算；
 *    面板内任何主动操作（鼠标/点击/滚屏/键盘/切页）都重置计时器；后台轮询不算。
 * 4. **登出 = 结束会话**（`useAuthStore.logout()` 里发 `DELETE /session`），
 *    凭据授权挂在会话上，会话一结束这个会话就读不到凭据了。
 * 5. **是否已解锁一律以后端为准**（2026-10-20 修正）：解锁状态属于**会话**，
 *    所以刷新页面（F5）时只要还在同一个会话里，后端仍报告已解锁 → 直接放行；
 *    登出再登录则是新会话，后端报告未解锁 → 照常再问。
 *
 *    这里曾经用一个 `sessionStorage` 标记「本会话已验证」来省掉刷新后的重复询问，
 *    但那个标记只是浏览器自己记的账：它既可能在会话已经换人时仍然存在（登出后
 *    重新登录却不问主密码），也可能在会话其实还有效时缺失（可用却弹窗）。服务端
 *    已经是唯一真相源，前端再记一份只会与它打架，故整个标记机制已删除。
 *
 * ⚠️ 本 store 只负责「门」的状态与计时；真正的锁定/解锁请求在 `smsApi`。
 * 主密码明文只活在内存（`passphrase`），**不落盘**（persist 只存 `idleTimeoutMs`）。
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { clearSharedActivity, readSharedActivity } from '@/features/sms/idleActivity';

/** 空闲超时默认 10 分钟（用户拍板）。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** 活动事件的节流窗口：避免 mousemove 每毫秒都重置计时器。 */
const ACTIVITY_THROTTLE_MS = 1000;

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
  /** 校验主密码：成功 → verify+unlock → phase=unlocked；失败 → 回到询问前的那一档。 */
  verifyAndUnlock: (passphrase: string, unlock: (p: string) => Promise<void>) => Promise<boolean>;
  /** 用户跳过 / 关闭弹窗 → 进入锁定态（密钥库保持或转为锁定）。 */
  skip: () => void;
  /**
   * 空闲超时 → 只锁凭据库，不动登录态。
   *
   * 与 `reset` 的区别是保留「库可用 / 装了主密码」这两个事实，弹窗因此会重新
   * 出现要主密码；而「这个浏览器还签着」由服务端的会话决定，不该由空闲计时器
   * 顺手结束掉 —— 那是把「十分钟没动」误判成「换了个浏览器」。
   */
  lock: () => void;
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
      passphrase: '',
      passphraseSet: false,
      storeAvailable: false,
      storeEnabled: false,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      // 初值取「共享的最后活动时刻」，而不是 `Date.now()`：刷新页面（F5）时
      // 时钟必须接着上一次的算，否则每刷一次就把 10 分钟重新计一遍，空闲登出
      // 永远不会触发。
      lastActivityAt: readSharedActivity() ?? Date.now(),

      refreshStoreState: (status) => {
        set({
          storeAvailable: status.enabled && status.initialized,
          storeEnabled: status.enabled,
          passphraseSet: status.passphrase,
        });
      },

      verifyAndUnlock: async (passphrase, unlock) => {
        // 记住进来时的那一档：失败要回到原处，而不是一律回到 `idle`（见 catch）。
        const previousPhase = get().phase;
        set({ phase: 'verifying' });
        try {
          await unlock(passphrase);
        } catch {
          // The operator may have skipped or logged out while the round-trip was
          // in flight; their choice wins. Only a still-open dialog returns to its
          // own state (with the error shown in place) so they can retry.
          if (get().phase !== 'verifying') return false;
          // 回到**进来时**的那一档：从「锁定提示条」进来的留在提示条（错误就地显示、
          // 可重试），从登录弹窗进来的留在弹窗。一律改成 `idle` 会让提示条的弹窗消失、
          // 又弹出登录弹窗，把错误提示丢掉 —— 操作者只看到弹窗闪没，不知道是密码错了。
          set({
            phase: previousPhase === 'verifying' ? 'idle' : previousPhase,
            passphrase: '',
          });
          return false;
        }
        // Same rule on success: if the gate already moved on (skip / reset), do
        // not force it open. The backend is unlocked either way, but the page
        // keeps credentials hidden until a session actually verifies.
        if (get().phase !== 'verifying') return false;
        set({
          phase: 'unlocked',
          passphrase,
          lastActivityAt: Date.now(),
        });
        return true;
      },

      skip: () => set({ phase: 'locked', passphrase: '' }),

      touch: () => {
        // Any activity resets the idle clock, in the unlocked and the locked
        // state alike: the CPA session itself is what times out.
        if (get().phase === 'idle') return;
        set({ lastActivityAt: Date.now() });
      },

      // 登出 = 门回到「未询问」：连「库是否可用 / 是否装了主密码」也要清掉。
      // 否则登录页会拿着上一次会话的 storeAvailable/passphraseSet 把弹窗又弹出来。
      // 解锁状态本身不用清：它是会话的属性，下次登录是新会话，后端会如实报告未解锁。
      reset: () => {
        clearSharedActivity();
        set({
          phase: 'idle',
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

      // Idle timeout locks the credential store only. Placed after
      // `setIdleTimeout` because source-contract tests slice `skip`→`touch` and
      // `reset`→`setIdleTimeout`; a new action between those would be absorbed
      // into the sliced body.
      lock: () =>
        set({
          phase: 'idle',
          passphrase: '',
          lastActivityAt: Date.now(),
        }),

      // Placed last on purpose: source-contract tests slice an action's body up
      // to the next action's name, so this must not sit between two actions they
      // inspect (`skip`→`touch`, `reset`→`setIdleTimeout`).
      adoptPassphrase: (passphrase) => {
        set({
          phase: 'unlocked',
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

export { ACTIVITY_THROTTLE_MS };
