/**
 * 接码服务 · 邮箱类别 API（基座 `/v8/management/supply/email/*`）。
 *
 * 与 `sms.ts` 并列：手机号那一类走 `/supply/phone/*`，邮箱这一类走
 * `/supply/email/*`。两边共用基座的渠道清单（`./supply.ts`），因为一条渠道
 * 可以同时服务两类身份。
 *
 * 邮箱只收信、不发信。这里读到的就是收件箱里真实存在的邮件；没有任何一封时
 * 返回空数组，读不到时报错 —— 「没读到」与「没有信」是两件事，不能混。
 */

import { apiClient } from './client';

/** 基座路由的固定前缀（与 server_management_v8.go 的挂载点一致）。 */
export const SUPPLY_EMAIL_BASE = '/supply/email';

/** 一条已配置的收信邮箱（基座 `/supply/email/status` 的一行）。 */
export interface EmailMailboxWire {
  channel_id?: string;
  label?: string;
  /** 登录这个邮箱的账号。 */
  mailbox?: string;
  /** 收信服务器（host 或 host:port）。 */
  host?: string;
  /** 自建域：catch-all 落在哪个域。 */
  domain?: string;
  /** `personal` / `self-domain`。 */
  usage?: string;
  /** 凭据在密钥库里的条目名（**不是值**）。 */
  secret_name?: string;
  /** 该条目是否已存好授权码。 */
  has_credential?: boolean;
}

export interface EmailStatusResponse {
  status?: string;
  /** 是否已配置至少一个可读的邮箱。 */
  enabled?: boolean;
  /** 密钥库锁定 ⇒ 授权码读不到。不等于「没配过」。 */
  locked?: boolean;
  channels?: EmailMailboxWire[];
}

/** 收件箱里的一封邮件。 */
export interface EmailMessageWire {
  /** 它来自哪条渠道的信箱。 */
  channel_id?: string;
  /** 它来自哪个文件夹（INBOX / 垃圾邮件）。 */
  mailbox?: string;
  from?: string;
  to?: string[];
  subject?: string;
  /** RFC3339；空串 = 后端没拿到日期。 */
  received_at?: string;
  /** 提取出的验证码；空串 = 这封信没有码。 */
  code?: string;
  /** 正文摘录。 */
  preview?: string;
}

/** 一条渠道的信箱这次读到了什么（基座 `/supply/email/inbox` 的 `mailboxes` 一行）。 */
export interface EmailMailboxInboxWire {
  channel_id?: string;
  label?: string;
  mailbox?: string;
  domain?: string;
  /** 这次窗口里寄给所查地址的信有几封。 */
  count?: number;
  /** 最新的一封；没有信时缺省。 */
  latest?: EmailMessageWire;
  /** 这个信箱读不到的原因；空串 = 读到了。 */
  error?: string;
}

export interface EmailInboxResponse {
  status?: string;
  enabled?: boolean;
  /** 本次按哪个地址过滤；空串 = 整个邮箱。 */
  address?: string;
  /** 这次往前看了多少小时 —— 「最近 N 封」里的 N 以它为准。 */
  window_hours?: number;
  messages?: EmailMessageWire[];
  /** 每条渠道各自的收信情况。 */
  mailboxes?: EmailMailboxInboxWire[];
  error?: string;
  /** `email_unavailable` = 一个可读的邮箱都没有配。 */
  code?: string;
}

/** 写授权码的结果。 */
export type EmailCredentialWriteResult =
  | { ok: true }
  | { ok: false; reason: 'wrong-passphrase' | 'locked' | 'error'; message: string };

/** 批量导入里一个邮箱的结局（基座 `/supply/email/import` 的 `results[]` 一行）。 */
export interface EmailImportLineWire {
  /** 它在粘贴文本里的行号。 */
  line?: number;
  account?: string;
  /** `imported` / `updated` / `failed`；未知值按失败显示。 */
  outcome?: string;
  /** 失败原因；成功时缺省。 */
  detail?: string;
}

/** 批量导入的结果：一批里每个邮箱各一条，另有三个计数。 */
export type EmailImportResult =
  | {
      ok: true;
      imported: number;
      updated: number;
      failed: number;
      results: EmailImportLineWire[];
    }
  | { ok: false; reason: 'wrong-passphrase' | 'locked' | 'error'; message: string };

