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
import type { EmailAddressProbeWire } from '@/services/api/email';
import { resolveCredentialSite } from '@/features/authFiles/siteIdentity';
import type { CredentialSite } from '@/features/authFiles/siteIdentity';
import { normalizeOAuthProviderKey } from '@/utils/providerKeys';
import type {
  SupplyChannelWire,
  SupplyConnectionWire,
  SupplyKindConfigWire,
  SupplyLedgerMailboxWire,
  SupplyLedgerProjectWire,
  SupplyLedgerWire,
  SupplyNatureWireInfo,
  SupplyProbeWire,
} from '@/services/api/supply';
import type {
  ChannelHealth,
  MailboxProbe,
  PhoneLedgerEntry,
  PlatformConnection,
  PoolEntry,
  PoolMailbox,
  PoolRegistration,
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
  oauth2: 'sms_service.nature_oauth2',
  graph: 'sms_service.nature_graph',
  web: 'sms_service.nature_web',
};

/** 渠道类别的显示名。键是后端给的值，认不出的值不猜（调用方按缺省处理）。 */
export const CATEGORY_LABEL: Record<string, string> = {
  'third-party': 'sms_service.category_third_party',
  'self-built': 'sms_service.category_self_built',
};

/**
 * 手机号能选的类别。
 *
 * 现在只有「第三方服务」：接码平台给的号都是别人的服务。等真的有了自己的号码池再往
 * 这里加 —— 先摆三个选项、其中两个选不出任何差别，等于让人做一道没有答案的题。
 *
 * 与 `CATEGORY_LABEL` 放一起：类别这套词汇只有一个出处，编辑器与表都从这里取，
 * 免得「表里认识的值」和「能选的值」各写一份、慢慢漂移。
 */
export const PHONE_CATEGORY_OPTIONS = ['third-party'] as const;

/**
 * 邮箱能选的类别，顺序即选择器里的顺序。
 *
 * 两种说的是两件不同的事，不是同一件事的两种叫法：
 *   - 第三方服务：别人的邮箱服务，一个地址。
 *   - 自建域名：自己的域 + catch-all，每次注册都能现编一个地址，全落进同一个信箱。
 *
 * 「自己的信箱」（比如买来的一个 Outlook 号）**不在这里**：它只对应一个地址、一份
 * 凭据，读信不需要一条连接 —— 那是供应池里的一个身份，不是一条渠道。把它当成一种
 * 渠道类别，渠道表就会一个号长一行。
 */
export const EMAIL_CATEGORY_OPTIONS = ['third-party', 'self-built'] as const;

/**
 * 这个类别是不是「一个能凭空发地址的域」。
 *
 * 这是**能力**的事实，不是接入方式：同一个域走 IMAP 读、还是走转发服务的 API 读，
 * 都是自己的域。所以它住在类别里，基座据此决定这个邮箱能不能凭空发地址（catch-all），
 * 面板据此决定要不要问域名。
 */
export function isCatchAllCategory(category: string): boolean {
  return category === 'self-built';
}

/**
 * 渠道邮箱唯一的接入方式。
 *
 * 渠道是「一条连接覆盖很多地址」：自建域的 catch-all、转发服务，靠授权码登录收信。
 * 微软那两种（OAuth2 / Graph）是**一个信箱用自己的凭据读自己的信** —— 那是供应池里
 * 的一个身份，不是一条渠道。基座据此只认 imap，编辑器也只画这一种。
 *
 * 批量导入的收信方式在导入弹窗里选（`ImportMailboxesModal`），与这里无关。
 */
export const EMAIL_DEFAULT_NATURE: SupplyNature = 'imap';

/**
 * 可选平台（L1）。内置平台已知协议、地址固定；自定义平台由使用者自填。
 *
 * 内置平台把自己**已知的事实**一并声明（地址、类别、支持的接入方式）：这些不是使用者
 * 的选择题，编辑器按它带出默认值 —— 平台卡片上的那句话（「用 API 接入取号，用网页
 * 登录管理渠道」）与勾选框不该各说一套。
 */
