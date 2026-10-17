/**
 * 渠道草稿模型：一条渠道在两个类别上的可编辑形状，以及它与基座提交体之间的纯转换。
 *
 * 抽成独立模块是因为它有**三个**消费者：渠道编辑器（手机号与邮箱共用同一个组件）、
 * 渠道池表的启用开关、以及两个视图。留在一个视图文件里，另外两个就得反向依赖它。
 *
 * 这里只做形状转换：不发请求、不碰 i18n、不出现后端字段名（那些只在 `smsMapping.ts`）。
 */

import type {
  SupplyChannelInput,
  SupplyKindConfigInput,
  SupplyConnectionInput,
} from '@/services/api/supply';
import type { SupplyChannel, SupplyKind, SupplyNature } from './types';

/** 一种接入方式的连接信息草稿。 */
export interface ConnectionDraft {
  endpoint: string;
  account: string;
  secret: string;
  usage: string;
  domain: string;
}

/** 一个类别块的草稿。 */
export interface KindDraft {
  /**
   * 启用位。编辑器不展示它，但必须**原样带回**：基座把一次提交当成整条渠道的替换，
   * 丢了这个字段会把操作者停用的渠道悄悄打开。
   */
  enabled: boolean;
  natures: Set<SupplyNature>;
  connections: Partial<Record<SupplyNature, ConnectionDraft>>;
}

/** 一条渠道的草稿。两个类别块都在；没被编辑的那块原样带回，不丢。 */
export interface ChannelDraft {
  id: string;
  label: string;
  category: string;
  phone: KindDraft;
  email: KindDraft;
}

export const emptyConnection = (): ConnectionDraft => ({
  endpoint: '',
  account: '',
  secret: '',
  usage: '',
  domain: '',
});

export const emptyKindDraft = (): KindDraft => ({
  enabled: true,
  natures: new Set(),
  connections: {},
});

/** 新增渠道的起步草稿。 */
export const emptyChannelDraft = (): ChannelDraft => ({
  id: '',
  label: '',
  category: 'third-party',
  phone: emptyKindDraft(),
  email: emptyKindDraft(),
});

/**
 * 内置平台默认勾选的接入方式，只保留这一类别**真正支持**的。
 *
 * 取交集是有意的：平台声明的能力与基座当下允许的方式可能不一致，而**后端 `natures`
 * 才是权威**。照抄平台声明会勾上一个后端不认的方式，保存后就是一条并不存在的连接。
 */
export function platformNatures(
  defaults: readonly SupplyNature[],
  allowed: readonly SupplyNature[]
): Set<SupplyNature> {
  const permitted = new Set(allowed);
  return new Set(defaults.filter((nature) => permitted.has(nature)));
}

/** 基座一条渠道的某个类别块 → 草稿；这一类没配时给一个空草稿。 */
export function kindDraftFromChannel(channel: SupplyChannel, kind: SupplyKind): KindDraft {
  const block = kind === 'phone' ? channel.phone : channel.email;
  if (!block) return emptyKindDraft();
  const connections: Partial<Record<SupplyNature, ConnectionDraft>> = {};
  for (const [nature, connection] of Object.entries(block.connections)) {
    if (!connection) continue;
    connections[nature as SupplyNature] = {
      endpoint: connection.endpoint,
      account: connection.account,
      secret: connection.secret,
      usage: connection.usage,
      domain: connection.domain,
    };
  }
  return { enabled: block.enabled, natures: new Set(block.natures), connections };
}

/** 基座一条渠道 → 完整草稿。 */
export function channelDraftFromChannel(channel: SupplyChannel): ChannelDraft {
  return {
    id: channel.id,
    label: channel.label,
    category: channel.category,
    phone: kindDraftFromChannel(channel, 'phone'),
    email: kindDraftFromChannel(channel, 'email'),
  };
}

/**
 * 一个类别块的草稿 → 提交体。
 *
 * 一种接入方式都没勾 = 这一类不存在，返回 `undefined`（基座据此把它整块去掉，
 * 而不是留一个空壳）。
 */
export function kindDraftToInput(draft: KindDraft): SupplyKindConfigInput | undefined {
  if (draft.natures.size === 0) return undefined;
  const natures = [...draft.natures];
  const connections: Record<string, SupplyConnectionInput> = {};
  for (const nature of natures) {
    const connection = draft.connections[nature] ?? emptyConnection();
    connections[nature] = {
      endpoint: connection.endpoint.trim(),
      account: connection.account.trim(),
      secret: connection.secret.trim(),
      usage: connection.usage,
      domain: connection.domain.trim(),
    };
  }
  return { enabled: draft.enabled, natures, connections };
}

/** 整条渠道的草稿 → 提交体。两个类别块都提交，未编辑的那块原样带回。 */
export function channelDraftToInput(draft: ChannelDraft): SupplyChannelInput {
  const input: SupplyChannelInput = {
    label: draft.label.trim(),
    category: draft.category,
  };
  if (draft.id) input.id = draft.id;
  const phone = kindDraftToInput(draft.phone);
  const email = kindDraftToInput(draft.email);
  if (phone) input.phone = phone;
  if (email) input.email = email;
  return input;
}

/**
 * 表上「启动开关」的提交体：只改这一类的启用位，另一类原样带回。
 *
 * 基座把一次提交当成**整条渠道的替换**，所以两个块都要带上 —— 只发当前这一类
 * 会把另一类整块删掉（一条渠道可以同时服务手机号和邮箱）。
 */
export function kindBlockInput(
  channel: SupplyChannel,
  kind: SupplyKind,
  enabled: boolean
): SupplyKindConfigInput | undefined {
  const block = kind === 'phone' ? channel.phone : channel.email;
  if (!block) return undefined;
  const connections: Record<string, SupplyConnectionInput> = {};
  for (const nature of block.natures) {
    const connection = block.connections[nature];
    connections[nature] = {
      endpoint: connection?.endpoint ?? '',
      account: connection?.account ?? '',
      secret: connection?.secret ?? '',
      usage: connection?.usage ?? '',
      domain: connection?.domain ?? '',
    };
  }
  return { enabled, natures: [...block.natures], connections };
}
