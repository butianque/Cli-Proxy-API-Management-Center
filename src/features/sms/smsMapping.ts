/**
 * 后端字段 → 页面领域类型。
 *
 * 这里是**前后端的唯一接缝**：`SmsStatusResponse` / `SmsChannelWire` / `SmsLedgerWire`
 * 是后端形状，`SmsStatusView` / `SmsChannel` / `PhoneLedgerEntry` 是界面形状。
 * 页面只认后者，后端改名时只改这里。
 *
 * 另外提供 `EMPTY_SMS_VIEW`：页面在拿到后端数据之前用**真实空态**起步，
 * 而不是拿一份编造的假数据充数（见 AGENTS.md「不造假数据」）。
 */

import type { SmsChannelWire, SmsLedgerWire, SmsStatusResponse } from '@/services/api/sms';
import type {
  ChannelHealth,
  PhoneLedgerEntry,
  PlatformConnection,
  SmsChannel,
  SmsPlatform,
  SmsStatusView,
} from './types';

/** 可选平台（L1）。内置平台已知协议、地址固定；自定义平台由使用者自填。 */
export const SMS_PLATFORMS: SmsPlatform[] = [
  {
    id: 'haozhuma',
    nameKey: 'sms_service.platform_haozhuma',
    summaryKey: 'sms_service.platform_haozhuma_summary',
    preset: true,
    defaultEndpoint: 'https://api.haozhuma.cn',
  },
  {
    id: 'custom',
    nameKey: 'sms_service.platform_custom',
    summaryKey: 'sms_service.platform_custom_summary',
    preset: false,
  },
];

/** 后端还没返回时页面显示的空态：各计数为 0，上限为「未配置」，`loaded` 为 false。 */
export const EMPTY_SMS_VIEW: SmsStatusView = {
  loaded: false,
  enabled: false,
  storeLocked: false,
  accountPresent: false,
  cookiePresent: false,
  webPresent: false,
  apiUserHint: '',
  webUserHint: '',
  connection: 'unchecked',
  balanceCny: null,
  spentCny: 0,
  ceilingCny: 0,
  maxTotalCny: 0,
  channels: [],
  ledger: [],
  updatedAt: '',
};

/**
 * 渠道单价是否超过配置的单价上限。
 *
 * 上限**未配置**（`null` / `0`）时不算超标 —— 没有上限就没有「超标」。健康点与
 * 页面上「N 个高于 …」的计数**必须**用同一个判据，否则会出现「N 个高于 ¥0.00」
 * 而每个健康点都是绿的（同一个规则写两遍就会这样）。
 */
export function isOverCeiling(priceCny: number, ceilingCny: number | null): boolean {
  return ceilingCny !== null && ceilingCny > 0 && priceCny > ceilingCny;
}

/**
 * 插件 `/sms/status` → 页面视图。**后端字段只在这里出现一次**。
 *
 * `prefixLabel` 是「号段」一词的本地化写法，由调用方从 i18n 取（本模块保持纯函数）。
 */