export const SMS_PLATFORMS: SmsPlatform[] = [
  {
    id: 'haozhuma',
    nameKey: 'sms_service.platform_haozhuma',
    summaryKey: 'sms_service.platform_haozhuma_summary',
    preset: true,
    defaultEndpoint: 'https://api.haozhuma.cn',
    defaultCategory: 'third-party',
    defaultNatures: ['api', 'web'],
  },
  {
    id: 'custom',
    nameKey: 'sms_service.platform_custom',
    summaryKey: 'sms_service.platform_custom_summary',
    preset: false,
  },
];

/**
 * 编辑器该显示哪个平台：使用者显式选过就用它，否则跟随已存凭据所属的平台。
 *
 * 手机号这一类只有**一份**平台凭据，渠道记录只**指名**它 —— 所以「平台」不是自由
 * 选项，默认就该是已存凭据所属的那个。认不出的 provider 落回第一个（内置）平台。
 *
 * 这条规则原先写成组件里的一段内联表达式，正是「编辑配在自定义平台上的渠道时，
 * 平台显示成内置平台」的来源：选中态、名称标签、地址框、脱敏提示各算各的。抽成具名
 * 函数后有单测钉住，组件只认它的返回值，不再各自推导。
 */
export function resolvePlatformId(choice: string | null, storedProvider?: string): string {
  if (choice) return choice;
  const stored = SMS_PLATFORMS.find((item) => item.id === (storedProvider ?? ''));
  return stored ? stored.id : SMS_PLATFORMS[0].id;
}

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
  provider: '',
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
    provider: raw.provider ?? '',
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
export function toChannels(list: SmsChannelWire[], options: ChannelMappingOptions): SmsChannel[] {
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
    domain: raw?.domain ?? '',
    clientId: raw?.client_id ?? '',
    egressId:
      typeof raw?.egress_id === 'number' && Number.isInteger(raw.egress_id) && raw.egress_id > 0
        ? raw.egress_id
        : 0,
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

/**
 * 一个种类块共用的出口编号。
 *
 * 出口挂在**连接**上（同一个块里可以同时有 api 与 web 两种连接），但界面上是按块
 * 给一个下拉框。块内各连接一致才报出那个编号；不一致时报 0 —— 下拉框只能表达一个
 * 值，报其中任意一个都会让另一个连接的真实出口被这句话盖掉。
 */
export function blockEgressId(block: SupplyKindConfig | null | undefined): number {
  if (!block) return 0;
  const ids = Object.values(block.connections).map((connection) => connection?.egressId ?? 0);
  if (ids.length === 0) return 0;
  const [first] = ids;
  return ids.every((id) => id === first) ? first : 0;
}

/** 后端一条来源 → 页面形状。 */
// 已入池计数只认真实非负数：后端没报就是「数不出来」，不能当成 0。
export function toSupplyChannel(raw: SupplyChannelWire): SupplyChannel {
  const pooled: Partial<Record<SupplyKind, number>> = {};
  for (const kind of ['phone', 'email'] as const) {
    const value = raw.pooled?.[kind];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) pooled[kind] = value;
  }
  return {
    id: raw.id,
    label: raw.label ?? '',
    category: raw.category ?? 'third-party',
    phone: toSupplyKindConfig(raw.phone),
    email: toSupplyKindConfig(raw.email),
    pooled,
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
  const result: SupplyProbeResult[] = [];
  for (const item of list) {
    if (typeof item?.id !== 'string' || item.id === '') continue;
    const natures: Partial<Record<SupplyNature, SupplyProbeState>> = {};
    for (const [nature, probe] of Object.entries(item.natures ?? {})) {
      const state = knownProbeState(probe?.state);
      if (state) natures[nature as SupplyNature] = state;
    }
    result.push({ id: item.id, natures });
  }
  return result;
}

/** 只认基座声明的四种状态；其余一律不猜。 */
function knownProbeState(value: unknown): SupplyProbeState | null {
  switch (value) {
    case 'online':
    case 'offline':
    case 'unready':
    case 'unsupported':
      return value;
  }
  return null;
}

/**
 * 地址探活响应 → 按地址查的「现在打不打得开」。
 *
 * 对不上地址、或者状态认不出来的行直接丢掉：一条不知道属于谁的结论，宁可不显示，
 * 也不能安到别的行上。
 */
export function toMailboxProbes(
  probes: EmailAddressProbeWire[] | undefined
): Map<string, MailboxProbe> {
  const result = new Map<string, MailboxProbe>();
  if (!Array.isArray(probes)) return result;
  for (const probe of probes) {
    const address = (probe.address ?? '').trim().toLowerCase();
    if (!address) continue;
    const state = knownProbeState(probe.state);
    if (!state) continue;
    result.set(address, { state, detail: (probe.detail ?? '').trim() });
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

/** 后端一次注册的处置 → 台账里的处置。判据与整条记录一致，两处不能各说一套。 */
function registrationState(outcome: string | undefined): PoolState {
  switch ((outcome ?? '').trim().toLowerCase()) {
    case 'registered':
      return 'registered';
    case 'released':
      return 'released';
    case 'timeout':
    case 'failed':
    case 'error':
      return 'failed';
    default:
      return 'pending';
  }
}

/**
 * 后端一条注册 → 台账里的一条项目记录。
 *
 * 平台和账号都没有的项不是一次注册（后端用空 target 表示「只是更新记录」），
 * 所以返回 `null` 而不是摆一行空条目。
 */
function toRegistration(raw: SupplyLedgerProjectWire): PoolRegistration | null {
  const target = (raw.target ?? '').trim();
  const account = (raw.account ?? '').trim();
  if (!target && !account) return null;
  const at = typeof raw.at === 'number' ? raw.at : 0;
  return {
    target,
    account,
    state: registrationState(raw.outcome),
    // 后端没记时间就是没有（`null`），不拿 `now` 顶替 —— 那是编造数据。
    registeredAt: at > 0 ? new Date(at * 1000).toISOString() : null,
  };
}

/** 后端一条身份 → 池里的一行。 */
export function toPoolEntry(raw: SupplyLedgerWire): PoolEntry {
  const used = typeof raw.last_used === 'number' ? raw.last_used : 0;
  const projects: PoolRegistration[] = [];
  for (const item of Array.isArray(raw.projects) ? raw.projects : []) {
    const registration = toRegistration(item);
    if (registration) projects.push(registration);
  }
  const kind: SupplyKind = raw.kind === 'phone' ? 'phone' : 'email';
  // 域只对邮箱成立：基座报了 `domain` 就以它为准（地址可能只是别名），没报就从地址里取。
  // 手机号没有「收信的域」，留空，不拿别的字段凑。
  const declaredDomain = (raw.domain ?? '').trim().toLowerCase();
  return {
    kind,
    identity: raw.address ?? '',
    domain: kind === 'email' ? declaredDomain || addressDomain(raw.address ?? '') : '',
    channelId: (raw.channel_id ?? '').trim(),
    source: raw.source ?? '',
    sourceDetail: sourceDetail(kind, raw.meta),
    account: raw.account ?? '',
    platform: raw.target ?? '',
    state: poolState(raw),
    // 后端没记时间就是没有（`null`），不拿 `now` 顶替 —— 那是编造数据。
    lastUsedAt: used > 0 ? new Date(used * 1000).toISOString() : null,
    projects,
    mailbox: toPoolMailbox(raw.mailbox),
  };
}

/**
 * 这个身份在渠道内部来自哪一项。
 *
 * 两类各自记账：手机号记的是平台的**对接码**（同一平台下有好几条线，只有它说得清
 * 这个号从哪条线来），邮箱记的是**域**。键名不同是因为这两件事本来就不同，不是
 * 同一件事的两个叫法 —— 所以按类别取，取不到就是空，不互相顶替。
 */
function sourceDetail(kind: SupplyKind, meta: Record<string, unknown> | undefined): string {
  const key = kind === 'phone' ? 'channel' : 'domain';
  const value = meta?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 一个邮箱地址**在哪收信**：最后一个 `@` 之后的那一段。
 *
 * 买来的 `yundxr60804@outlook.com` 和自建 catch-all 的 `abc123@ormnes.com` 在这里
 * 是同一件事 —— 一个地址，一个收信的域。取不出来就是空字符串：不拿渠道的域顶替，
 * 那是另一条记录的事实。
 */
function addressDomain(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).trim().toLowerCase() : '';
}

/**
 * 后端一个邮箱块 → 页面形状。
 *
 * `has_credential` 缺席时给 `null` 而不是 `false`：主密码锁着的时候基座报不出条目名，
 * 那是「此刻判断不了」，不是「凭据没了」。把前者说成后者，人会去重新导入一个好好的号。
 */
function toPoolMailbox(raw: SupplyLedgerMailboxWire | undefined): PoolMailbox | null {
  if (!raw) return null;
  const nature = raw.nature;
  if (!nature) return null;
  return {
    nature,
    endpoint: (raw.endpoint ?? '').trim(),
    hasCredential: typeof raw.has_credential === 'boolean' ? raw.has_credential : null,
  };
}

/**
 * 一个身份现在**通不通** —— 只有三种答案：在线 / 离线 / 未知。
 *
 * 台账的一行是一个可以拿来用的身份，所以要回答的就是「现在能不能用」，而不是
 * 「它的凭据在不在」。凭据在只说明它有资格连，没连过就说不出通不通，那只能是未知。
 *
 * 两种身份的问法不同：
 * - 渠道发出来的：问那条渠道的探活结果（基座真发过一次请求）。任一种连接方式
 *   通就算在线 —— 手机号只要 API 通就能取码，网页登录断了不影响取号。
 * - 自带凭据的邮箱：它没有渠道可问，只能连它自己的信箱（`mailboxProbe`）。连上了
 *   就是在线，连不上就是离线；凭据读不到时基座什么都没试，那仍是未知 —— 把「没测成」
 *   说成「连不上」，人会去换一个其实好好的号。
 */
export function identityState(
  mailbox: PoolMailbox | null,
  declared: SupplyNature[],
  probe: Partial<Record<SupplyNature, SupplyProbeState>> | undefined,
  mailboxProbe?: MailboxProbe
): ConnectionState {
  const unknown: ConnectionState = { key: 'sms_service.pool_state_unknown', tone: 'tagMuted' };
  if (mailbox) {
    if (mailboxProbe?.state === 'online') {
      return { key: 'sms_service.pool_state_online', tone: 'tagGood', detail: mailboxProbe.detail };
    }
    if (mailboxProbe?.state === 'offline') {
      return {
        key: 'sms_service.pool_state_offline',
        tone: 'tagWarning',
        detail: mailboxProbe.detail,
      };
    }
    // 没测过（或测不成）：只有「凭据确定不在」这一种情况能断定它连不上。
    if (mailbox.hasCredential === false) {
      return { key: 'sms_service.pool_state_offline', tone: 'tagWarning' };
    }
    return mailboxProbe?.detail ? { ...unknown, detail: mailboxProbe.detail } : unknown;
  }
  if (declared.length === 0) return unknown;
  if (declared.some((nature) => probe?.[nature] === 'online')) {
    return { key: 'sms_service.pool_state_online', tone: 'tagGood' };
  }
  if (declared.some((nature) => probe?.[nature] === 'offline')) {
    return { key: 'sms_service.pool_state_offline', tone: 'tagWarning' };
  }
  return unknown;
}

/** 批量归一化池记录。 */
export function toPool(list: SupplyLedgerWire[] | undefined): PoolEntry[] {
  if (!Array.isArray(list)) return [];
  return list.map(toPoolEntry);
}

/**
 * 一条台账记录**最后一次动过**的时刻。
 *
 * 后端没有单独的「更新时间」：它记的是两个具体事件 —— 这个身份最后一次被拿去用
 * （`last_used`），以及它最近一次注册（每条注册记录各自的 `at`）。取其中较晚的那个，
 * 回答的是「这条记录什么时候变过」。
 *
 * 两个时间都没记（或都读不成时间）就是 `null`：不拿「刚导进来」冒充一次更新。
 */
export function latestPoolActivity(entry: PoolEntry): string | null {
  const times: number[] = [];
  const remember = (iso: string | null): void => {
    if (!iso) return;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) times.push(ms);
  };
  remember(entry.lastUsedAt);
  for (const project of entry.projects) remember(project.registeredAt);
  if (times.length === 0) return null;
  return new Date(Math.max(...times)).toISOString();
}

/**
 * 一个平台在台账里叫什么。
 *
 * 与登录凭据列表共用同一份名字：站点键走 `resolveCredentialSite`（产品名，与卡片
 * 徽标一致），其余走 `auth_files.filter_*`。所以同一个平台在两个页面上叫同一个
 * 名字。查不到就用后端给的原始 id 首字母大写 —— 不另编一个名字。
 */
export function projectLabel(target: string, translate: (key: string) => string): string {
  const id = target.trim();
  if (!id) return '';
  const site = projectSite(id);
  if (site) return site.brand;
  const key = `auth_files.filter_${normalizeOAuthProviderKey(id)}`;
  const translated = translate(key);
  if (translated !== key) return translated;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * 一个平台对应哪个站点 —— 与凭证卡片「站点」行是同一份映射，不是另抄一份。
 *
 * 台账要回答「这个号注册在哪个站点」，卡片要回答「这张凭证属于哪个站点」；两边
 * 问的是同一件事，所以必须查同一张表，否则同一个号在两个页面上会显示成两个站点。
 *
 * 没有映射就是 `null`（不造站点）。例如 loomy：模型在 `loomyad.xunfei.cn`、账号在
 * `account.xfinfr.com`，没有单一的站点域名，填任何一个都是把内部接口当站点；而它
 * 只有一个注册通道，域名也不承担区分作用，所以按品牌名显示就够。
 */
export function projectSite(target: string): CredentialSite | null {
  const id = target.trim();
  if (!id) return null;
  return resolveCredentialSite(normalizeOAuthProviderKey(id));
}

/**
 * 一条渠道在某个接入方式上的连通状态，折算成「一句话 + 一个色调」。
 *
 * 渠道池与台账共用：同一行在两个页面上说的必须是同一句话，否则操作者会以为
 * 其中一个是错的。`declared` 是渠道声明的接入方式，`probe` 是探活结果。
 */
export interface ConnectionState {
  /** i18n 键。 */
  key: string;
  /** i18n 参数。 */
  params?: Record<string, string>;
  /** 着色用的样式名（`tagGood` / `tagWarning` / `tagMuted`）。 */
  tone: 'tagGood' | 'tagWarning' | 'tagMuted';
  /** 一句补充说明（悬停可见）；`undefined` = 没有可说的，不摆空提示。 */
  detail?: string;
}

export function connectionState(
  declared: SupplyNature[],
  probe: Partial<Record<SupplyNature, SupplyProbeState>> | undefined,
  natureLabel: (nature: SupplyNature) => string
): ConnectionState {
  if (declared.length === 0) return { key: 'sms_service.pool_probe_none', tone: 'tagMuted' };
  const online = declared.filter((nature) => probe?.[nature] === 'online');
  const offline = declared.filter((nature) => probe?.[nature] === 'offline');
  const labels = (list: SupplyNature[]) => list.map(natureLabel).join(' + ');
  if (online.length === declared.length) {
    return {
      key: 'sms_service.pool_probe_online',
      params: { natures: labels(online) },
      tone: 'tagGood',
    };
  }
  if (online.length > 0) {
    return {
      key: 'sms_service.pool_probe_partial',
      params: { natures: labels(online) },
      tone: 'tagWarning',
    };
  }
  if (offline.length > 0) {
    return {
      key: 'sms_service.pool_probe_offline',
      params: { natures: labels(offline) },
      tone: 'tagWarning',
    };
  }
  if (declared.some((nature) => probe?.[nature] === 'unready')) {
    return { key: 'sms_service.pool_probe_unready', tone: 'tagMuted' };
  }
  if (declared.some((nature) => probe?.[nature] === 'unsupported')) {
    return { key: 'sms_service.pool_probe_unsupported', tone: 'tagMuted' };
  }
  return { key: 'sms_service.pool_probe_unchecked', tone: 'tagMuted' };
}
