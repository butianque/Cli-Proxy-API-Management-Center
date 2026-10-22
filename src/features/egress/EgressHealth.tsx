/**
 * 一条出口的健康状况：一个圆点 + 一句话。
 *
 * 圆点不是装饰，它是这一格唯一的颜色来源 —— 一条出口的「通 / 不通 / 还没测」在这里
 * 定色，别处（下拉框、代理池表格）都长这样，扫一眼就知道哪条要处理。
 *
 * 颜色只给两种结论：绿＝通，红＝不通。停用与没测过都是灰的 —— 那两种不是结论，是
 * 「还没有结论」，用红或绿都会替它们下判断。
 */

import { useTranslation } from 'react-i18next';
import type { EgressProbeSummary } from '@/services/api/egressPool';
import { formatDateTimeValue } from '@/utils/format';
import { describeProbe, type EgressTone } from './egressState';
import styles from './EgressHealth.module.scss';

const TONE_CLASS: Record<EgressTone, string> = {
  good: styles.good,
  bad: styles.bad,
  muted: styles.muted,
};

export interface EgressHealthProps {
  probe: EgressProbeSummary | null;
  /**
   * 出口被停用时先说「已停用」。
   *
   * 只在**没有别的列会说这件事**的地方开（绑定的下拉框）：停用是配置决定，不是探活
   * 结论，表格里已经有「启用」一列，再说一遍就成了同一件事两种说法。
   */
  paused?: boolean;
  /**
   * 带一行「测试于 …」。
   *
   * 延迟是一个会过期的数：只说 `12ms` 而不说什么时候测的，等于把三小时前的结论当成
   * 现在的。表格里放得下这一行，就放。
   */
  showProbeAt?: boolean;
}

export function EgressHealth({ probe, paused = false, showProbeAt = false }: EgressHealthProps) {
  const { t, i18n } = useTranslation();
  const state = paused
    ? { tone: 'muted' as const, text: t('egress_pool.paused'), title: '', at: probe?.at ?? 0 }
    : describeProbe(probe, t);

  return (
    <>
      <span className={[styles.line, TONE_CLASS[state.tone]].join(' ')} title={state.title}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.text}>{state.text}</span>
      </span>
      {showProbeAt && state.at > 0 && (
        <span className={styles.at}>
          {t('egress_pool.probe_at', {
            time: formatDateTimeValue(state.at * 1000, i18n.language),
          })}
        </span>
      )}
    </>
  );
}
