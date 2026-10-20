/**
 * 出口测试：从外面问一次「我现在看起来是哪个地址」。
 *
 * 买来的出口值不值，只能这样验：供应商标的国家、ASN 与真实地址都可能对不上，
 * 而地址才是唯一可核对的东西。这里只把后端答案归一成界面要的形状，
 * 组件不接触任何后端字段名。
 */

import { apiClient } from './client';

const EGRESS_BASE = '/egress';

/** 一次出口测试的结果。 */
export interface EgressProbeResult {
  ip: string;
  /** 国家与城市拼好的一行；服务没报就是空。 */
  region: string;
  /** 归属网络，如 `AS16509 Amazon.com, Inc.`；服务没报就是空。 */
  network: string;
  /** 往返毫秒；后端没报就是 `null`（不展示，不编造）。 */
  latencyMs: number | null;
  /** 这次走的是本机自己的线路，不是代理。 */
  direct: boolean;
}

type ProbeOutcome =
  | { ok: true; result: EgressProbeResult }
  | { ok: false; message: string };

/** 后端 `POST /egress/probe` 的原始形状。 */
interface EgressProbeWire {
  error?: string;
  direct?: boolean;
  ip?: string;
  country?: string;
  city?: string;
  asn?: string;
  org?: string;
  latency_ms?: number;
}

/** 后端把失败也写在 body 里（502 带原因），所以两种结局都收成一个结果对象。 */
function toProbeResult(raw: EgressProbeWire): EgressProbeResult | null {
  const ip = (raw.ip ?? '').trim();
  // 没有地址就是没测到。不能把其余字段凑成一行「看起来通了」。
  if (ip === '') return null;
  const latency = raw.latency_ms;
  return {
    ip,
    region: [(raw.country ?? '').trim(), (raw.city ?? '').trim()].filter(Boolean).join(' · '),
    network: [(raw.asn ?? '').trim(), (raw.org ?? '').trim()].filter(Boolean).join(' '),
    latencyMs: typeof latency === 'number' && Number.isFinite(latency) ? latency : null,
    direct: raw.direct === true,
  };
}

export const egressApi = {
  /**
   * 测一个出口。
   *
   * `url` 留空测当前生效的出口（后端按「接码出口 → 代理地址」的顺序取），
   * 传入则测这个还没保存的地址 —— 先测再存，正是这一格要的顺序。
   */
  async probe(url?: string): Promise<ProbeOutcome> {
    let raw: EgressProbeWire;
    try {
      raw = await apiClient.post<EgressProbeWire>(`${EGRESS_BASE}/probe`, url ? { url } : {});
    } catch (error) {
      const body = (error as { data?: unknown })?.data as { error?: string } | undefined;
      const message =
        typeof body?.error === 'string' && body.error
          ? body.error
          : error instanceof Error
            ? error.message
            : 'the exit could not be tested';
      return { ok: false, message };
    }
    const result = toProbeResult(raw);
    if (!result) {
      // 原因交给调用方翻译：这里可能只是「服务没报地址」，不是失败原因。
      return { ok: false, message: (raw.error ?? '').trim() };
    }
    return { ok: true, result };
  },
};
