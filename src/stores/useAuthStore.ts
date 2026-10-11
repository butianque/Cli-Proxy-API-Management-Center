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
import { secretStoreApi } from '@/services/api/secretStore';
import { LegacyBackendError, probeLegacyBackend } from '@/services/api/legacyBackendProbe';
import { useConfigStore } from './useConfigStore';
import { useModelsStore } from './useModelsStore';
import { useQuotaStore } from './useQuotaStore';
import { useSecretGateStore } from './useSecretGateStore';
import { detectApiBaseFromLocation, normalizeApiBase } from '@/utils/connection';

interface AuthStoreState extends AuthState {
  connectionStatus: ConnectionStatus;

  // 操作
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<boolean>;
  restoreSession: () => Promise<boolean>;
  updateServerVersion: (version: string | null, buildDate?: string | null) => void;
  updateServerPluginSupport: (supportsPlugin: boolean) => void;
  /** 更换管理密钥成功后，同步内存中的密钥，让当前会话继续可用。 */
  updateManagementKey: (managementKey: string) => void;
}

let restoreSessionPromise: Promise<boolean> | null = null;

// 正在进行的登出。登出必须**幂等**：`unauthorized` 监听、空闲守卫、手动按钮都可能
// （几乎同时）调用它，而登出自己发出的 `/secrets/lock` 一旦 401 又会再触发一次
// `unauthorized` —— 不挡住就会连锁登出（实测一次登出发出 3 条锁定请求）。
let logoutPromise: Promise<void> | null = null;

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
              return false;
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
      logout: (): Promise<void> => {
        restoreSessionPromise = null;
        // 已在登出中：返回同一个 promise，不再发第二条锁定请求（见文件头的说明）。
        if (logoutPromise) return logoutPromise;
        // 登出 = 清除会话，所以密钥库必须对新会话锁死；否则「已验证」只清了前端，
        // 后端还开着，任何人都能靠「登出再登录」直接看到凭据。
        //
        // 两件事的顺序是关键：
        // - `/secrets/lock` 需要鉴权（实测无密钥 → 401 `missing management key`），
        //   而 `apiClient` 的连接信息一清就会让请求落到相对路径（缺 `/v8/management`
        //   前缀）而 404。所以这条请求必须**带着当前会话的密钥发出**。
        // - 但前端的登出**不能**等它落地：后端挂起时操作者会一直停在受保护页面上。
        // 所以：前端状态**同步**清掉（受保护路由立刻把人送回登录页），`apiClient`
        // 的连接信息等请求落地再清（它只影响之后的新请求，且此时已无人再发请求）。
        //
        // 已经没有会话凭据时不发这条请求：本来也没有可锁的库，且会话结束后的迟到
        // 401 也会走到这里。
        const { apiBase, managementKey } = get();
        const lockRequest =
          apiBase && managementKey ? secretStoreApi.lock() : Promise.resolve();
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
        void lockRequest.then(settleClient, settleClient);
        logoutPromise = lockRequest.then(
          () => undefined,
          () => undefined
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