/** 基座 `/supply/email/probe` 的一行：一个地址现在打不打得开。 */
export interface EmailAddressProbeWire {
  address?: string;
  /** `online` / `offline` / `unready`；未知值按「没测成」处理。 */
  state?: string;
  /** 一句说明；成功时是连上了几个文件夹，失败时是原因。 */
  detail?: string;
}

/** 基座 `/supply/email/import` 的原始回包。 */
export interface EmailImportResponse {
  status?: string;
  imported?: number;
  updated?: number;
  failed?: number;
  results?: EmailImportLineWire[];
}

/**
 * 授权导入里一个邮箱的进展（基座 `/supply/email/authorize` 的 `flows[]` 一行）。
 *
 * 只有正在等登录的那一个带 `user_code` / `verify_url` / `expires_in`；其余行只是状态。
 */
export interface EmailAuthorizeFlowWire {
  id?: string;
  account?: string;
  /**
   * `waiting` 等登录 / `verifying` 核对账号 / `saving` 保存凭据 /
   * `awaiting_unlock` 登录已完成、只差保存 / `done` 已保存 /
   * `denied` 被拒 / `expired` 码过期 /
   * `failed` 失败 / `cancelled` 已停止。未知值按「没完成」显示。
   */
  status?: string;
  /** 凭据实际存到的地址（微软报的主地址）；填的是别名时与 account 不同。 */
  stored_as?: string;
  /** 一句说明；状态本身够清楚时缺省。 */
  detail?: string;
  /** 8 位设备码。 */
  user_code?: string;
  /** 输入这个码的页面。 */
  verify_url?: string;
  /** 这个码还剩多少秒可用。 */
  expires_in?: number;
  /** 基座两次轮询之间至少隔多少秒。 */
  interval?: number;
}

/** 授权导入的一次调用结果：一批进展，或者一个说得清的原因。 */
export type EmailAuthorizeResult =
  | { ok: true; flows: EmailAuthorizeFlowWire[] }
  | { ok: false; reason: 'wrong-passphrase' | 'locked' | 'busy' | 'error'; message: string };

/** 把 axios 错误归一成授权码写入结果（区分主密码错 / 库锁 / 其它）。 */
function toCredentialWriteResult(error: unknown, fallback: string): EmailCredentialWriteResult {
  const data = (error as { data?: unknown })?.data as
    | { error?: string; passphrase_wrong?: boolean }
    | undefined;
  const message = typeof data?.error === 'string' && data.error ? data.error : fallback;
  if (data?.passphrase_wrong) return { ok: false, reason: 'wrong-passphrase', message };
  const status = (error as { status?: number })?.status;
  if (status === 409) return { ok: false, reason: 'locked', message };
  return { ok: false, reason: 'error', message };
}

/** 从 axios 错误里取后端给的原因。 */
function errorMessage(error: unknown, fallback: string): string {
  const data = (error as { data?: unknown })?.data as { error?: string } | undefined;
  return typeof data?.error === 'string' && data.error ? data.error : fallback;
}

/**
 * 把授权导入的错误归一成结果。
 *
 * 三种要分开的答案：主密码错、库锁着、已经有一批在等 —— 前两个要口令，第三个不要，
 * 面板对它们的反应完全不同。
 */
function toAuthorizeResult(error: unknown, fallback: string): EmailAuthorizeResult {
  const data = (error as { data?: unknown })?.data as
    | { error?: string; passphrase_wrong?: boolean; busy?: boolean }
    | undefined;
  const message = typeof data?.error === 'string' && data.error ? data.error : fallback;
  if (data?.passphrase_wrong) return { ok: false, reason: 'wrong-passphrase', message };
  if (data?.busy) return { ok: false, reason: 'busy', message };
  if ((error as { status?: number })?.status === 409) return { ok: false, reason: 'locked', message };
  return { ok: false, reason: 'error', message };
}

/** 后端给的原因码（`email_unavailable` = 一个可读的邮箱都没有）。 */
function errorCode(error: unknown): string {
  const data = (error as { data?: unknown })?.data as { code?: string } | undefined;
  return typeof data?.code === 'string' ? data.code : '';
}

