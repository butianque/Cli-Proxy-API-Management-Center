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
  SupplyChannelWire,
  SupplyConnectionWire,
  SupplyKindConfigWire,
  SupplyLedgerWire,
  SupplyNatureWireInfo,
  SupplyProbeWire,
} from '@/services/api/supply';
import type {
  ChannelHealth,
  PhoneLedgerEntry,
  PlatformConnection,
  PoolEntry,
  PoolState,
  SmsChannel,
  SmsPlatform,
  SmsStatusView,
  SupplyChannel,
  SupplyConnection,
  SupplyKind,
  SupplyKindConfig,
  SupplyNature,
  SupplyNatureOption,
  SupplyProbeResult,
  SupplyProbeState,
} from './types';

/**
 * 连接方式的显示名。手机号与邮箱共用同一套词：凭据弹窗的 Tab、渠道池的「连接方式」
 * 列、邮箱编辑器的勾选列表说的都是同一件事，所以用同一份标签。
 */
export const NATURE_LABEL: Record<SupplyNature, string> = {
  api: 'sms_service.nature_api',
  imap: 'sms_service.nature_imap',
  web: 'sms_service.nature_web',
};

/** 渠道类别的显示名。键是后端给的值，认不出的值不猜（调用方按缺省处理）。 */
export const CATEGORY_LABEL: Record<string, string> = {
  'third-party': 'sms_service.category_third_party',
  'self-owned': 'sms_service.category_self_owned',
  'self-built': 'sms_service.category_self_built',
};

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
    target: raw.target ?? '',
    // `code` 是取号渠道（对接码）；`sid` 是项目号，两者不同，渠道展示用前者。
    channel: raw.code ?? '',
    // 后端不记录每次租用的实际支出，只有累计花费；这里不编造单条成本。
    costCny: null,
    status: ledgerStatus(raw),
    // 后端没记这次取号的时间就**留空**：拿 `now` 兜底等于把「现在」当成取号时刻，
    // 是编造数据（见 AGENTS.md「不造假数据」）。空值在页面上不展示这一格。
    takenAt: used > 0 ? new Date(used * 1000).toISOString() : null,
  };
}

/**
 * 账本行的状态。
 *
 * 后端按「有没有绑定账号」和「号码当前的处置」两个事实来描述，页面把它们归成
 * 三态：已绑定账号 = 注册成功；被拉黑 = 失败；其余 = 还在等（取过号、还没结果）。
 */
function ledgerStatus(raw: SmsLedgerWire): PhoneLedgerEntry['status'] {
  if (raw.state === 'blacklisted') return 'failed';
  if (raw.account) return 'registered';
  return 'pending';
}

/* ---------------------------------------------------------------------------
 * 来源（渠道）与池：手机号与邮箱共用。
 *
 * 与上面同一套规矩：后端字段名只出现在本文件，页面组件只见界面类型。
 * ------------------------------------------------------------------------ */

/**
 * 基座声明的性质集合 → 页面选项。
 *
 * 「哪种性质能服务哪种身份」是**基座的规则**（`Nature.SupportsKind`），页面不自己
 * 维护一份 —— 自己维护就会在两处漂移：后端拒了、页面还在让人选。
 */
export function toNatureOptions(list: SupplyNatureWireInfo[] | undefined): SupplyNatureOption[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => typeof item?.nature === 'string')
    .map((item) => ({
      nature: item.nature as SupplyNature,
      kinds: (Array.isArray(item.kinds) ? item.kinds : []) as SupplyKind[],
    }));
}

/** 后端一条连接信息 → 页面形状。 */
function toSupplyConnection(raw: SupplyConnectionWire | undefined): SupplyConnection {
  return {
    endpoint: raw?.endpoint ?? '',
    account: raw?.account ?? '',
    secret: raw?.secret ?? '',
    secretPresent: raw?.secret_present === true,
    usage: raw?.usage ?? '',
    domain: raw?.domain ?? '',
  };
}

/** 后端一个种类块 → 页面形状。 */
function toSupplyKindConfig(raw: SupplyKindConfigWire | undefined): SupplyKindConfig | null {
  if (!raw) return null;
  const conns: Partial<Record<SupplyNature, SupplyConnection>> = {};
  if (raw.connections) {
    for (const [key, value] of Object.entries(raw.connections)) {
      conns[key as SupplyNature] = toSupplyConnection(value);
    }
  }
  return {
    enabled: raw.enabled,
    natures: (raw.natures ?? []) as SupplyNature[],
    connections: conns,
  };
}

/** 后端一条来源 → 页面形状。 */
export function toSupplyChannel(raw: SupplyChannelWire): SupplyChannel {
  return {
    id: raw.id,
    label: raw.label ?? '',
    category: raw.category ?? 'third-party',
    phone: toSupplyKindConfig(raw.phone),
    email: toSupplyKindConfig(raw.email),
  };
}

/** 批量归一化渠道清单。 */
export function toSupplyChannels(list: SupplyChannelWire[] | undefined): SupplyChannel[] {
  if (!Array.isArray(list)) return [];
  return list.map(toSupplyChannel);
}

/**
 * 探活响应 → 页面形状。
 *
 * 只认基座声明的四种状态，其余一律**不猜**：认不出的状态当作「没探到」，页面显示
 * 「未检查」。把未知值渲染成「连不上」就是把「我不知道」说成了「它坏了」。
 */
export function toProbes(list: SupplyProbeWire[] | undefined): SupplyProbeResult[] {
  if (!Array.isArray(list)) return [];
  const known: SupplyProbeState[] = ['online', 'offline', 'unready', 'unsupported'];
  const result: SupplyProbeResult[] = [];
  for (const item of list) {
    if (typeof item?.id !== 'string' || item.id === '') continue;
    const natures: Partial<Record<SupplyNature, SupplyProbeState>> = {};
    for (const [nature, probe] of Object.entries(item.natures ?? {})) {
      const state = known.find((candidate) => candidate === probe?.state);
      if (state) natures[nature as SupplyNature] = state;
    }
    result.push({ id: item.id, natures });
  }
  return result;
}

/**
 * 池里一条身份的处置。
 *
 * 与手机号账本同一个判据：拉黑=失败、已绑账号=已注册、其余=待用。判据写两遍就会
 * 出现「同一行在两个页面上状态不一样」。
 */
function poolState(raw: SupplyLedgerWire): PoolState {
  if (raw.state === 'blacklisted') return 'failed';
  if (raw.state === 'released') return 'released';
  if (raw.account) return 'registered';
  return 'pending';
}

/** 后端一条身份 → 池里的一行。 */
export function toPoolEntry(raw: SupplyLedgerWire): PoolEntry {
  const used = typeof raw.last_used === 'number' ? raw.last_used : 0;
  return {
    identity: raw.address ?? '',
    source: raw.source ?? '',
    account: raw.account ?? '',
    platform: raw.target ?? '',
    state: poolState(raw),
    // 后端没记时间就是没有（`null`），不拿 `now` 顶替 —— 那是编造数据。
    lastUsedAt: used > 0 ? new Date(used * 1000).toISOString() : null,
  };
}

/** 批量归一化池记录。 */
export function toPool(list: SupplyLedgerWire[] | undefined): PoolEntry[] {
  if (!Array.isArray(list)) return [];
  return list.map(toPoolEntry);
}
