/**
 * 接码服务 · 来源（渠道）与池的 API（基座 `/v8/management/supply/*`）。
 *
 * 一条来源可以同时服务手机号和邮箱。每个种类有自己的一组连接方式（natures）
 * 和每种方式各自的连接信息。凭据的值永不经由此处。
 */

import { apiClient } from './client';

export const SUPPLY_CHANNELS_BASE = '/supply/channels';
export const SUPPLY_POOL_BASE = '/supply/pool';

export type SupplyKindWire = 'phone' | 'email';
export type SupplyNatureWire = 'api' | 'imap' | 'oauth2' | 'graph' | 'web';

/** 一条连接方式的连接信息（后端 Connection）。 */
export interface SupplyConnectionWire {
  endpoint?: string;
  account?: string;
  secret?: string;
  secret_present?: boolean;
  /**
   * 后端回读的用途。它由渠道类别推导，**不是**输入 —— 提交体里没有这一项，
   * 面板也不再展示它：问两遍就会答两遍，两个答案不一样时没人说得清该听谁的。
   */
  usage?: string;
  domain?: string;
  /** OAuth2 的应用 ID；别的接入方式没有这一项。 */
  client_id?: string;
}

/** 一个种类块（后端 KindConfig）。 */
export interface SupplyKindConfigWire {
  enabled: boolean;
  natures: SupplyNatureWire[];
  connections: Record<SupplyNatureWire, SupplyConnectionWire>;
}

/** 后端返回的一条来源。 */
export interface SupplyChannelWire {
  id: string;
  label: string;
  category?: string;
  phone?: SupplyKindConfigWire;
  email?: SupplyKindConfigWire;
  created?: number;
  updated?: number;
}

/** 后端声明的「哪种性质能服务哪种身份」。 */
export interface SupplyNatureWireInfo {
  nature: SupplyNatureWire;
  kinds: SupplyKindWire[];
}

export interface SupplyChannelsResponse {
  status: string;
  channels?: SupplyChannelWire[];
  natures?: SupplyNatureWireInfo[];
}

/** 一条连接方式的提交体。 */
export interface SupplyConnectionInput {
  endpoint?: string;
  account?: string;
  secret?: string;
  domain?: string;
  client_id?: string;
}

/** 一个种类块的提交体。 */
export interface SupplyKindConfigInput {
  enabled: boolean;
  natures: SupplyNatureWire[];
  connections: Record<string, SupplyConnectionInput>;
}

/** 一条来源的提交体。 */
export interface SupplyChannelInput {
  id?: string;
  label: string;
  category?: string;
  phone?: SupplyKindConfigInput;
  email?: SupplyKindConfigInput;
}

/** 一条渠道某一种连接方式的探活结果（基座 `POST /supply/channels/probe` 的一行）。 */
export interface SupplyProbeNatureWire {
  /** `online` / `offline` / `unready` / `unsupported`；未知值一律不猜。 */
  state?: string;
  /** 一句人类可读的补充（例如余额）；**不含任何凭据值**。 */
  detail?: string;
}

/** 一条渠道的探活结果。 */
export interface SupplyProbeWire {
  id?: string;
  natures?: Record<string, SupplyProbeNatureWire>;
}

export interface SupplyProbeResponse {
  status?: string;
  probes?: SupplyProbeWire[];
}

/** 池里一次注册（`projects[]` 的一项）。 */
export interface SupplyLedgerProjectWire {
  target?: string;
  account?: string;
  outcome?: string;
  at?: number;
}

/** 池里的一条身份（基座 `/supply/pool` 的一行）。 */
export interface SupplyLedgerWire {
  kind: SupplyKindWire;
  address: string;
  /** 这个身份是哪条渠道发出来的；老记录可能没有。 */
  channel_id?: string;
  source?: string;
  target?: string;
  account?: string;
  state?: string;
  outcome?: string;
  price?: number;
  rents?: number;
  first_seen?: number;
  last_used?: number;
  /** 这个身份注册过的平台，一次注册一条。 */
  projects?: SupplyLedgerProjectWire[];
}

function errorMessage(error: unknown, fallback: string): string {
  const data = (error as { data?: unknown })?.data as { error?: string } | undefined;
  return typeof data?.error === 'string' && data.error ? data.error : fallback;
}

export const supplyApi = {
  async listChannels(kind?: SupplyKindWire): Promise<SupplyChannelsResponse> {
    const qs = kind ? `?kind=${kind}` : '';
    return apiClient.get<SupplyChannelsResponse>(`${SUPPLY_CHANNELS_BASE}${qs}`);
  },

  async saveChannel(
    input: SupplyChannelInput
  ): Promise<{ ok: true; channel: SupplyChannelWire } | { ok: false; message: string }> {
    try {
      const result = await apiClient.post<{ channel?: SupplyChannelWire }>(
        SUPPLY_CHANNELS_BASE,
        input
      );
      if (!result?.channel) return { ok: false, message: 'the backend returned no channel' };
      return { ok: true, channel: result.channel };
    } catch (error) {
      return { ok: false, message: errorMessage(error, 'failed to save the source') };
    }
  },

  async removeChannel(id: string): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await apiClient.delete(`${SUPPLY_CHANNELS_BASE}/${encodeURIComponent(id)}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: errorMessage(error, 'failed to remove the source') };
    }
  },

  /**
   * 探活：让基座真的去连一次这些渠道，按连接方式回报状态。
   *
   * 只读，不需要主密码。基座还没上线这个接口时调用会抛错，调用方按「未检查」显示 ——
   * 不把「探不了」渲染成「连不上」。
   */
  async probeChannels(ids?: string[]): Promise<SupplyProbeWire[]> {
    const result = await apiClient.post<SupplyProbeResponse>(`${SUPPLY_CHANNELS_BASE}/probe`, {
      ids: ids ?? [],
    });
    return Array.isArray(result?.probes) ? result.probes : [];
  },

  async listPool(kind: SupplyKindWire): Promise<SupplyLedgerWire[]> {
    const result = await apiClient.get<{ records?: SupplyLedgerWire[] }>(
      `${SUPPLY_POOL_BASE}?kind=${kind}`
    );
    return Array.isArray(result?.records) ? result.records : [];
  },
};
