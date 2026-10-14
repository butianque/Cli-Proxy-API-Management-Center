/**
 * 接码服务 · 来源（渠道）与池的 API（基座 `/v8/management/supply/*`）。
 *
 * 来源（渠道）是「身份的出处」：一条来源 = 标签 + 性质 + 连接信息。标签是给人看、
 * 给人选的；性质（我们怎么连它）才是基座那个分支，它决定连接表单，也决定池的样式。
 * 所以两者分开：改名不动实现。
 *
 * 本模块只调路由，不解释业务；后端字段 → 界面形状的归一化在 `features/sms/smsMapping.ts`。
 * 凭据的值**永不**经由此处：来源只带凭据在密钥库里的**名字**，状态只报有无。
 */

import { apiClient } from './client';

/** 基座路由前缀（与 server_management_v8.go 的挂载点一致）。 */
export const SUPPLY_CHANNELS_BASE = '/supply/channels';
export const SUPPLY_LEDGER_BASE = '/supply/ledger';

/** 身份种类。 */
export type SupplyKindWire = 'phone' | 'email';

/** 接入性质：我们怎么连它。 */
export type SupplyNatureWire = 'api' | 'imap' | 'web';

/** 后端返回的一条来源。 */
export interface SupplyChannelWire {
  id: string;
  kind: SupplyKindWire;
  label: string;
  nature: SupplyNatureWire;
  endpoint?: string;
  account?: string;
  /** 凭据在密钥库里的**名字**，不是值。 */
  secret?: string;
  enabled?: boolean;
  /** 该名字在密钥库里是否存在（只报有无，不见其值）。 */
  secret_present?: boolean;
  created?: number;
  updated?: number;
}

/** 后端声明的「哪种性质能服务哪种身份」，页面据此渲染可选性质。 */
export interface SupplyNatureWireInfo {
  nature: SupplyNatureWire;
  kinds: SupplyKindWire[];
}

export interface SupplyChannelsResponse {
  status: string;
  channels?: SupplyChannelWire[];
  natures?: SupplyNatureWireInfo[];
}

/** 一条来源的提交体。凭据的值不在这里 —— 这里只有凭据的名字。 */
export interface SupplyChannelInput {
  id?: string;
  kind: SupplyKindWire;
  label: string;
  nature: SupplyNatureWire;
  endpoint?: string;
  account?: string;
  secret?: string;
  enabled?: boolean;
}

/** 池里的一条身份（基座 `/supply/ledger` 的一行）。 */
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

/** 从 axios 错误里取后端给的原因。 */
function errorMessage(error: unknown, fallback: string): string {
  const data = (error as { data?: unknown })?.data as { error?: string } | undefined;
  return typeof data?.error === 'string' && data.error ? data.error : fallback;
}

export const supplyApi = {
  /** 读取某一类身份的来源清单，连同基座允许的性质集合。 */
  async listChannels(kind: SupplyKindWire): Promise<SupplyChannelsResponse> {
    return apiClient.get<SupplyChannelsResponse>(`${SUPPLY_CHANNELS_BASE}?kind=${kind}`);
  },

  /** 新建（不带 id）或修改（带 id）一条来源。 */
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

  /** 删除一条来源。它已经发出去的身份留在池里，不会被抹掉。 */
  async removeChannel(id: string): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await apiClient.delete(`${SUPPLY_CHANNELS_BASE}/${encodeURIComponent(id)}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: errorMessage(error, 'failed to remove the source') };
    }
  },

  /** 读取某一类身份已经发出去的身份（池）。 */
  async listPool(kind: SupplyKindWire): Promise<SupplyLedgerWire[]> {
    const result = await apiClient.get<{ records?: SupplyLedgerWire[] }>(
      `${SUPPLY_LEDGER_BASE}?kind=${kind}`
    );
    return Array.isArray(result?.records) ? result.records : [];
  },
};
