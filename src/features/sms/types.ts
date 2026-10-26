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
  /**
   * 预置平台已知的类别（自定义平台为空）。
   *
   * 平台是内置的，它的类别就不是使用者的选择题 —— 写在这里，编辑器据此带出默认值，
   * 而不是在组件里另写一份「豪猪 = 第三方服务」。
   */
  defaultCategory?: string;
  /**
   * 预置平台支持的接入方式（自定义平台为空）。
   *
   * 平台卡片上写的就是这个事实（「用 API 接入取号，用网页登录管理渠道」），
   * 所以新增渠道时应当按它勾好，使用者不必自己再猜该勾哪几个。
   */
  defaultNatures?: SupplyNature[];
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
export type SupplyNature = 'api' | 'imap' | 'oauth2' | 'graph' | 'web';

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
  domain: string;
  /** OAuth2 的应用 ID。它不是秘密（刷新令牌才是），所以随渠道记录读回。 */
  clientId: string;
  /**
   * 这条连接绑在代理池的第几条出口；`0` = 没单独指定，跟随供应整体出口。
   *
   * 一条渠道可能同时有手机号块和邮箱块，各块可以走不同出口，所以出口挂在连接上，
   * 不挂在渠道上。
   */
  egressId: number;
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
  /**
   * 这条渠道已经往供应池送了几个身份，按类别分。
   *
   * `undefined` = 后端报不出计数（没有供应池可数），与 `0`（数过，是零个）不同。
   */
  pooled: Partial<Record<SupplyKind, number>>;
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

/**
 * 一个身份注册过的一个平台（一次注册一条）。
 *
 * 这是台账里唯一回答「这个地址/号码到底用在了哪儿」的东西：身份本身只是一个地址，
 * 没有这几条记录就无从追溯。空列表 = 还没注册过任何平台，页面上不摆占位行。
 */
export interface PoolRegistration {
  /** 注册的平台（如 `loomy`）；`''` = 后端没记。 */
  target: string;
  /** 注册出来的账号（如 `loomy-16723433586`）；`''` = 没记。 */
  account: string;
  /** 这次注册的处置。 */
  state: PoolState;
  /** 注册时间（ISO 字符串）；`null` = 后端没记（不展示，不编造）。 */
  registeredAt: string | null;
}

/**
 * 一个自带凭据的邮箱身份怎么收信。
 *
 * 这类身份是**单独入池**的：一个地址一份凭据，读信不经过任何渠道。渠道发出来的
 * 身份没有这一块 —— 它读信靠渠道那条连接。
 */
export interface PoolMailbox {
  /** 收信方式。 */
  nature: SupplyNature;
  /** 收信服务器；Graph 没有这一项。 */
  endpoint: string;
  /** 凭据是否在密钥库里；`null` = 主密码没解锁，此刻判断不了（不猜）。 */
  hasCredential: boolean | null;
}

/**
 * 一个自带凭据的邮箱地址**现在打不打得开**（基座真连了一次得到）。
 *
 * 这种地址没有渠道可问，只能连它自己的信箱 —— 连上了就是能收信，连不上就是不能。
 * 凭据读不到时基座什么都不试，那是「没测成」，不是「连不上」，所以状态与原因分开记。
 */
export interface MailboxProbe {
  state: SupplyProbeState;
  /** 一句说明（失败原因 / 连上了几个文件夹）；`''` = 没有可说的。 */
  detail: string;
}

/** 池里的一条身份记录（哪个身份、从哪来、注册了哪些账号）。 */
export interface PoolEntry {
  /** 它属于哪一类身份（手机号 / 邮箱）。同一张台账里两类的列一样，靠它取对应种类块。 */
  kind: SupplyKind;
  /** 身份本身：号码或地址。 */
  identity: string;
  /**
   * 邮箱**在哪收信**的域（`outlook.com`，不带 `@`）；`''` = 取不出来，或是手机号。
   *
   * 买来的地址和自建 catch-all 的地址在这一格是同一件事：域就是它收信的地方。
   * 它**不是**来源 —— 哪条渠道把它送进来的才是来源。
   */
  domain: string;
  /** 记录指向的渠道 id；`''` = 后端没记（老记录）。 */
  channelId: string;
  /** 它来自哪个平台（后端记录的服务名，如 `haozhuma`）；`''` = 未记录。 */
  source: string;
  /**
   * 渠道内部**具体是哪一项**给了它：手机号是平台的对接码，邮箱是那个域。
   *
   * 「渠道」列只说得出「豪猪接码」；同一个平台下有好几条对接码时，只有这一项
   * 才说得清这个号是从哪条线来的。后端没记就是 `''`，不拿渠道名顶替。
   */
  sourceDetail: string;
  /** 它注册的账号；`''` = 还没绑定。 */
  account: string;
  /** 它注册的平台（如 `loomy`）；`''` = 未绑定。 */
  platform: string;
  state: PoolState;
  /** 最后一次使用时间（ISO 字符串）；`null` = 后端没记（不展示，不编造）。 */
  lastUsedAt: string | null;
  /** 这个身份注册过的平台，一次注册一条；空 = 还没注册过。 */
  projects: PoolRegistration[];
  /** 自带凭据的收信方式；`null` = 渠道发出来的身份（读信走渠道）。 */
  mailbox: PoolMailbox | null;
}

