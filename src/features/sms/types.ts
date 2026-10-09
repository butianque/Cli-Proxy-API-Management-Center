/**
 * 接码服务：页面领域类型。
 *
 * 本文件只描述「面板要展示什么」，不描述后端传输结构。
 * 后端契约（插件 /v0/management/plugins/loomy/sms/status 与后续基座
 * /v8/management/sms/*）在接入时由 src/services/api/sms.ts 归一化成这些类型，
 * 组件不直接接触后端字段名。
 */

/** 渠道健康度，用于颜色联动（绿 / 黄 / 红）。 */
export type ChannelHealth = 'good' | 'warning' | 'critical';

/** 一个可用的取号渠道。 */
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

/** 接码服务的整体运行状态快照。 */
export interface SmsStatus {
  /** 服务是否启用。 */
  enabled: boolean;
  /** 密钥库是否已解锁（凭证是否可用）。 */
  unlocked: boolean;
  /** 当前默认渠道名。 */
  defaultChannel: string;
  /** 账户余额（元）。 */
  balanceCny: number;
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
