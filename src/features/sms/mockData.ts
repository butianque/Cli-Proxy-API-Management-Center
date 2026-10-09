/**
 * 接码服务：占位数据（mock）。
 *
 * ⚠️ 本文件是**临时脚手架**：页面第一版只做结构与视觉，数据全部来自这里，
 * 不发起任何真实请求。接入真实数据时删除本文件，改由
 * src/services/api/sms.ts 归一化后端响应。
 *
 * mock 数值取自 2026-10-10 的**真实实测**（豪猪 API 余额 2.42 元、最低渠道
 * 0.13 元、两次真实取号 0.33 / 0.44 元），以便视觉上贴近真实量级。
 */

import type {
  ChannelHealth,
  ConfiguredPlatform,
  PhoneLedgerEntry,
  SmsChannel,
  SmsPlatform,
  SmsStatus,
} from './types';

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

/** 返回一份 mock 的服务状态快照。 */
export function getMockSmsStatus(): SmsStatus {
  return {
    enabled: true,
    unlocked: true,
    defaultChannel: '讯飞',
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
    summary: '已对接，支持账号登录 / API 两种连接方式',
    preset: true,
    modes: ['account', 'api'],
    defaultEndpoint: 'https://api.haozhuma.cn',
  },
  {
    id: 'custom',
    name: '自定义',
    summary: '接入其他接码平台，自行填写 API 地址与凭据',
    preset: false,
    modes: ['api'],
  },
];

/** 返回一份 mock 的「已配置渠道」（L4）。 */
export function getMockConfiguredPlatforms(): ConfiguredPlatform[] {
  return [
    {
      platformId: 'haozhuma',
      platformName: '豪猪接码',
      mode: 'account',
      endpoint: 'https://api.haozhuma.cn',
      account: 'linhua888',
      enabled: true,
      connected: true,
    },
  ];
}
