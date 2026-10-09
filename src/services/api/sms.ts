/**
 * 接码服务 API（L1 平台 / L3 凭据 / L5 运行时）。
 *
 * 两条链路，不要混：
 * - **基座密钥库**（`/v8/management/secrets/*`）：验/解锁/锁定主密码，编解码宿主加密库；
 * - **插件接码路由**（`/v0/management/plugins/loomy/sms/*`）：写凭据、取状态。
 *
 * ⚠️ 插件路由不在 `/v8/management` 前缀下，`apiClient` 的 baseURL 固定为
 * `/v8/management`，所以这里必须用 `resolvePluginAssetURL` 拼**绝对 URL** 再请求，
 * 由 axios 的 `baseURL` 置空（传绝对 URL 时 axios 会忽略 baseURL）。
 */

import { apiClient } from './client';
import { resolvePluginAssetURL } from '@/features/plugins/pluginResources';
import { normalizeApiBase } from '@/utils/connection';

/** 插件接码路由的固定前缀（与 plugins/loomy/management.go 的 Path 声明一致）。 */
export const SMS_PLUGIN_BASE = '/v0/management/plugins/loomy/sms';

/** 密钥库状态（GET /v8/management/secrets）。 */
export interface SecretStoreStatus {
  enabled: boolean;
  initialized: boolean;
  unlocked: boolean;
  /** 是否已安装主密码。 */
  passphrase: boolean;
  mode: string;
  names: string[];
}

/** 插件 `/sms/status` 的响应（只取本模块用得到的字段）。 */
export interface SmsStatusResponse {
  status: 'ok' | 'unavailable';
  error?: string;
  locked?: boolean;
  missing?: boolean;
  store_enabled?: boolean;
  store_available?: boolean;
  passphrase_set?: boolean;
  credentials?: string[];
  /** 账密 secret 是否已存在（默认 "haozhuma"）。 */
  api_present?: boolean;
  /** CK（网页会话）secret 是否已存在（默认 "haozhuma-ck"）。 */
  cookie_present?: boolean;
  project?: string;
  provider?: string;
  budget?: { max_total_cny?: number; max_per_number_cny?: number };
  /** 真实联网得到的余额；有值 = 凭据有效。 */
  balance_cny?: number;
  /** 真实联网失败的原因。 */
  balance_error?: string;
  channels?: unknown[];
  ledger?: unknown[];
  spent_cny?: number;
}

/** 账密表提交（→ POST /sms/api，空字段=保留旧值）。 */
export interface SmsApiCredentialInput {
  api_user?: string;
  api_pass?: string;
  token?: string;
  endpoint?: string;
}

/** 拼出插件路由的绝对 URL。 */
export function smsPluginURL(path: string, apiBase: string): string {
  return resolvePluginAssetURL(`${SMS_PLUGIN_BASE}${path}`, apiBase);
}

/** 一个写凭据接口的结果：`ok` 或带原因的错误。 */
export type CredentialWriteResult =
  { ok: true } | { ok: false; reason: 'wrong-passphrase' | 'locked' | 'error'; message: string };

/** 把 axios 错误归一成凭据写入结果（区分主密码错 / 库锁 / 其它）。 */
function toCredentialWriteResult(error: unknown, fallback: string): CredentialWriteResult {
  const data = (error as { data?: unknown })?.data as
    { error?: string; passphrase_wrong?: boolean } | undefined;
  const message = typeof data?.error === 'string' && data.error ? data.error : fallback;
  if (data?.passphrase_wrong) return { ok: false, reason: 'wrong-passphrase', message };
  const status = (error as { status?: number })?.status;
  if (status === 409) return { ok: false, reason: 'locked', message };
  return { ok: false, reason: 'error', message };
}

/** Body 里随写带的 passphrase：后端在密钥库需要时才校验（库已解锁且无口令可不传）。 */
function withPassphrase<T extends object>(
  body: T,
  passphrase: string
): T & { passphrase?: string } {
  const trimmed = passphrase.trim();
  return trimmed ? { ...body, passphrase: trimmed } : body;
}

export const smsApi = {
  /** 读取基座密钥库状态。 */
  async getSecretStatus(): Promise<SecretStoreStatus> {
    return apiClient.get<SecretStoreStatus>('/secrets');
  },

  /** 校验主密码（不改变解锁状态；成功不等于已解锁）。 */
  async verifyPassphrase(passphrase: string): Promise<boolean> {
    const result = await apiClient.post<{ verified?: boolean }>('/secrets/verify', { passphrase });
    return result?.verified === true;
  },

  /** 用主密码解锁密钥库。成功后库内密文可读，直到被 Lock。 */
  async unlockStore(passphrase: string): Promise<SecretStoreStatus> {
    return apiClient.post<SecretStoreStatus>('/secrets/unlock', { passphrase });
  },

  /** 锁定密钥库（丢弃内存中的 key）。 */
  async lockStore(): Promise<SecretStoreStatus> {
    return apiClient.post<SecretStoreStatus>('/secrets/lock', {});
  },

  /** 读取插件接码状态（会真实联网取余额）。 */
  async getStatus(apiBase: string): Promise<SmsStatusResponse> {
    return apiClient.get<SmsStatusResponse>(smsPluginURL('/status', apiBase), {
      baseURL: '',
    });
  },

  /** 写账密凭据。空字段保留旧值。 */
  async saveApiCredential(
    apiBase: string,
    input: SmsApiCredentialInput,
    passphrase: string
  ): Promise<CredentialWriteResult> {
    try {
      await apiClient.post(smsPluginURL('/api', apiBase), withPassphrase(input, passphrase), {
        baseURL: '',
      });
      return { ok: true };
    } catch (error) {
      return toCredentialWriteResult(error, 'failed to store the account credential');
    }
  },

  /** 写 CK（网页会话 Cookie）。空 cookie = 清除。 */
  async saveCookie(
    apiBase: string,
    cookie: string,
    passphrase: string
  ): Promise<CredentialWriteResult> {
    try {
      await apiClient.post(
        smsPluginURL('/cookie', apiBase),
        withPassphrase({ cookie: cookie.trim() }, passphrase),
        { baseURL: '' }
      );
      return { ok: true };
    } catch (error) {
      return toCredentialWriteResult(error, 'failed to store the session cookie');
    }
  },
};

/** 供 UI 用：`computeApiUrl` 之外的绝对基址规范化（与 apiClient 同源）。 */
export { normalizeApiBase };