export const emailApi = {
  /** 读取已配置的收信邮箱。只读，不需要主密码。 */
  async getStatus(): Promise<EmailStatusResponse> {
    return apiClient.get<EmailStatusResponse>(`${SUPPLY_EMAIL_BASE}/status`);
  },

  /**
   * 读收件箱。
   *
   * `address` 为空 = 整个邮箱最近的信（进页面时看的就是这个）；给了地址就只看
   * 寄给它的信 —— 一个邮箱可以承接很多地址，按地址过滤是常态而不是特例。
   *
   * `scope` 决定读哪一类身份：`pool` 读供应池里的邮箱身份（一次调用拿全部，
   * 不用逐个地址去问），省略或 `channel` 读渠道（现有调用方走的就是这条）。
   * 给了 `address` 时基座忽略 `scope` —— 地址比范围更具体。
   */
  async getInbox(options?: {
    address?: string;
    limit?: number;
    scope?: 'pool' | 'channel';
  }): Promise<EmailInboxResponse> {
    const params = new URLSearchParams();
    if (options?.scope) params.set('scope', options.scope);
    if (options?.address) params.set('address', options.address);
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString();
    return apiClient.get<EmailInboxResponse>(`${SUPPLY_EMAIL_BASE}/inbox${qs ? `?${qs}` : ''}`);
  },

  /**
   * 问「能收这个地址的信箱现在打得开吗」。
   *
   * 自带凭据的地址没有渠道可问，只能连它自己的信箱 —— 这是唯一能回答「现在能不能用」
   * 的办法。只读：只登录、只列文件夹，不读任何一封信，也不回传凭据。
   *
   * 一次问一批：一个地址一次连接，基座会排队（不是硬拒），所以别把整池几千个地址
   * 一次性塞进来 —— 传进来的是**这一屏要显示的那些**。
   */
  async probeAddresses(addresses: string[]): Promise<EmailAddressProbeWire[]> {
    const wanted = addresses.map((address) => address.trim()).filter((address) => address !== '');
    if (wanted.length === 0) return [];
    const response = await apiClient.post<{ probes?: EmailAddressProbeWire[] }>(
      `${SUPPLY_EMAIL_BASE}/probe`,
      { addresses: wanted },
      { timeout: 60_000 }
    );
    return Array.isArray(response?.probes) ? response.probes : [];
  },

  /**
   * 存一个邮箱的凭据：授权码，或者 OAuth2 的刷新令牌。
   *
   * 值直接进密钥库，接口不回显、本模块也不缓存它。条目名由**邮箱账号 + 接入方式**
   * 决定（基座按两者派生），所以这里不必、也不该让使用者起名 —— 两种凭据也不该共用
   * 一个条目：把刷新令牌交给口令登录，只会得到一句「密码错误」。
   */
  async saveCredential(
    input: {
      account: string;
      name?: string;
      secret: string;
      nature?: 'imap' | 'oauth2' | 'graph';
    }
  ): Promise<EmailCredentialWriteResult> {
    try {
      // 空的名字不发：基座按账号派生，空串只是把「没有名字」传了一遍。
      const { name, ...rest } = input;
      const body = name?.trim() ? { ...rest, name: name.trim() } : rest;
      await apiClient.post(`${SUPPLY_EMAIL_BASE}/credential`, body);
      return { ok: true };
    } catch (error) {
      return toCredentialWriteResult(error, 'failed to store the mailbox credential');
    }
  },

  /**
   * 批量导入邮箱。
   *
   * 一行一个。微软账号的两条路是 `账号----密码----应用 ID----刷新令牌`；自有邮箱
   * （`nature: 'imap'`）是 `账号----密码`，需要时再加第三段 `host:port` 覆盖请求体里的
   * 服务器 —— 一个邮箱一个密码，没有令牌可交换。
   *
   * 基座解析整批、验证每个邮箱能否收信，再把凭据写进密钥库、为每个邮箱建一条渠道。
   * 所以这里只发文本，不发逐条凭据 —— 值不经过面板，也不回到面板。
   *
   * `nature` 是这批邮箱的收信方式：`oauth2` 走邮箱服务器的授权码，`graph` 走微软的
   * 邮件接口，`imap` 用邮箱自己的密码。同一份凭据通常只带一种权限，所以这是使用者要
   * 回答的问题，不是基座能猜的。
   *
   * `host` 只对 `imap` 有意义：两段行没有服务器地址，只能由请求体给。
   *
   * 超时单独放宽：一批里每个邮箱都要做一次令牌交换和一次登录，默认的 30 秒只够几个。
   * 调用方按批分片（见 `ImportMailboxesModal`），这里给每片留足时间。
   */
  async importMailboxes(input: {
    text: string;
    probe?: boolean;
    nature?: 'imap' | 'oauth2' | 'graph';
    /** IMAP 服务器（`host:port`）；空串不发，避免把「没填」当成一个值传下去。 */
    host?: string;
  }): Promise<EmailImportResult> {
    try {
      const { host, ...rest } = input;
      const body = host?.trim() ? { ...rest, host: host.trim() } : rest;
      const response = await apiClient.post<EmailImportResponse>(
        `${SUPPLY_EMAIL_BASE}/import`,
        body,
        { timeout: 180_000 }
      );
      return {
        ok: true,
        imported: typeof response?.imported === 'number' ? response.imported : 0,
        updated: typeof response?.updated === 'number' ? response.updated : 0,
        failed: typeof response?.failed === 'number' ? response.failed : 0,
        results: Array.isArray(response?.results) ? response.results : [],
      };
    } catch (error) {
      const data = (error as { data?: unknown })?.data as
        | { error?: string; passphrase_wrong?: boolean }
        | undefined;
      const message =
        typeof data?.error === 'string' && data.error
          ? data.error
          : 'failed to import the mailboxes';
      if (data?.passphrase_wrong) return { ok: false, reason: 'wrong-passphrase', message };
      if ((error as { status?: number })?.status === 409) {
        return { ok: false, reason: 'locked', message };
      }
      return { ok: false, reason: 'error', message };
    }
  },

  /**
   * 开始一批授权导入：只发账号，不发凭据。
   *
   * 基座为第一个账号申请一个 8 位码就回包，登录在后台等 —— 一次登录最长十几分钟，
   * 不能把请求挂着。之后用 {@link getAuthorization} 读进展。
   *
   * `passphrase` 可以留空：会话已经解锁时基座直接放行，整批只认这一次口令。
   */
  async startAuthorization(input: { accounts: string }): Promise<EmailAuthorizeResult> {
    try {
      const response = await apiClient.post<{ flows?: EmailAuthorizeFlowWire[] }>(
        `${SUPPLY_EMAIL_BASE}/authorize`,
        input,
        { timeout: 60_000 }
      );
      return { ok: true, flows: Array.isArray(response?.flows) ? response.flows : [] };
    } catch (error) {
      return toAuthorizeResult(error, 'failed to start the sign-in');
    }
  },

  /**
   * 读正在进行的授权导入。
   *
   * 也用来在页面重新打开后接上还没走完的那一批：登录是人工的，一次可能要等十几
   * 分钟，中途刷新页面不该让那批丢掉。
   */
  async getAuthorization(): Promise<EmailAuthorizeFlowWire[]> {
    const response = await apiClient.get<{ flows?: EmailAuthorizeFlowWire[] }>(
      `${SUPPLY_EMAIL_BASE}/authorize`
    );
    return Array.isArray(response?.flows) ? response.flows : [];
  },

  /** 停止这一批。已经存好的那些不受影响。 */
  async cancelAuthorization(id: string): Promise<EmailAuthorizeFlowWire[]> {
    const response = await apiClient.post<{ flows?: EmailAuthorizeFlowWire[] }>(
      `${SUPPLY_EMAIL_BASE}/authorize/${encodeURIComponent(id)}/cancel`,
      {}
    );
    return Array.isArray(response?.flows) ? response.flows : [];
  },

  /**
   * 登录已经完成、但当时库锁着的那一个：补上口令把凭据存下去。
   *
   * 不用重新登录微软 —— 凭据已经在基座手里，缺的只是写库的授权。
   */
  async commitAuthorization(id: string, passphrase: string): Promise<EmailAuthorizeResult> {
    try {
      const response = await apiClient.post<{ flows?: EmailAuthorizeFlowWire[] }>(
        `${SUPPLY_EMAIL_BASE}/authorize/${encodeURIComponent(id)}/commit`,
        { passphrase }
      );
      return { ok: true, flows: Array.isArray(response?.flows) ? response.flows : [] };
    } catch (error) {
      return toAuthorizeResult(error, 'failed to store the mailbox credential');
    }
  },

  /** 从错误对象里取原因，供收件箱把失败说清楚。 */
  describeError(error: unknown, fallback: string): string {
    return errorMessage(error, fallback);
  },
  /**
   * 这次失败是否只是「还没有可读的邮箱」。
   *
   * 页面在读取前已经问过状态，所以这只会在中途失去邮箱时出现（宿主重启、渠道
   * 被停用）。它不是错误，是空态 —— 后端的英文原因句不该出现在这里。
   */
  isUnavailable(error: unknown): boolean {
    return errorCode(error) === 'email_unavailable';
  },
};
