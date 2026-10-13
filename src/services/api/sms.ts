/**
 * 接码服务 · 手机号类别 API（基座 `/v8/management/supply/phone/*`）。
 *
 * 接码服务是**基座**能力，不是某个插件的能力：手机号这一类的取号、渠道管理、
 * 账本与凭据都住在基座里（`internal/supply/phone`），管理面带在
 * `/v8/management/supply/phone/*`。本模块只调这一组路由。
 *
 * 基座密钥库（`/v8/management/secrets/*`）也不在这里 —— 那是密钥库自身的状态，
 * 见 `./secretStore.ts`。
 *
 * 后续邮箱类别会走 `/v8/management/supply/email/*`，与本模块并列。
 */

import { apiClient } from './client';

/** 基座路由的固定前缀（与 server_management_v8.go 的挂载点一致）。 */
export const SUPPLY_PHONE_BASE = '/supply/phone';

/** 基座 `/supply/phone/status` 的响应（只取本模块用得到的字段）。 */
export interface SmsStatusResponse {
  status: 'ok' | 'unavailable';
  error?: string;
  /** 该类别是否已启用（配置里已开启且凭据可读）。 */
  enabled?: boolean;
  locked?: boolean;
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
  target?: string;
  auth_index?: string;
  price?: number;
  spend?: number;
  outcome?: string;
  state?: string;
  rents?: number;
  first_seen?: number;
  last_used?: number;
}

/** 账密表提交（→ POST /supply/phone/api，空字段=保留旧值）。 */
export interface SmsApiCredentialInput {
  api_user?: string;
  api_pass?: string;
  token?: string;
  endpoint?: string;
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

/** 从 axios 错误里取后端给的原因（用于渠道操作这类非凭据写）。 */
function errorMessage(error: unknown, fallback: string): string {
  const data = (error as { data?: unknown })?.data as { error?: string } | undefined;
  return typeof data?.error === 'string' && data.error ? data.error : fallback;
}

export const smsApi = {
  /** 读取手机号类别状态（会真实联网取余额）。 */
  async getStatus(): Promise<SmsStatusResponse> {
    return apiClient.get<SmsStatusResponse>(`${SUPPLY_PHONE_BASE}/status`);
  },

  /** 写账密凭据（API 登录）。空字段保留旧值。 */
  async saveApiCredential(
    input: SmsApiCredentialInput,
    passphrase: string
  ): Promise<CredentialWriteResult> {
    try {
      await apiClient.post(`${SUPPLY_PHONE_BASE}/api`, withPassphrase(input, passphrase));
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
    input: { username?: string; password?: string },
    passphrase: string
  ): Promise<CredentialWriteResult> {
    try {
      await apiClient.post(
        `${SUPPLY_PHONE_BASE}/web-credential`,
        withPassphrase(input, passphrase)
      );
      return { ok: true };
    } catch (error) {
      return toCredentialWriteResult(error, 'failed to store the web sign-in credential');
    }
  },

  /** 刷新渠道缓存（真实拉取平台渠道）。 */
  async refreshChannels(
    join = false
  ): Promise<{ ok: true; channels: SmsChannelWire[] } | { ok: false; message: string }> {
    try {
      const result = await apiClient.post<{ channels?: SmsChannelWire[] }>(
        `${SUPPLY_PHONE_BASE}/refresh`,
        { join }
      );
      return { ok: true, channels: result?.channels ?? [] };
    } catch (error) {
      return { ok: false, message: errorMessage(error, 'failed to refresh channels') };
    }
  },

  /** 省钱护栏：暂停超上限/无货渠道，恢复可用渠道（真实写平台；需网页会话）。 */
  async runGuardrail(): Promise<
    { ok: true; channels: SmsChannelWire[] } | { ok: false; message: string }
  > {
    try {
      const result = await apiClient.post<{ channels?: SmsChannelWire[] }>(
        `${SUPPLY_PHONE_BASE}/guardrail`,
        {}
      );
      return { ok: true, channels: result?.channels ?? [] };
    } catch (error) {
      return { ok: false, message: errorMessage(error, 'failed to apply the guardrail') };
    }
  },

  /** 暂停/恢复单个渠道（真实写平台；需要网页会话）。 */
  async setChannel(
    uid: string,
    paused: boolean
  ): Promise<{ ok: true; channels: SmsChannelWire[] } | { ok: false; message: string }> {
    try {
      const result = await apiClient.post<{ channels?: SmsChannelWire[] }>(
        `${SUPPLY_PHONE_BASE}/channel`,
        { uid, paused }
      );
      return { ok: true, channels: result?.channels ?? [] };
    } catch (error) {
      return { ok: false, message: errorMessage(error, 'failed to switch the channel') };
    }
  },

  /**
   * 自动登录网页后台换取会话（CK）。
   *
   * 后端自己取验证码、解点选顺序、提交登录，成功后把会话写入密钥库；
   * 登录失败**不会**落库任何东西。空账号/密码字段复用已存值。
   */
  async webLogin(
    input: { username?: string; password?: string },
    passphrase: string
  ): Promise<{ ok: true; channels: number } | { ok: false; message: string }> {
    try {
      const result = await apiClient.post<{ channels?: number }>(
        `${SUPPLY_PHONE_BASE}/web-login`,
        withPassphrase(input, passphrase)
      );
      return { ok: true, channels: typeof result?.channels === 'number' ? result.channels : 0 };
    } catch (error) {
      return { ok: false, message: errorMessage(error, 'failed to sign in to the web surface') };
    }
  },
};
