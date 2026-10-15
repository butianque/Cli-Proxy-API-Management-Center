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
export type SupplyNatureWire = 'api' | 'imap' | 'web';

/** 一条连接方式的连接信息（后端 Connection）。 */
export interface SupplyConnectionWire {
  endpoint?: string;
  account?: string;
  secret?: string;
  secret_present?: boolean;
  usage?: string;
  domain?: string;
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
  usage?: string;
  domain?: string;
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

/** 池里的一条身份（基座 `/supply/pool` 的一行）。 */
export interface SupplyLedgerWire {
  kind: SupplyKindWire;
  address: string;
  source?: string;
  target?: string;
  account?: string;
  state?: string;
  outcome?: string;
  price?: number;
  rents?: number;
  first_seen?: number;
  last_used?: number;
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

  async listPool(kind: SupplyKindWire): Promise<SupplyLedgerWire[]> {
    const result = await apiClient.get<{ records?: SupplyLedgerWire[] }>(
      `${SUPPLY_POOL_BASE}?kind=${kind}`
    );
    return Array.isArray(result?.records) ? result.records : [];
  },
};
