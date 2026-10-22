/**
 * 认证状态管理
 * 从原项目 src/modules/login.js 和 src/core/connection.js 迁移
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AuthState, LoginCredentials, ConnectionStatus } from '@/types';
import { STORAGE_KEY_AUTH } from '@/utils/constants';
import { obfuscatedStorage } from '@/services/storage/secureStorage';
import { apiClient } from '@/services/api/client';
import { ensureManagementSession, sessionApi } from '@/services/api/session';
import { markSessionEstablished } from '@/services/api/sessionToken';
import { LegacyBackendError, probeLegacyBackend } from '@/services/api/legacyBackendProbe';
import { useConfigStore } from './useConfigStore';
import { useModelsStore } from './useModelsStore';
import { useQuotaStore } from './useQuotaStore';
import { useSecretGateStore } from './useSecretGateStore';
import { resetEgressPool } from '@/hooks/useEgressPool';
import { detectApiBaseFromLocation, normalizeApiBase } from '@/utils/connection';

interface AuthStoreState extends AuthState {
  connectionStatus: ConnectionStatus;

  // 操作
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<boolean>;
  checkAuth: () => Promise<boolean>;
  restoreSession: () => Promise<boolean>;
  updateServerVersion: (version: string | null, buildDate?: string | null) => void;
  updateServerPluginSupport: (supportsPlugin: boolean) => void;
  /** 更换管理密钥成功后，同步内存中的密钥，让当前会话继续可用。 */
  updateManagementKey: (managementKey: string) => void;
}

let restoreSessionPromise: Promise<boolean> | null = null;

/**
 * 登录/恢复连接后建立管理会话。
 *
 * 凭据读写只认会话，所以这一步必须发生在面板开始读凭据之前。旧版后端没有这条
 * 路由（404），此时保持老行为、不阻断登录；其余错误照常抛出去，让登录失败而
 * 不是带着半截状态进入面板。
 *
 * `persistent` 跟着「记住密码」走：勾了就是关掉浏览器也还认这台机器，没勾就
 * 只活到浏览器关掉。两者都远长于「凭据库解锁」的窗口，那个窗口由服务端单独管。
 *
 * `fresh` 用于「操作者刚输入了密钥」这一条路：此时必须**新建**会话，而不是复用
 * localStorage 里可能还活着的旧令牌 —— 复用不会下发 cookie，于是「浏览器还签着」
 * 这件事就没有凭据可依，下一次刷新又要密钥。
 */
/**
 * 把服务端给的会话窗口装进空闲守卫。
 *
 * 用 `panel_idle_seconds`（浏览器会话的窗口），而不是 `idle_seconds`（凭据授权
 * 的窗口）：守卫到点要做的是**结束会话**，所以它必须跟会话的时钟走。两者默认
 * 相同，但可以分开配置。
 */
function applySessionClock(session: {
  idle_seconds?: number;
  panel_idle_seconds?: number;
}): void {
  const seconds = session.panel_idle_seconds ?? session.idle_seconds;
  if (seconds) {
    useSecretGateStore.getState().setIdleTimeout(seconds * 1000);
  }
}

async function establishSession(persistent = false, fresh = false): Promise<void> {
  try {
    const session = fresh
      ? await sessionApi.start(persistent)
      : await ensureManagementSession(persistent);
    if (session) applySessionClock(session);
  } catch (error) {
    if ((error as { status?: number })?.status === 404) return;
    throw error;
  }
}

/**
 * 用浏览器自己带着的会话恢复登录态。
 *
 * 登录时服务端除了返回令牌，还下发一个 HttpOnly 的会话 cookie —— 它不属于任何
 * 页面脚本，刷新、新标签页、关掉再开都由浏览器自动带上。所以「还是同一个浏览器」
 * 这件事不需要面板去猜，也不需要把管理密钥存在 localStorage 里：问一次
 * `GET /session`，它认这个浏览器就认。
 *
 * 没有密钥也能进面板，这正是要修的那件事：F5 不是重新登录，是同一个会话继续。
 */
async function resumeBrowserSession(): Promise<boolean> {
  try {
    const session = await sessionApi.describe();
    markSessionEstablished();
    applySessionClock(session);
    return true;
  } catch {
    return false;
  }
}

// 正在进行的登出。登出必须**幂等**：`unauthorized` 监听、空闲守卫、手动按钮都可能
// （几乎同时）调用它，而登出自己发出的 `/session` 一旦 401 又会再触发一次
// `unauthorized` —— 不挡住就会连锁登出。
let logoutPromise: Promise<boolean> | null = null;