export function toStatus(raw: SmsStatusResponse, prefixLabel: string): SmsStatusView {
  // 密钥库锁定时插件读不到凭据名，`api_present` / `cookie_present` 会回 false，
  // 即使它们其实存在。必须与「什么都没配」区分开，否则页面会声称操作者从没配过。
  const storeLocked = raw.store_available === false;
  // 上限既用来推渠道健康点，也是页面上的「单价上限」读数：同一个值只取一次。
  const ceilingCny = raw.budget?.max_per_number_cny ?? 0;
  let connection: PlatformConnection = 'unchecked';
  let connectionReason: string | undefined;
  if (storeLocked) {
    connection = 'unavailable';
    connectionReason = raw.error;
  } else if (typeof raw.balance_cny === 'number') {
    connection = 'connected';
  } else if (raw.status === 'unavailable') {
    connection = 'unavailable';
    connectionReason = raw.error;
  } else if (raw.balance_error) {
    connection = 'failed';
    connectionReason = raw.balance_error;
  }
  return {
    loaded: true,
    enabled: raw.enabled === true,
    storeLocked,
    accountPresent: raw.api_present === true,
    cookiePresent: raw.cookie_present === true,
    webPresent: raw.web_present === true,
    apiUserHint: raw.api_user_hint ?? '',
    webUserHint: raw.web_user_hint ?? '',
    connection,
    connectionReason,
    // 只有**凭据相关**读数在锁定时不可读：余额置空（而非沿用旧值）。
    balanceCny: !storeLocked && typeof raw.balance_cny === 'number' ? raw.balance_cny : null,
    spentCny: typeof raw.spent_cny === 'number' ? raw.spent_cny : 0,
    ceilingCny,
    maxTotalCny: raw.budget?.max_total_cny ?? 0,
    channels: toChannels(raw.channels ?? [], { ceilingCny, prefixLabel }),
    ledger: Array.isArray(raw.ledger) ? raw.ledger.map(toLedger) : [],
    updatedAt:
      typeof raw.channels_updated_at === 'number' && raw.channels_updated_at > 0
        ? new Date(raw.channels_updated_at * 1000).toISOString()
        : '',
  };
}

/** 渠道归一化的可选项。 */
export interface ChannelMappingOptions {
  /** 使用者配置的单次取号单价上限（`null` = 未知/未配置）。 */
  ceilingCny?: number | null;
  /** 「号段」一词的本地化写法（渠道名里要用）。 */
  prefixLabel: string;
}

/** 批量归一化渠道行（写回渠道表时用同一个选项，避免两处各写一份）。 */
export function toChannels(
  list: SmsChannelWire[],
  options: ChannelMappingOptions
): SmsChannel[] {
  return list.map((channel) => toChannel(channel, options));
}

/**
 * 后端渠道行 → 页面领域类型。
 *
 * 健康度由可得的事实推导（暂停 / 是否有货 / 是否超单价上限），不做纯装饰着色：
 * 暂停=critical、无货=warning、超上限=warning、其余=good。
 * 上限与「超标」的判据统一走 `isOverCeiling` —— 健康点必须跟**真实的上限**联动：
 * 写死一个价格档会跟页面上「超出上限」的计数互相矛盾（上限调了、颜色不变）。
 *
 * 渠道名不直接照搬平台的「[项目]讯飞」——同项目的多个渠道会全部同名、无法区分。
 * 改用该渠道真实抽取的运营商与号段（后端 `carriers`/`paragraphs`），
 * 这两个字段与平台无关，也真正说明「这条渠道能拿到什么号」。
 */
export function toChannel(raw: SmsChannelWire, options: ChannelMappingOptions): SmsChannel {
  const paused = raw.paused === true;
  const stock = Number.isFinite(raw.stock) ? raw.stock : 0;
  const price = Number.isFinite(raw.price) ? raw.price : 0;
  const health: ChannelHealth = paused
    ? 'critical'
    : stock <= 0
      ? 'warning'
      : isOverCeiling(price, options.ceilingCny ?? null)
        ? 'warning'
        : 'good';
  const label = channelLabel(raw, options.prefixLabel);
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
 *
 * `prefixLabel` is the localized word for a number prefix ("号段" / "prefix"), so
 * the label is not stuck in one language.
 */
function channelLabel(raw: SmsChannelWire, prefixLabel: string): { name: string; detail: string } {
  const carriers = splitList(raw.carriers);
  const paragraphs = splitList(raw.paragraphs);
  const carriersText = carriers.length > 0 ? carriers.join('/') : '';
  const paragraphsText = paragraphs.length > 0 ? paragraphs.join('/') : '';
  const detail = [carriersText, paragraphsText ? `${prefixLabel} ${paragraphsText}` : '']
    .filter((part) => part !== '')
    .join(' · ');
  if (detail === '') {
    const fallback = (raw.name ?? '').trim() || raw.uid;
    return { name: fallback, detail: fallback };
  }
  const prefix = paragraphsText
    ? `${prefixLabel} ${truncateList(paragraphs, 2)}${paragraphs.length > 2 ? '…' : ''}`
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