/* ---------------------------------------------------------------------------
 * 邮箱：收信邮箱与收件箱。
 *
 * 邮箱这一类的形态与手机号不同 —— 它不「取号」，而是**读一个已有的邮箱**。
 * 一个邮箱可以承接很多收件地址（多个自建域的 catch-all 全转进同一个信箱），
 * 所以「按地址找信」是常态，而不是特例。
 * ------------------------------------------------------------------------- */

/** 一个已配置的收信邮箱。 */
export interface EmailMailbox {
  /** 渠道 id。 */
  channelId: string;
  /** 渠道标签（给人看的名字）。 */
  label: string;
  /** 登录这个邮箱的账号；`''` = 没填。 */
  mailbox: string;
  /** 收信服务器。 */
  host: string;
  /** 自建域：catch-all 落在哪个域；个人邮箱为空。 */
  domain: string;
  /** 用途：`personal` / `self-domain`。 */
  usage: 'personal' | 'self-domain';
  /** 凭据在密钥库里的条目名（不是值）。 */
  secretName: string;
  /** 授权码是否已存好。 */
  hasCredential: boolean;
}

/** 收件箱里的一封邮件。 */
export interface EmailMessage {
  /** 它来自哪条渠道的信箱。 */
  channelId: string;
  /** 它来自哪个文件夹（INBOX / 垃圾邮件）。 */
  mailbox: string;
  /** 发件人；`''` = 没解析到。 */
  from: string;
  /** 收件地址（转发时可能不止一个）。 */
  to: string[];
  subject: string;
  /** 收信时间（ISO 字符串）；`null` = 后端没拿到日期（不展示，不编造）。 */
  receivedAt: string | null;
  /** 提取出的验证码；`''` = 这封信没有码。 */
  code: string;
  /** 正文摘录（基座给的是单行、最多 240 字节，末尾带省略号）。 */
  preview: string;
  /** 信里出现的链接；`[]` = 没有。 */
  links: string[];
}

/** 一条渠道的信箱这次读到了什么。 */
export interface EmailInboxSummary {
  channelId: string;
  label: string;
  /** 登录这个邮箱的账号。 */
  mailbox: string;
  /** 自建域：catch-all 落在哪个域；个人邮箱为空。 */
  domain: string;
  /** 这次窗口里寄给所查地址的信有几封。 */
  count: number;
  /** 最新的一封；没有信时 `null`。 */
  latest: EmailMessage | null;
  /** 这个信箱读不到的原因；`''` = 读到了。 */
  error: string;
}

/** 一次收件箱读取：每条渠道各自的收信情况。 */
export interface EmailInboxReading {
  mailboxes: EmailInboxSummary[];
  /** 这次往前看了多少小时 —— 「近 N 封」里的 N 以它为准，不由页面假设。 */
  windowHours: number;
}

/**
 * 渠道池里**一行下面那条状态带**的内容。
 *
 * 状态带属于这一条渠道，所以这里只有「这条渠道现在怎么样」：能不能读、最新一封是
 * 什么、平台余额多少。它不是收件箱 —— 收件箱是给人翻的列表，这里只回答「需不需要
 * 管它」。这条渠道往供应池送了多少身份不在这里：那是台账数出来的，随渠道清单一起
 * 回来，与平台读得通不通无关。
 */
export type ChannelStatus =
  /** 还没读到（首次加载 / 正在读）。 */
  | { kind: 'loading' }
  /** 这一类在这条渠道上是关的：基座不会去读它。 */
  | { kind: 'disabled' }
  /** 密钥库锁着：凭据读不到，不是「没配」。 */
  | { kind: 'locked' }
  /** 凭据没存好（或配置不全），基座读不了这个信箱。 */
  | { kind: 'unready' }
  /** 读了但失败了：把原因原样说出来，不冒充「没有信」。 */
  | { kind: 'error'; message: string }
  /** 邮箱：读的是哪个信箱、最新一封是什么。 */
  | {
      kind: 'email';
      mailbox: string;
      domain: string;
      latest: EmailMessage | null;
    }
  /** 手机号：平台余额与最近一次取号时间。 */
  | {
      kind: 'phone';
      balanceCny: number | null;
      balanceError: string;
      latestAt: string | null;
    };

