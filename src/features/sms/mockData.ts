/**
 * 接码服务：平台清单 与 未接线部分的占位数据（mock）。
 *
 * ⚠️ 本文件里**渠道表 / 号码账本仍为占位**（那两块尚未接后端，属下一轮）；
 * 凭据（账密表 / CK 表）与服务状态已改为真实后端，见 src/services/api/sms.ts。
 *
 * mock 数值取自 2026-10-10 的**真实实测**（豪猪 API 余额 2.42 元、最低渠道
 * 0.13 元、两次真实取号 0.33 / 0.44 元），以便视觉上贴近真实量级。
 */

import type { ChannelHealth, PhoneLedgerEntry, SmsChannel, SmsStatus, SmsPlatform } from './types';

/** 由单价、库存、暂停状态推导健康度，供颜色联动使用。 */
export function deriveChannelHealth(channel: {
  priceCny: number;
  stock: number;
  paused: boolean;
}): ChannelHealth {
  if (channel.stock <= 0 || channel.paused) return 'critical';
  if (channel.priceCny > 0.5 || channel.stock < 5) return 'warning';
  return 'good';
}

const mockChannels: SmsChannel[] = [
  { id: '8e41d296bf0c4969', name: '讯飞', priceCny: 0.13, stock: 42, paused: false, usedCount: 0 },
  { id: 'c1a4f7d2e9b04a13', name: '橙子', priceCny: 0.28, stock: 17, paused: false, usedCount: 1 },
  { id: '37be5c9a1f2d6840', name: '草原', priceCny: 0.33, stock: 9, paused: false, usedCount: 1 },
  { id: 'a90e3b7f5c284d61', name: '雷神', priceCny: 0.44, stock: 3, paused: false, usedCount: 1 },
  { id: '5d2f8a1c6b39407e', name: '飞狐', priceCny: 0.72, stock: 28, paused: true, usedCount: 0 },
  { id: 'e7b1c40d9a365f82', name: '蓝鲸', priceCny: 1.05, stock: 0, paused: true, usedCount: 0 },
].map((channel) => ({ ...channel, health: deriveChannelHealth(channel) }));

const mockLedger: PhoneLedgerEntry[] = [
  {
    phone: '16723433586',
    account: 'loomy-16723433586',
    channel: '草原',
    costCny: 0.33,
    takenAt: '2026-10-09T14:22:10+08:00',
    status: 'registered',
  },
  {
    phone: '17158732844',
    account: 'loomy-17158732844',
    channel: '雷神',
    costCny: 0.44,
    takenAt: '2026-10-09T15:07:48+08:00',
    status: 'registered',
  },
  {
    phone: '16500219947',
    account: 'loomy-16500219947',
    channel: '橙子',
    costCny: 0.28,
    takenAt: '2026-10-10T09:41:03+08:00',
    status: 'pending',
  },
];

/**
 * 返回一份**占位**的运行时快照（渠道 / 账本尚未接后端）。
 * 凭据是否已连接由真实 `/sms/status` 决定，不在此处。
 */
export function getMockSmsStatus(): SmsStatus {
  return {
    enabled: true,
    balanceCny: 2.42,
    sessionSpendCny: 1.05,
    priceCeilingCny: 0.5,
    maxTotalCny: 20,
    guardrail: true,
    availableChannels: mockChannels.filter((channel) => !channel.paused && channel.stock > 0)
      .length,
    totalChannels: mockChannels.length,
    channels: mockChannels,
    ledger: mockLedger,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 平台清单（L1）：可选的接码平台。
 *
 * 本轮只有豪猪一个真实平台 + 一个「自定义」兜底。未来加平台只需往这里加一项，
 * 弹窗的「选择平台」区会自动出现。
 */
export const SMS_PLATFORMS: SmsPlatform[] = [
  {
    id: 'haozhuma',
    name: '豪猪接码',
    summary: '已对接：账密表取号，CK 表管渠道',
    preset: true,
    defaultEndpoint: 'https://api.haozhuma.cn',
  },
  {
    id: 'custom',
    name: '自定义',
    summary: '接入其他接码平台，自行填写 API 地址与凭据',
    preset: false,
  },
];
