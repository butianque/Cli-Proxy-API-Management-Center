/**
 * 代理池：这台机器买下的出口，以及谁挂在每条出口上。
 *
 * 池里存的是地址，目标上存的是**编号**。所以「换 IP」是改一条出口，而不是
 * 把每个账号、每条渠道都改一遍；反过来，一条出口被谁用着，也只能从落点现算，
 * 不能在这里缓存一份 —— 删掉一个账号之后，缓存会留下一个不存在的占用。
 *
 * 后端契约见 `CLIProxyAPI/internal/api/handlers/management/egress_pool.go`。
 * 这里只做两件事：把 snake_case 归一成界面要的形状，把失败归一成一句能显示的话。
 */

import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';

const POOL_BASE = '/egress/pool';
const UNBIND_PATH = '/egress/unbind';

/** 一条出口上次被问到「你看起来是哪儿」的结论。 */
export interface EgressProbeSummary {
  /** 问到地址了才算通。 */
  ok: boolean;
  ip: string;
  /** 国家与城市拼好的一行；没报就是空。 */
  region: string;
  /** 归属网络，如 `AS9009 M247 Europe SRL`；没报就是空。 */
  network: string;
  /** 往返毫秒；后端没报就是 `null`。 */
  latencyMs: number | null;
  /** 没问到时后端给的原因；问到了就是空。 */
  error: string;
  /** 这次测试发生的时刻（Unix 秒）。 */
  at: number;
}

/** 池里的一条出口。 */
export interface EgressPoolEntry {
  id: number;
  /**
   * 脱敏后的地址，只够用来辨认，**不能拿去连**。
   * 编辑时原样提交回来表示「地址不变」，后端按这个规则处理。
   */
  url: string;
  label: string;
  note: string;
  /** 停用的条目不再参与自动分配，但仍然可以被显式绑定。 */
  enabled: boolean;
  /** 从没测过就是 `null` —— 不拿「没测」冒充「通了」。 */
  probe: EgressProbeSummary | null;
  /** 挂在这条出口上的账号数。 */
  accounts: number;
  /** 挂在这条出口上的渠道数。 */
  channels: number;
  /** 以上两项之和（含后端算出的总占用）。 */
  total: number;
}

/** 一次读取的结果：出口列表。 */
export interface EgressPoolRead {
  entries: EgressPoolEntry[];
}

/** 一次出口测试的结论：失败时也带着刚测过的那条出口的新状态。 */ export type EgressProbeOutcome =
  | { ok: true; entry: EgressPoolEntry }
  | { ok: false; message: string; entry: EgressPoolEntry | null };

/** 绑定的目标：一个账号，或一条渠道。 */
export interface EgressTarget {
  kind: 'account' | 'channel';
  /** 账号用凭证文件名，渠道用渠道 id。 */
  name: string;
  /** 渠道专用：只绑这一种（`email` / `phone`）；省略表示这条渠道声明的全部。 */
  supplyKind?: string;
  /** 渠道专用：只绑这一种连接（`imap`、`graph`、`api`…）；省略表示全部。 */
  nature?: string;
}

/** 下拉框里的一个选项。 */
export interface EgressOption {
  value: string;
  /** 第一行：`#3 香港 1`。没有名字就只有编号，两条没名字的出口仍然分得开。 */
  label: string;
  /** 第二行：脱敏地址，用来认出是哪一条。 */
  description: string;
  /** 停用的出口仍然可选（有东西挂在上头时必须能显示），但要标注出来。 */
  enabled: boolean;
}

