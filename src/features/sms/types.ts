/**
 * 接码服务：页面领域类型。
 *
 * 本文件只描述「面板要展示什么」，不描述后端传输结构。
 * 后端契约由 `smsMapping.ts` 归一化成这些类型，组件不直接接触后端字段名。
 *
 * ⭐ 概念分层（用户 2026-10-10 拍板，详见 docs/ops/20、21）：
 * - **L1 平台清单**：可选平台（豪猪 / 自定义）——只读；
 * - **L3 平台连接**：同一平台的两种登录方式（API 接入 / 网页登录）——用户数据；
 * - **L4 渠道配置**：某平台内部取了哪些号源（SmsChannel）——平台侧数据；
 * - **L5 运行时**：余额 / 账本 / 护栏 / 启停。
 *
 * ⚠️ 两条路径的语义（2026-10-17 修正：不再互斥，改为**多选**）：
 *   - **API 接入** = API 账号 + API 密码（+ 可选服务地址）→ 取号/收码（数据面）；
 *   - **网页登录** = 网页账号 + 网页密码 → 换取网页会话 → 管渠道（控制面）。
 *   豪猪**两条都要**。基座把接入方式当成**集合**（`natures`），渠道池表「连接方式」
 *   那一列显示的就是这个集合；所以编辑器也做成多选（勾几种配几种），而不是互斥 Tab
 *   —— 互斥 Tab 表达不了「API 接入 + 网页登录同时开」，会跟自己的表自相矛盾。
 *
 * ⚠️ 手机号这一类**只有一份**平台凭据（存在密钥库，条目名由基座配置持有）。渠道记录
 * 里的连接只**指名**它，不存它的值；编辑器也不接触条目名（由基座保存渠道时盖章）。
 */

/** 渠道健康度，用于颜色联动（绿 / 黄 / 红）。 */
export type ChannelHealth = 'good' | 'warning' | 'critical';

/** 平台清单里的一项（L1：世界上有哪些平台可选，只读）。 */
export interface SmsPlatform {
  /** 平台 ID，与后端 provider id 对齐（`haozhuma` / `custom`）。 */
  id: string;
  /** 平台展示名的 i18n 键。 */
  nameKey: string;
  /** 一句话说明的 i18n 键。 */
  summaryKey: string;
  /** 是否预置平台。预置 = 已知协议、有默认值；`custom` = 用户自填。 */
  preset: boolean;
  /** 预置平台的默认 API 地址（自定义平台为空）。 */
  defaultEndpoint?: string;
}

/** 与平台的连接状态。 */
export type PlatformConnection =
  /** 真实联网成功（拿到余额）。 */
  | 'connected'
  /** 真实联网失败（凭据无效 / 网络）。 */
  | 'failed'
  /** 凭据没读到（密钥库锁着 / 没存）。 */
  | 'unavailable'
  /** 尚未检查。 */
  | 'unchecked';

/** 一个可用的取号渠道（L4：平台内部的号源/对接码）。 */
export interface SmsChannel {
  /** 渠道 ID（后端 uid）。 */
  id: string;
  /** 渠道展示名（简短，如「移动/联通」）。 */
  name: string;
  /** 渠道完整说明（运营商 + 全部号段），用于悬停查看。 */
  detail: string;
  /** 实际取号单价（元）。 */
  priceCny: number;
  /** 当前库存（可用号码数）。 */
  stock: number;
  /** 是否处于暂停状态（省钱手段：暂停贵的 / 无货的）。 */
  paused: boolean;
  /** 健康度：由单价、库存、暂停状态推导，驱动字色/色块。 */
  health: ChannelHealth;
}

/** 号码账本的一行（哪个账号用了哪个号码）。 */
export interface PhoneLedgerEntry {
  /** 号码。 */
  phone: string;
  /** 该号码服务的账号标识。 */
  account: string;
  /** 取号渠道名。 */
  channel: string;
  /** 实际花费（元）；`null` 表示后端未记录该条成本（不展示，不编造）。 */
  costCny: number | null;
  /** 取号时间（ISO 字符串）；`null` 表示后端没记这次取号的时间（不展示，不编造）。 */
  takenAt: string | null;
  /** 结果状态。 */
  /** 号码注册的平台，如 `loomy`。 */
  target: string;
  status: 'registered' | 'pending' | 'failed';
}

/**
 * 接码服务的整体运行快照（L3 + L5，`/sms/status` 归一化后的形状）。
 *
 * 页面只用这一个对象：后端给什么就是什么，没有的字段为空值，不拿假数据兜底。
 * 「渠道数 / 超标数」这类**可推导**的读数不在这里存，由页面按渠道列表算，
 * 免得同一件事有两个来源、彼此对不上。
 */
