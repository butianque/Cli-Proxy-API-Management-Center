/**
 * 接码服务插件 API（L1 平台 / L3 凭据 / L5 运行时）。
 *
 * 基座密钥库（`/v8/management/secrets/*`）不在这里 —— 那是基座能力，见
 * `./secretStore.ts`。本模块只管**插件接码路由**
 * （`/v0/management/plugins/loomy/sms/*`）：写凭据、取状态。
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

/** 插件 `/sms/status` 的响应（只取本模块用得到的字段）。 */
export interface SmsStatusResponse {
  status: 'ok' | 'unavailable';
  error?: string;
  /** 插件是否已启用（`sms_provider` 已配置）。 */
  enabled?: boolean;
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
  /** 网页登录账号（linhua888）是否已随账密 secret 存好。 */
  web_present?: boolean;
  /** 已存 API 账号的脱敏提示（如 `e3••••f8`），仅解锁态返回。 */
  api_user_hint?: string;
  /** 已存网页账号的脱敏提示（如 `li••••88`），仅解锁态返回。 */
  web_user_hint?: string;
  project?: string;
  provider?: string;
  budget?: { max_total_cny?: number; max_per_number_cny?: number };
  /** 真实联网得到的余额；有值 = 凭据有效。 */
  balance_cny?: number;
  /** 真实联网失败的原因。 */
  balance_error?: string;
  channels?: SmsChannelWire[];
  ledger?: SmsLedgerWire[];
  spent_cny?: number;
  /** 渠道缓存写入时间（Unix 秒）。 */
  channels_updated_at?: number;
}

/** 后端返回的渠道行（uid / price / stock / paused）。 */
export interface SmsChannelWire {
  uid: string;
  name: string;
  price: number;
  stock: number;
  paused?: boolean;
  carriers?: string;
  paragraphs?: string;
  contact?: string;
}

/** 后端返回的账本行。 */
export interface SmsLedgerWire {
  phone: string;
  sid?: string;
  code?: string;
  account?: string;
  rents?: number;
  first_seen?: number;
  last_used?: number;
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
  /** 读取插件接码状态（会真实联网取余额）。 */
  async getStatus(apiBase: string): Promise<SmsStatusResponse> {
    return apiClient.get<SmsStatusResponse>(smsPluginURL('/status', apiBase), {
      baseURL: '',
    });
  },

  /** 写账密凭据（API 登录）。空字段保留旧值。 */
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

  /**
   * 写网页登录账号（网页登录）。空字段保留旧值。
   *
   * 只想记下账号、稍后再点「获取网页会话」时用；真正落库复用 `/web-login` 的
   * 存值路径（同一对字段），避免两条写路径各写各的。
   */
  async saveWebCredential(
    apiBase: string,
    input: { username?: string; password?: string },
    passphrase: string
  ): Promise<CredentialWriteResult> {
    try {
      await apiClient.post(
        smsPluginURL('/web-credential', apiBase),
        withPassphrase(input, passphrase),
        {
          baseURL: '',
        }
      );
      return { ok: true };
    } catch (error) {
      return toCredentialWriteResult(error, 'failed to store the web sign-in credential');
    }
  },

  /** 刷新渠道缓存（真实拉取平台渠道）。 */
  async refreshChannels(
    apiBase: string,
    join = false
  ): Promise<{ ok: true; channels: SmsChannelWire[] } | { ok: false; message: string }> {
    try {
      const result = await apiClient.post<{ channels?: SmsChannelWire[] }>(
        smsPluginURL('/refresh', apiBase),
        { join },
        { baseURL: '' }
      );
      return { ok: true, channels: result?.channels ?? [] };
    } catch (error) {
      const data = (error as { data?: unknown })?.data as { error?: string } | undefined;
      return { ok: false, message: data?.error ?? 'failed to refresh channels' };
    }
  },

  /** 省钱护栏：暂停超上限/无货渠道，恢复可用渠道（真实写平台；需网页会话）。 */
  async runGuardrail(
    apiBase: string
  ): Promise<{ ok: true; channels: SmsChannelWire[] } | { ok: false; message: string }> {
    try {
      const result = await apiClient.post<{ channels?: SmsChannelWire[] }>(
        smsPluginURL('/guardrail', apiBase),
        {},
        { baseURL: '' }
      );
      return { ok: true, channels: result?.channels ?? [] };
    } catch (error) {
      const data = (error as { data?: unknown })?.data as { error?: string } | undefined;
      return { ok: false, message: data?.error ?? 'failed to apply the guardrail' };
    }
  },

  /** 暂停/恢复单个渠道（真实写平台；需要网页会话）。 */
  async setChannel(
    apiBase: string,
    uid: string,
    paused: boolean
  ): Promise<{ ok: true; channels: SmsChannelWire[] } | { ok: false; message: string }> {
    try {
      const result = await apiClient.post<{ channels?: SmsChannelWire[] }>(
        smsPluginURL('/channel', apiBase),
        { uid, paused },
        { baseURL: '' }
      );
      return { ok: true, channels: result?.channels ?? [] };
    } catch (error) {
      const data = (error as { data?: unknown })?.data as { error?: string } | undefined;
      return { ok: false, message: data?.error ?? 'failed to switch the channel' };
    }
  },

  /**
   * 自动登录网页后台换取会话（CK）。
   *
   * 后端自己取验证码、解点选顺序、提交登录，成功后把会话写入密钥库；
   * 登录失败**不会**落库任何东西。空账号/密码字段复用已存值。
   */
  async webLogin(
    apiBase: string,
    input: { username?: string; password?: string },
    passphrase: string
  ): Promise<{ ok: true; channels: number } | { ok: false; message: string }> {
    try {
      const result = await apiClient.post<{ channels?: number }>(
        smsPluginURL('/web-login', apiBase),
        withPassphrase(input, passphrase),
        { baseURL: '' }
      );
      return { ok: true, channels: typeof result?.channels === 'number' ? result.channels : 0 };
    } catch (error) {
      const data = (error as { data?: unknown })?.data as { error?: string } | undefined;
      const message =
        typeof data?.error === 'string' && data.error
          ? data.error
          : 'failed to sign in to the web surface';
      return { ok: false, message };
    }
  },
};

/** 供 UI 用：`computeApiUrl` 之外的绝对基址规范化（与 apiClient 同源）。 */
export { normalizeApiBase };
