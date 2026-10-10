/**
 * 接码服务页的占位数据（**下一轮接真实后端**）。
 *
 * 约定：这里只放「后端还没有对应字段」的东西；一旦后端能返回，就删掉对应占位。
 * 当前仍是占位的：渠道表（单价/库存/用量）、号码账本、服务启停、护栏开关。
 * 已接线（不在本文件）：主密码门、账密/CK 是否已存、真实余额、消费护栏上限。
 *
 * ⚠️ 这里的文案面向使用者，不暴露后端字段名（api_user / PHPSESSID / CK 等）。
 */

import type {
  ChannelHealth,
  PhoneLedgerEntry,
  SmsChannel,
  SmsPlatform,
  SmsStatus,
} from './types';

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

/** 渠道健康度 → 由成功率和延迟推导（占位：可换成后端字段）。 */
function deriveHealth(successRate: number, latencyMs: number): ChannelHealth {
  if (successRate >= 0.9 && latencyMs <= 4000) return 'good';
  if (successRate >= 0.7 && latencyMs <= 8000) return 'warning';
  return 'critical';
}

const CHANNEL_SEED: Array<{
  id: string;
  name: string;
  priceCny: number;
  stock: number;
  successRate: number;
  latencyMs: number;
  paused: boolean;
}> = [
  {
    id: 'ch-21614-k3',
    name: '讯飞 · 21614-K3YRTDXCSL',
    priceCny: 0.13,
    stock: 42,
    successRate: 0.96,
    latencyMs: 3100,
    paused: false,
  },
  {
    id: 'ch-21614-fp',
    name: '讯飞 · 21614-FPM36FDX4H',
    priceCny: 0.18,
    stock: 17,
    successRate: 0.88,
    latencyMs: 4600,
    paused: false,
  },
  {
    id: 'ch-58562-oe',
    name: '稀土掘金/Trae · 58562-OEIO5JKMZH',
    priceCny: 0.18,
    stock: 9,
    successRate: 0.72,
    latencyMs: 7800,
    paused: false,
  },
  {
    id: 'ch-69454-42',
    name: '商汤 · 69454-428K8MRUKD',
    priceCny: 1.1,
    stock: 0,
    successRate: 0.5,
    latencyMs: 9200,
    paused: true,
  },
];

const LEDGER_SEED: PhoneLedgerEntry[] = [
  {
    phone: '16723433586',
    account: 'loomy-16723433586',
    channel: '讯飞 · 21614-K3YRTDXCSL',
    costCny: 0.33,
    status: 'registered',
    takenAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
  },
  {
    phone: '17158732844',
    account: 'loomy-17158732844',
    channel: '讯飞 · 21614-K3YRTDXCSL',
    costCny: 0.44,
    status: 'registered',
    takenAt: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
  },
  {
    phone: '19120441208',
    account: 'loomy-pending',
    channel: '稀土掘金/Trae · 58562-OEIO5JKMZH',
    costCny: 0.18,
    status: 'pending',
    takenAt: new Date(Date.now() - 1000 * 60 * 6).toISOString(),
  },
];

/** 生成一份占位总览（真实字段缺失时回退用）。 */
export function getMockSmsStatus(): SmsStatus {
  const channels: SmsChannel[] = CHANNEL_SEED.map((seed) => ({
    id: seed.id,
    name: seed.name,
    detail: seed.name,
    priceCny: seed.priceCny,
    stock: seed.stock,
    successRate: seed.successRate,
    latencyMs: seed.latencyMs,
    paused: seed.paused,
    health: deriveHealth(seed.successRate, seed.latencyMs),
  }));

  const availableChannels = channels.filter((channel) => !channel.paused && channel.stock > 0).length;

  return {
    enabled: true,
    balanceCny: null, // 真实余额由后端给；null = 未取到
    balanceError: undefined,
    sessionSpendCny: 0.95,
    priceCeilingCny: 0.5,
    maxTotalCny: 20,
    guardrail: true,
    availableChannels,
    totalChannels: channels.length,
    channels,
    ledger: LEDGER_SEED,
    updatedAt: new Date().toISOString(),
  };
}