export interface SmsStatusView {
  /**
   * 后端是否已经返回过一次真实快照。
   *
   * `false` = 还没读到（首屏加载中 / 加载失败）。此时页面上的金额与计数**一律显示
   * `—`**，而不是把空态里的 0 当成真实读数 —— 把「没读到」渲染成 `¥0.00` 是编造数据
   * （见 AGENTS.md「不造假数据」）。`true` 之后的 0 才是真的 0。
   */
  loaded: boolean;
  /** 服务是否启用（后端已配置接码平台）。 */
  enabled: boolean;
  /** 密钥库锁定 → 凭据读数不可读（**不等于**「没配过」）。 */
  storeLocked: boolean;
  /** API 账号是否已配置（锁定态下后端读不到，一律 false）。 */
  accountPresent: boolean;
  /** 网页会话是否已配置。 */
  cookiePresent: boolean;
  /** 网页登录账号是否已随账密存好。 */
  webPresent: boolean;
  /** 已存 API 账号的脱敏提示，仅解锁态有值。 */
  apiUserHint: string;
  /** 已存网页账号的脱敏提示，仅解锁态有值。 */
  webUserHint: string;
  /**
   * 配置里认的那个平台（后端 `provider`，如 `haozhuma`）。
   *
   * 已存凭据属于**它**。编辑器据此判断「当前选的平台」是不是凭据的主人 —— 选了别的
   * 平台却还显示它的脱敏账号，就是在拿别人的凭据当提示。
   */
  provider: string;
  /** 与平台的连接状态。 */
  connection: PlatformConnection;
  /** 连接失败 / 不可读的原因。 */
  connectionReason?: string;
  /** 账户余额（元）；锁定态或尚未成功联网 = `null`。 */
  balanceCny: number | null;
  /** 本次会话已花费（元）。 */
  spentCny: number;
  /** 单次取号单价上限（元）；`0` = 未配置。 */
  ceilingCny: number;
  /** 累计花费上限（元）。 */
  maxTotalCny: number;
  /** 渠道列表。 */
  channels: SmsChannel[];
  /** 号码账本。 */
  ledger: PhoneLedgerEntry[];
  /** 数据快照时间（ISO 字符串）；`''` = 后端未给。 */
  updatedAt: string;
}

/**
 * 手机号类别的平台凭据现状：编辑器据此决定脱敏占位符与「留空保留」提示。
 *
 * 这里描述的是**平台凭据**，不是「某条渠道的凭据」—— 手机号这一类只有一份平台凭据。
 * 邮箱类别没有这份东西，传 `null`。
 */
export interface PhoneCredentialState {
  /** 已存凭据属于哪个平台（配置里的 `provider`）。 */
  provider: string;
  /** API 账号是否已存在。 */
  apiPresent: boolean;
  /** 网页登录账号是否已随账密存好。 */
  webPresent: boolean;
  /** 网页会话（CK）是否已存在。 */
  cookiePresent: boolean;
  /** 已存 API 账号的脱敏提示；仅解锁态有值。 */
  apiUserHint: string;
  /** 已存网页账号的脱敏提示；仅解锁态有值。 */
  webUserHint: string;
}

/* ---------------------------------------------------------------------------
 * 来源（渠道）与池：手机号与邮箱**共用**的一套形状。
 *
 * 一条**来源** = 标签 + 性质 + 连接信息。标签是给人看、给人选的；性质（我们怎么连它）
 * 决定连接表单，也决定池的样式 —— 所以两者分开，改名不动实现。
 * ------------------------------------------------------------------------- */

/** 身份种类。 */
export type SupplyKind = 'phone' | 'email';

/** 接入性质：我们怎么连它。 */
export type SupplyNature = 'api' | 'imap' | 'web';

/** 基座允许的一种性质，以及它能服务哪些身份种类（由后端给出，页面不自己维护一份）。 */
export interface SupplyNatureOption {
  nature: SupplyNature;
  kinds: SupplyKind[];
}

/** 一条连接方式的连接信息（UI 侧）。 */
export interface SupplyConnection {
  endpoint: string;
  account: string;
  secret: string;
  secretPresent: boolean;
  usage: string;
  domain: string;
}

/** 一个种类块（UI 侧）。 */
export interface SupplyKindConfig {
  enabled: boolean;
  natures: SupplyNature[];
  connections: Partial<Record<SupplyNature, SupplyConnection>>;
}

/** 一条已配置的渠道。可以同时服务手机号和邮箱。 */
export interface SupplyChannel {
  id: string;
  label: string;
  category: string;
  phone: SupplyKindConfig | null;
  email: SupplyKindConfig | null;
}

/** 一条渠道的某一种连接方式**能不能真连上**（由基座真发一次请求得到）。 */
export type SupplyProbeState =
  /** 真发了一次请求且成功。 */
  | 'online'
  /** 真发了但失败。 */
  | 'offline'
  /** 这一种连接方式需要的凭据读不到（没存 / 密钥库锁着）—— 不等于连不上。 */
  | 'unready'
  /** 基座还没有这一类连接方式的探活实现（邮箱那类尚未落地）。 */
  | 'unsupported';

/** 一条渠道的探活结果：按连接方式分别给状态。 */
export interface SupplyProbeResult {
  id: string;
  natures: Partial<Record<SupplyNature, SupplyProbeState>>;
}

/** 池里一条身份的处置。 */
export type PoolState = 'registered' | 'pending' | 'released' | 'failed';

/** 池里的一条身份记录（哪个身份、从哪来、注册了哪个账号）。 */
export interface PoolEntry {
  /** 身份本身：号码或地址。 */
  identity: string;
  /** 它来自哪条来源（后端记录的名字）；`''` = 未记录。 */
  source: string;
  /** 它注册的账号；`''` = 还没绑定。 */
  account: string;
  /** 它注册的平台（如 `loomy`）；`''` = 未绑定。 */
  platform: string;
  state: PoolState;
  /** 最后一次使用时间（ISO 字符串）；`null` = 后端没记（不展示，不编造）。 */
  lastUsedAt: string | null;
}

