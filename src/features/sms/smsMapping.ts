/**
 * 后端字段 → 页面领域类型。
 *
 * 这里是**前后端的唯一接缝**：`SmsChannelWire` / `SmsLedgerWire` 是后端形状，
 * `SmsChannel` / `PhoneLedgerEntry` 是界面形状。页面只认后者，后端改名时只改这里。
 *
 * 另外提供 `EMPTY_SMS_STATUS`：页面在拿到后端数据之前用**真实空态**起步，
 * 而不是拿一份编造的假数据充数（见 AGENTS.md「不造假数据」）。
 */

import type { SmsChannelWire, SmsLedgerWire } from '@/services/api/sms';
import type { ChannelHealth, PhoneLedgerEntry, SmsChannel, SmsPlatform, SmsStatus } from './types';

/** 可选平台（L1）。内置平台已知协议、地址固定；自定义平台由使用者自填。 */
export const SMS_PLATFORMS: SmsPlatform[] = [
  {
    id: 'haozhuma',
    name: '豪猪接码',
    summary: '用 API 接入取号，用网页登录管理渠道',
    preset: true,
    defaultEndpoint: 'https://api.haozhuma.cn',
  },
  {
    id: 'custom',
    name: '自定义',
    summary: '接入其他接码平台，自行填写地址与凭据',
    preset: false,
  },
];

/** 后端还没返回时页面显示的空态；各计数为 0，上限取后端默认量级。 */
export const EMPTY_SMS_STATUS: SmsStatus = {
  enabled: false,
  balanceCny: null,
  sessionSpendCny: 0,
  priceCeilingCny: 0,
  maxTotalCny: 0,
  availableChannels: 0,
  totalChannels: 0,
  channels: [],
  ledger: [],
  updatedAt: '',
};
/**
 * 后端渠道行 → 页面领域类型。
 *
 * 健康度由可得的事实推导（暂停 / 是否有货 / 是否超单价上限），不做纯装饰着色：
 * 暂停=critical、无货=warning、超上限=warning、其余=good。
 * `ceilingCny` 是使用者配置的单次取号单价上限（`null` = 未知/未配置）——健康点必须
 * 跟**真实的上限**联动：写死一个价格档会跟页面上「超出上限」的计数互相矛盾
 * （上限调了、颜色不变）。
 *
 * 渠道名不直接照搬平台的「[项目]讯飞」——同项目的多个渠道会全部同名、无法区分。
 * 改用该渠道真实抽取的运营商与号段（后端 `carriers`/`paragraphs`），
 * 这两个字段与平台无关，也真正说明「这条渠道能拿到什么号」。
 */
export function toChannel(raw: SmsChannelWire, ceilingCny: number | null = null): SmsChannel {
  const paused = raw.paused === true;
  const stock = Number.isFinite(raw.stock) ? raw.stock : 0;
  const price = Number.isFinite(raw.price) ? raw.price : 0;
  const overCeiling = ceilingCny !== null && ceilingCny > 0 && price > ceilingCny;
  const health: ChannelHealth = paused
    ? 'critical'
    : stock <= 0
      ? 'warning'
      : overCeiling
        ? 'warning'
        : 'good';
  const label = channelLabel(raw);
  return {
    id: raw.uid,
    name: label.name,
    detail: label.detail,
    priceCny: price,
    stock,
    paused,
    health,
  };
}

/**
 * Builds a short, distinguishable label plus a full description.
 *
 * The platform's own label is the project name ("[21614]讯飞"), which every
 * channel of a project shares — useless for telling channels apart. The
 * carriers and number prefixes are real per-channel facts, so the name shows the
 * carriers and the detail adds the prefixes; a long prefix list is truncated in
 * the name and available in full on hover.
 */
function channelLabel(raw: SmsChannelWire): { name: string; detail: string } {
  const carriers = splitList(raw.carriers);
  const paragraphs = splitList(raw.paragraphs);
  const carriersText = carriers.length > 0 ? carriers.join('/') : '';
  const paragraphsText = paragraphs.length > 0 ? paragraphs.join('/') : '';
  const detail = [carriersText, paragraphsText ? `号段 ${paragraphsText}` : '']
    .filter((part) => part !== '')
    .join(' · ');
  if (detail === '') {
    const fallback = (raw.name ?? '').trim() || raw.uid;
    return { name: fallback, detail: fallback };
  }
  const prefix = paragraphsText
    ? `号段 ${truncateList(paragraphs, 2)}${paragraphs.length > 2 ? '…' : ''}`
    : '';
  const name = [carriersText, prefix].filter((part) => part !== '').join(' · ');
  return { name, detail };
}

/** 列表超过 `max` 项时只留前 `max` 项，其余交给悬停详情。 */
function truncateList(items: string[], max: number): string {
  if (items.length <= max) return items.join('/');
  return items.slice(0, max).join('/');
}

/** 平台把运营商/号段用 `|` 分隔并留空尾，这里切成干净的列表。 */
function splitList(value?: string): string[] {
  if (!value) return [];
  return value
    .split('|')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** 后端账本行 → 页面领域类型（后端只记「租过」，成不成注册看账号绑定）。 */
export function toLedger(raw: SmsLedgerWire): PhoneLedgerEntry {
  const used = typeof raw.last_used === 'number' ? raw.last_used : 0;
  return {
    phone: raw.phone,
    account: raw.account ?? '',
    channel: raw.sid ?? '',
    // 后端不记录每次租用的实际支出，只有累计花费；这里不编造单条成本。
    costCny: null,
    status: raw.account ? 'registered' : 'pending',
    // 后端没记这次取号的时间就**留空**：拿 `now` 兜底等于把「现在」当成取号时刻，
    // 是编造数据（见 AGENTS.md「不造假数据」）。空值在页面上不展示这一格。
    takenAt: used > 0 ? new Date(used * 1000).toISOString() : null,
  };
}