export const useAuthStore = create<AuthStoreState>()(
  persist(
    (set, get) => ({
      // 初始状态
      isAuthenticated: false,
      apiBase: '',
      managementKey: '',
      rememberPassword: false,
      serverVersion: null,
      serverBuildDate: null,
      supportsPlugin: false,
      connectionStatus: 'disconnected',

      // 恢复会话并自动登录
      restoreSession: () => {
        if (restoreSessionPromise) return restoreSessionPromise;

        restoreSessionPromise = (async () => {
          obfuscatedStorage.migratePlaintextKeys(['apiBase', 'apiUrl', 'managementKey']);

          const wasLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
          const legacyBase =
            obfuscatedStorage.getItem<string>('apiBase') ||
            obfuscatedStorage.getItem<string>('apiUrl', { encrypt: true });
          const legacyKey = obfuscatedStorage.getItem<string>('managementKey');

          const { apiBase, managementKey, rememberPassword } = get();
          const resolvedBase = normalizeApiBase(
            apiBase || legacyBase || detectApiBaseFromLocation()
          );
          const resolvedKey = managementKey || legacyKey || '';
          const resolvedRememberPassword =
            rememberPassword || Boolean(managementKey) || Boolean(legacyKey);

          set({
            apiBase: resolvedBase,
            managementKey: resolvedKey,
            rememberPassword: resolvedRememberPassword,
          });
          apiClient.setConfig({ apiBase: resolvedBase, managementKey: resolvedKey });

          // 先问浏览器自己：会话 cookie 还在，就说明这台浏览器还签着，连密钥
          // 都不需要（默认就不落盘）。这条放在密钥之前，是因为复用同一个会话能
          // 保住它已解锁的凭据库；先拿密钥重新登录会开一个新会话，等于每次刷新
          // 都把主密码重新要一遍。
          if (resolvedBase && (await resumeBrowserSession())) {
            set({ isAuthenticated: true, connectionStatus: 'connected' });
            return true;
          }

          // 没有可用的会话：有记住的密钥就自动登录一次（登录会开一个新会话，
          // 顺带把 cookie 补上）。
          if (wasLoggedIn && resolvedBase && resolvedKey) {
            try {
              await get().login({
                apiBase: resolvedBase,
                managementKey: resolvedKey,
                rememberPassword: resolvedRememberPassword,
              });
              return true;
            } catch (error) {
              console.warn('Auto login failed:', error);
            }
          }

          return false;
        })();

        return restoreSessionPromise;
      },

      // 登录
      login: async (credentials) => {
        const apiBase = normalizeApiBase(credentials.apiBase);
        const managementKey = credentials.managementKey.trim();
        const rememberPassword = credentials.rememberPassword ?? get().rememberPassword ?? false;

        try {
          set({
            connectionStatus: 'connecting',
            serverVersion: null,
            serverBuildDate: null,
            supportsPlugin: false,
          });
          useConfigStore.getState().clearCache();
          useModelsStore.getState().clearCache();
          useQuotaStore.getState().clearQuotaCache();
          // 出口池属于上一个服务器：留着会让新连接看到别人的出口编号。
          resetEgressPool();

          // 配置 API 客户端
          apiClient.setConfig({
            apiBase,
            managementKey,
          });

          // 测试连接 - 获取配置。只在 v8 路由不存在时诊断旧版后端。
          const revision = apiClient.getConnectionRevision();
          try {
            await useConfigStore.getState().fetchConfig(true);
          } catch (error) {
            if (
              (error as { status?: number })?.status === 404 &&
              revision === apiClient.getConnectionRevision() &&
              (await probeLegacyBackend(apiBase, managementKey)) &&
              revision === apiClient.getConnectionRevision()
            ) {
              throw new LegacyBackendError();
            }
            throw error;
          }

          // 登录成功前先开会话：面板随后的凭据读写都要带着它。新建而非复用，
          // 这样服务端一定下发 cookie（见 establishSession 的 `fresh`）。
          await establishSession(rememberPassword, true);

          // 登录成功
          set({
            isAuthenticated: true,
            apiBase,
            managementKey,
            rememberPassword,
            connectionStatus: 'connected',
          });
          if (rememberPassword) {
            localStorage.setItem('isLoggedIn', 'true');
          } else {
            localStorage.removeItem('isLoggedIn');
          }
        } catch (error: unknown) {
          set({ connectionStatus: 'error' });
          throw error;
        }
      },

      // 登出
      logout: (): Promise<boolean> => {
        restoreSessionPromise = null;
        // 已在登出中：返回同一个 promise，不再发第二条结束请求（见文件头的说明）。
        if (logoutPromise) return logoutPromise;
        // 登出 = 结束会话。凭据授权挂在会话上，会话一结束，这个会话就再也读不到
        // 凭据；别人的会话、以及后端自己的访问都不受影响。
        //
        // 两件事的顺序是关键：
        // - `/session` 需要鉴权，而 `apiClient` 的连接信息一清就会让请求落到相对
        //   路径（缺 `/v8/management` 前缀）而 404。所以这条请求必须在清连接信息
        //   **之前**发出。凭据可以是管理密钥，也可以是登录时下发的会话 cookie ——
        //   后者正是「刷新后没有密钥」的那条路，所以这里只要求有 apiBase。
        // - 但前端的登出**不能**等它落地：后端挂起时操作者会一直停在受保护页面上。
        // 所以：前端状态**同步**清掉（受保护路由立刻把人送回登录页），`apiClient`
        // 的连接信息等请求落地再清（它只影响之后的新请求，且此时已无人再发请求）。
        //
        // 没有 apiBase 时不发这条请求：本来也没有可结束的会话，且会话结束后的
        // 迟到 401 也会走到这里。
        const { apiBase } = get();
        const endRequest = apiBase ? sessionApi.end() : Promise.resolve();
        // 锁定请求发出时的连接世代。期间若有人重新登录（`setConfig` 会 +1），
        // 迟到的收尾就**不能**再清 `apiClient`，否则会把新会话踢掉。
        const revision = apiClient.getConnectionRevision();
        const settleClient = () => {
          if (apiClient.getConnectionRevision() === revision) {
            apiClient.setConfig({ apiBase: '', managementKey: '' });
          }
          logoutPromise = null;
        };
        // 前端会话立刻结束：清 apiBase/managementKey 一并把 `ProtectedRoute` 的
        // 会话恢复挡住（它见到「未登录 + 有密钥」会立刻重新登录）。
        useConfigStore.getState().clearCache();
        useModelsStore.getState().clearCache();
        useQuotaStore.getState().clearQuotaCache();
        // 出口池同理：登出后不该还能看到上一个服务器的出口编号。
        resetEgressPool();
        // 「记住密码」只决定密钥要不要落盘，不决定登出时要不要留着它：登出是
        // 操作者的明确动作，本地不留密钥。想让浏览器下次还认这台机器，勾的是
        // 「记住密码」—— 它同时让服务端下发持久 cookie，登录态由此延续，而不是
        // 靠把密钥留在 localStorage 里。
        set({
          isAuthenticated: false,
          apiBase: '',
          managementKey: '',
          serverVersion: null,
          serverBuildDate: null,
          supportsPlugin: false,
          connectionStatus: 'disconnected',
        });
        localStorage.removeItem('isLoggedIn');
        // The secret gate shares the CPA session's lifetime: logging out (manual
        // or idle-timeout) always returns it to the unasked state, clearing the
        // in-memory passphrase so the next login re-verifies.
        useSecretGateStore.getState().reset();
        // 锁定失败不阻断登出：前端凭据已经清掉了。
        void endRequest.then(settleClient, settleClient);
        // 结果只回答一件事：服务端那边这个会话是不是真的结束了。调用方（「清理
        // 登录信息」）据此说真话——离线时 cookie 还在，不能说成「已退出」。
        logoutPromise = endRequest.then(
          () => true,
          () => false
        );
        return logoutPromise;
      },

      // 检查认证状态
      checkAuth: async () => {
        const { managementKey, apiBase } = get();

        if (!managementKey || !apiBase) {
          return false;
        }

        try {
          // 重新配置客户端
          apiClient.setConfig({ apiBase, managementKey });
          set({ supportsPlugin: false });

          // 验证连接
          await useConfigStore.getState().fetchConfig();

          // 会话可能已被服务端清掉（重启/空闲超时），这里补一次。
          await establishSession(get().rememberPassword);

          set({
            isAuthenticated: true,
            connectionStatus: 'connected',
          });

          return true;
        } catch {
          set({
            isAuthenticated: false,
            connectionStatus: 'error',
            supportsPlugin: false,
          });
          return false;
        }
      },

      // 更新服务器版本
      updateServerVersion: (version, buildDate) => {
        set({
          serverVersion: version || null,
          serverBuildDate: buildDate || null,
        });
      },

      updateServerPluginSupport: (supportsPlugin) => {
        set({ supportsPlugin });
      },

      // 换密钥后当前会话仍带着旧密钥，下一次请求就会 401 被登出；这里把
      // apiClient 与 store 一起换到新密钥（记住密码时 partialize 会一并持久化）。
      updateManagementKey: (managementKey) => {
        apiClient.setConfig({ apiBase: get().apiBase, managementKey });
        set({ managementKey });
      },
    }),
    {
      name: STORAGE_KEY_AUTH,
      storage: createJSONStorage(() => ({
        getItem: (name) => {
          const data = obfuscatedStorage.getItem<AuthStoreState>(name);
          return data ? JSON.stringify(data) : null;
        },
        setItem: (name, value) => {
          obfuscatedStorage.setItem(name, JSON.parse(value));
        },
        removeItem: (name) => {
          obfuscatedStorage.removeItem(name);
        },
      })),
      partialize: (state) => ({
        apiBase: state.apiBase,
        ...(state.rememberPassword ? { managementKey: state.managementKey } : {}),
        rememberPassword: state.rememberPassword,
        serverVersion: state.serverVersion,
        serverBuildDate: state.serverBuildDate,
      }),
    }
  )
);

// 监听全局未授权事件
if (typeof window !== 'undefined') {
  window.addEventListener('unauthorized', () => {
    void useAuthStore.getState().logout();
  });

  window.addEventListener('server-version-update', ((e: CustomEvent) => {
    const detail = e.detail || {};
    useAuthStore.getState().updateServerVersion(detail.version || null, detail.buildDate || null);
  }) as EventListener);

  window.addEventListener('server-plugin-support-update', ((e: CustomEvent) => {
    useAuthStore.getState().updateServerPluginSupport(e.detail?.supportsPlugin === true);
  }) as EventListener);
}
