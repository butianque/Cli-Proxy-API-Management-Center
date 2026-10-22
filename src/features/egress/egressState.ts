/**
 * 一条出口「上次测试到底说明了什么」。
 *
 * 出口的探活结论在界面上出现在两个地方：绑定的下拉框下面一行，以及代理池表格里的
 * 一列。两处各写一遍判断，迟早会出现一处说「12ms」、另一处说「还没测过」—— 同一个
 * 后端字段，两种说法，读的人不知道该信哪个。所以结论只在这里算一次。
 *
 * 三种语气对应三种「现在能不能用」：
 *
 * - `good`：测通了，而且知道多快、从哪儿出去；
 * - `bad`：测了，不通（有结论，结论不好）；
 * - `muted`：还没有结论 —— 没测过。它和「测了不通」不是一回事，前者该去测一次，
 *   后者该去查地址，语气混同会把下一步指错。
 */

import type { TFunction } from 'i18next';
import type { EgressProbeSummary } from '@/services/api/egressPool';

/** 语气只决定颜色，不决定说什么。 */
export type EgressTone = 'good' | 'bad' | 'muted';

export interface EgressProbeState {
  tone: EgressTone;
  /** 主句：`12ms · 香港` / `测试失败` / `还没测过`。 */
  text: string;
  /** 悬停补充：问到哪个地址、归属哪张网、失败的原因。没有就是空串。 */
  title: string;
  /** 这次结论是什么时候得出的（Unix 秒）；`0` = 没有结论。 */
  at: number;
}

/**
 * 把一次探活结论翻译成一句话。
 *
 * 不读 `enabled`：停用是「这台机器允不允许用它」，探活是「它通不通」，两个轴。表格
 * 里两列各说一个，混进来就会变成「连通：已停用」这种答非所问。需要说停用的地方
 * （下拉框下面那一行）自己先说一句。
 *
 * 延迟与地区都不报时不留空白：宁可说「可用」——「可用」是那次测试能证明的最小事实。
 */
export function describeProbe(probe: EgressProbeSummary | null, t: TFunction): EgressProbeState {
  if (probe === null) {
    return { tone: 'muted', text: t('egress_pool.untested'), title: '', at: 0 };
  }
  if (!probe.ok) {
    return {
      tone: 'bad',
      text: t('egress_pool.probe_failed_short'),
      title: probe.error,
      at: probe.at,
    };
  }
  const latency =
    probe.latencyMs === null
      ? ''
      : t('egress_pool.probe_latency', { ms: Math.round(probe.latencyMs) });
  return {
    tone: 'good',
    text:
      [latency, probe.region].filter((part) => part !== '').join(' · ') ||
      t('egress_pool.probe_reachable'),
    title: [probe.ip, probe.network].filter((part) => part !== '').join(' · '),
    at: probe.at,
  };
}
