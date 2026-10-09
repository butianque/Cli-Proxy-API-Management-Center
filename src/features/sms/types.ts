/**
 * 接码服务：页面领域类型。
 *
 * 本文件只描述「面板要展示什么」，不描述后端传输结构。
 * 后端契约由 src/services/api/sms.ts 归一化成这些类型，组件不直接接触后端字段名。
 *
 * ⭐ 概念分层（用户 2026-10-10 拍板，详见 docs/ops/20、21）：
 * - **L1 平台清单**：可选平台（豪猪 / 自定义）——只读；
 * - **L3 平台连接**：两类凭据表（账密表 / CK 表）——用户数据；
 * - **L4 渠道配置**：某平台内部取了哪些号源（SmsChannel）——平台侧数据；
 * - **L5 运行时**：余额 / 账本 / 护栏 / 启停。
 *
 * ⚠️ 关键澄清（用户原话「你的解释更偏向于技术，而非数据流语义」）：
 *   弹窗里不是「账号登录模式 / API 连接模式」二选一，而是**两张并存的凭据表**：
 *   - **账密表** = 账号 + 密码（+ 可选 API 地址）→ 取号/收码（数据面）；
 *   - **CK 表**   = Cookie（网页会话）→ 拉渠道 / 启停渠道（控制面）。
 *   豪猪**同时需要两者**，不是二选一。
 */

/** 渠道健康度，用于颜色联动（绿 / 黄 / 红）。 */
export type ChannelHealth = 'good' | 'warning' | 'critical';

/** 平台清单里的一项（L1：世界上有哪些平台可选，只读）。 */
export interface SmsPlatform {
  /** 平台 ID，与后端 provider id 对齐（`haozhuma` / `custom`）。 */
  id: string;
  /** 平台展示名。 */
  name: string;
  /** 一句话说明。 */
  summary: string;
  /** 是否预置平台。预置 = 已知协议、有默认值；`custom` = 用户自填。 */
  preset: boolean;
  /** 预置平台的默认 API 地址（自定义平台为空）。 */
  defaultEndpoint?: string;
}

/** 账密表（取号/收码用的账号密码；CK 表另存）。 */
export interface AccountCredential {
  /** API 账号（豪猪 `api_user`）。 */
  account: string;
  /** API 地址（可选；留空用平台默认）。 */
  endpoint: string;
  /** 是否已配置（后端 `api_present`）。 */
  present: boolean;
}

/** CK 表（网页会话 Cookie，用于拉渠道/启停渠道）。 */
export interface SessionCredential {
  /** 网页会话 Cookie（豪猪 `PHPSESSID`）。 */
  cookie: string;
  /** 是否已配置（后端 `cookie_present`）。 */
  present: boolean;
}

/** 一个已配置渠道的连接凭据快照（L3）。 */
export interface PlatformCredentials {
  /** 平台 ID。 */
  platformId: string;
  /** 平台展示名。 */
  platformName: string;
  /** 账密表。 */
  account: AccountCredential;
  /** CK 表。 */
  session: SessionCredential;
  /**
   * 连接状态：
   * - `connected`：真实联网成功（拿到余额）；
   * - `failed`：真实联网失败（凭据无效/网络）；
   * - `unavailable`：凭据没读到（密钥库锁着 / 没存）；
   * - `unchecked`：尚未检查。
   */
  status: 'connected' | 'failed' | 'unavailable' | 'unchecked';
  /** 状态原因（失败/不可用时）。 */
  statusReason?: string;
}

/** 一个可用的取号渠道（L4：平台内部的号源/对接码）。 */
export interface SmsChannel {
  /** 渠道 ID（后端 uid）。 */
  id: string;
  /** 渠道展示名，例如「讯飞」。 */
  name: string;
  /** 实际取号单价（元）。 */
  priceCny: number;
  /** 当前库存（可用号码数）。 */
  stock: number;
  /** 是否处于暂停状态（省钱手段：暂停贵的 / 无货的）。 */
  paused: boolean;
  /** 该渠道累计取号次数。 */
  usedCount: number;
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
  /** 实际花费（元）。 */
  costCny: number;
  /** 取号时间（ISO 字符串）。 */
  takenAt: string;
  /** 结果状态。 */
  status: 'registered' | 'pending' | 'failed';
}

/** 接码服务的整体运行状态快照（L5）。 */
export interface SmsStatus {
  /** 服务是否启用。 */
  enabled: boolean;
  /** 账户余额（元）；无值表示尚未成功联网。 */
  balanceCny: number | null;
  /** 联网取余额失败的原因。 */
  balanceError?: string;
  /** 本次会话已花费（元）。 */
  sessionSpendCny: number;
  /** 单次取号单价上限（元）。 */
  priceCeilingCny: number;
  /** 累计花费上限（元）。 */
  maxTotalCny: number;
  /** 省钱的唯一手段开关：暂停超标渠道。 */
  guardrail: boolean;
  /** 有货渠道数。 */
  availableChannels: number;
  /** 渠道总数。 */
  totalChannels: number;
  /** 渠道列表。 */
  channels: SmsChannel[];
  /** 号码账本。 */
  ledger: PhoneLedgerEntry[];
  /** 数据快照时间（ISO 字符串）。 */
  updatedAt: string;
}