/** 池不可用（旧版后端没有这组接口）。面板据此显示空态而不是报错。 */
export class EgressPoolUnsupportedError extends Error {
  constructor() {
    super('the proxy pool is not available on this server');
    this.name = 'EgressPoolUnsupportedError';
  }
}

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const readCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const readLatency = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** 失败原因优先取后端给的，其次取客户端错误；两者都没有才用兜底句。 */
function failureMessage(error: unknown, fallback: string): string {
  const body = (error as { data?: unknown })?.data;
  if (isRecord(body)) {
    const reason = trimString(body.error);
    if (reason !== '') return reason;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** 后端 404 = 这版服务端还没有代理池。 */
function isMissingEndpoint(error: unknown): boolean {
  return (error as { status?: number })?.status === 404;
}

function normalizeProbe(value: unknown): EgressProbeSummary | null {
  if (!isRecord(value)) return null;
  const country = trimString(value.country);
  const city = trimString(value.city);
  // 城市名与国家名相同时（`Hong Kong · Hong Kong`）只说一次：重复的那一半不提供
  // 任何信息，只让这一格变长。缺一个的时候也不留半个分隔符。
  const region = [country, city === country ? '' : city].filter(Boolean).join(' · ');
  return {
    ok: value.ok === true,
    ip: trimString(value.ip),
    region,
    network: [trimString(value.asn), trimString(value.org)].filter(Boolean).join(' '),
    latencyMs: readLatency(value.latency_ms),
    error: trimString(value.error),
    at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0,
  };
}

/** 一条出口。`counts` 缺失时按「不知道」处理，不补 0 冒充「没人用」。 */
export function normalizeEgressPoolEntry(value: unknown): EgressPoolEntry | null {
  if (!isRecord(value)) return null;
  const id = readCount(value.id);
  if (id === 0) return null;
  const counts = isRecord(value.counts) ? value.counts : {};
  const accounts = readCount(counts.account);
  const channels = readCount(counts.channel);
  return {
    id,
    url: trimString(value.url),
    label: trimString(value.label),
    note: trimString(value.note),
    enabled: value.enabled !== false,
    probe: normalizeProbe(value.last_probe),
    accounts,
    channels,
    // The total comes from the server so the "still in use" message quotes the
    // same number the server refuses on; deriving it here would drift.
    total: readCount(value.total) || accounts + channels,
  };
}

function normalizePoolRead(payload: unknown): EgressPoolRead {
  const source = isRecord(payload) ? payload : {};
  const entries = Array.isArray(source.entries) ? source.entries : [];
  return {
    entries: entries
      .map(normalizeEgressPoolEntry)
      .filter((entry): entry is EgressPoolEntry => entry !== null)
      .sort((left, right) => left.id - right.id),
  };
}

/** 把绑定目标写成后端的请求体。空字段不发送，让后端按「全部」处理。 */
function targetBody(target: EgressTarget): Record<string, unknown> {
  const body: Record<string, unknown> = { kind: target.kind, name: target.name };
  const supplyKind = trimString(target.supplyKind);
  const nature = trimString(target.nature);
  if (supplyKind !== '') body.supply_kind = supplyKind;
  if (nature !== '') body.nature = nature;
  return body;
}

export const egressPoolApi = {
  /** 列出全部出口。旧版后端没有这组接口时抛 `EgressPoolUnsupportedError`。 */
  async list(): Promise<EgressPoolRead> {
    try {
      return normalizePoolRead(await apiClient.get<unknown>(POOL_BASE));
    } catch (error) {
      if (isMissingEndpoint(error)) throw new EgressPoolUnsupportedError();
      throw error;
    }
  },

  /** 新增一条出口。地址必填：没有地址的条目没有任何用处。 */
  async add(input: { url: string; label?: string; note?: string }): Promise<EgressPoolEntry> {
    const payload = await apiClient.post<unknown>(POOL_BASE, {
      url: input.url.trim(),
      label: input.label?.trim() ?? '',
      note: input.note?.trim() ?? '',
    });
    const entry = normalizeEgressPoolEntry(isRecord(payload) ? payload.entry : null);
    if (!entry) throw new Error('the server did not return the new exit');
    return entry;
  },

  /**
   * 改一条出口。
   *
   * `url` 省略表示「地址不变」：面板读到的地址是脱敏的，回传脱敏值只会把
   * 真实密码替换成 `redacted`，所以不传比传更安全。
   */
  async patch(
    id: number,
    input: { url?: string; label?: string; note?: string; enabled?: boolean }
  ): Promise<EgressPoolEntry> {
    const body: Record<string, unknown> = {};
    if (input.url !== undefined && input.url.trim() !== '') body.url = input.url.trim();
    if (input.label !== undefined) body.label = input.label.trim();
    if (input.note !== undefined) body.note = input.note.trim();
    if (input.enabled !== undefined) body.enabled = input.enabled;
    const payload = await apiClient.patch<unknown>(`${POOL_BASE}/${id}`, body);
    const entry = normalizeEgressPoolEntry(isRecord(payload) ? payload.entry : null);
    if (!entry) throw new Error('the server did not return the updated exit');
    return entry;
  },

  /** 删一条出口。还有东西挂在上头时后端返回 409，原因交给调用方显示。 */
  async remove(id: number): Promise<void> {
    await apiClient.delete<unknown>(`${POOL_BASE}/${id}`);
  },

  /** 从外面问一次这条出口看起来是哪儿，并把答案记下来。 */
  async probe(id: number): Promise<EgressProbeOutcome> {
    try {
      const payload = await apiClient.post<unknown>(`${POOL_BASE}/${id}/probe`);
      const entry = normalizeEgressPoolEntry(isRecord(payload) ? payload.entry : null);
      if (!entry) return { ok: false, message: '', entry: null };
      return { ok: true, entry };
    } catch (error) {
      const body = (error as { data?: unknown })?.data;
      const entry = normalizeEgressPoolEntry(isRecord(body) ? body.entry : null);
      // 问不到不等于这条出口坏了（可能是回声服务自己不通），所以只报原因、不下结论。
      return { ok: false, message: failureMessage(error, ''), entry };
    }
  },

  /** 把一条出口指给一个目标。自动化也走这一条。 */
  async bind(id: number, target: EgressTarget): Promise<void> {
    await apiClient.post<unknown>(`${POOL_BASE}/${id}/bind`, targetBody(target));
  },

  /** 解除一个目标的出口绑定，同时清掉它上面残留的地址。 */
  async unbind(target: EgressTarget): Promise<void> {
    await apiClient.post<unknown>(UNBIND_PATH, targetBody(target));
  },
};

/**
 * 下拉框要的选项：`#1` 这样的编号加一句能认出来的描述。
 *
 * 分两行：第一行是「哪一条」，第二行是「它长什么样」。挤成一行时，几条同名出口
 * 只能靠截断分辨，而截断掉的恰好是唯一能分辨的那段地址。
 *
 * 停用的出口也要列出来，否则一条正在检修的出口会让挂在上头的账号显示成
 * 「未绑定」，而它其实还绑着 —— 选项里带上 `enabled`，由调用方决定怎么标注。
 */
export function egressOptions(entries: EgressPoolEntry[]): EgressOption[] {
  return entries.map((entry) => ({
    value: String(entry.id),
    label: entry.label === '' ? `#${entry.id}` : `#${entry.id} ${entry.label}`,
    description: entry.url,
    enabled: entry.enabled,
  }));
}

/**
 * 下拉框的选项顺序：解绑那一项永远第一，当前绑的那条紧随其后，其余按池内编号排。
 *
 * 顺序本身就是这一格的一半功能。之前完全按池内编号排，于是「现在绑的是哪条」落在
 * 十几行里的某一行，只能靠那个勾去找；池里条目越多，越找不准。解绑是一个固定位置
 * 的动作，当前值是一个固定位置的状态，候选列表排在它们后面。
 *
 * 选中值不在候选里（绑着的那条出口被删了）时保持原样：调用方会把这条「已不存在」
 * 的选项补进候选，它同样按选中值排到第二位。
 */
export function orderEgressChoices<T extends { value: string }>(
  none: T,
  choices: ReadonlyArray<T>,
  selectedValue: string
): T[] {
  const selected = choices.find((choice) => choice.value === selectedValue);
  const rest = choices.filter((choice) => choice.value !== selectedValue);
  return selected === undefined ? [none, ...rest] : [none, selected, ...rest];
}
