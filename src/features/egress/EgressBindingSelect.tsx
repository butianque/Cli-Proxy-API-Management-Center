/**
 * 「这条账号 / 这条渠道从哪条出口出去」的一个下拉框。
 *
 * 手动改出口是**降级手段**：正常路径是自动化在落点时直接调用绑定接口，一次一个，
 * 不需要人点。这里留一个下拉框，是为了在还没接上自动化的地方能就地改，而不是
 * 让人去翻配置文件。
 *
 * 下拉框直接写后端，不参与页面上的「保存」：出口是落点上的事实，改了立刻生效，
 * 攒着等保存只会让「看起来改了、实际还没改」多存在一段时间。
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import { useEgressPool } from '@/hooks/useEgressPool';
import { egressOptions, egressPoolApi, orderEgressChoices } from '@/services/api/egressPool';
import styles from './EgressBindingSelect.module.scss';

export interface EgressBindingSelectProps {
  /** 账号用凭证文件名，渠道用渠道 id。 */
  name: string;
  kind: 'account' | 'channel';
  /** 现在绑的是第几条；`0` = 没绑。 */
  currentId: number;
  /** 「没绑」在这一处的实际含义（不指定出口就是直连）。 */
  noneLabel: string;
  /** 渠道专用：只改这一类块（`phone` / `email`）；省略表示这条渠道的全部。 */
  supplyKind?: string;
  disabled?: boolean;
  /** 无障碍名称：一个页面里可能有很多个同样的下拉框，必须能分辨。 */
  ariaLabel: string;
  /** 改完之后调用方重新读一次自己的列表。返回 Promise 时会被等待。 */
  onChanged?: () => void | Promise<void>;
}

export function EgressBindingSelect({
  name,
  kind,
  currentId,
  noneLabel,
  supplyKind,
  disabled = false,
  ariaLabel,
  onChanged,
}: EgressBindingSelectProps) {
  const { t } = useTranslation();
  const pool = useEgressPool();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  /**
   * 已经提交、但父组件还没把新值读回来的那一次选择。
   *
   * 一次绑定要经过 bind → 池重读 → 列表重读三段往返（几百毫秒）。这段时间里如果
   * 触发器还显示旧值，看上去就跟没点一样 —— 而值其实已经提交了，把旧值留在那儿
   * 才是假话。先把它摆出来，等父组件的值跟上再交回去。
   *
   * `from` 记下点击时的值：父组件的值一旦变了，这个乐观值就自动作废，不需要再
   * 拿一次渲染去清理它。
   */
  const [pending, setPending] = useState<{ from: number; to: string } | null>(null);

  const change = useCallback(
    async (nextValue: string) => {
      setError('');
      setSaving(true);
      setPending({ from: currentId, to: nextValue });
      const target = supplyKind === undefined ? { kind, name } : { kind, name, supplyKind };
      try {
        if (nextValue === '') await egressPoolApi.unbind(target);
        else await egressPoolApi.bind(Number(nextValue), target);
        await pool.reload();
        await onChanged?.();
      } catch (failure) {
        // 没提交成功，把旧值交回去：留着新值等于替后端撒谎。
        setPending(null);
        setError(
          t('egress_pool.select_save_failed', {
            message: failure instanceof Error && failure.message ? failure.message : '',
          })
        );
      } finally {
        setSaving(false);
      }
    },
    [currentId, kind, name, onChanged, pool, supplyKind, t]
  );

  // 服务端没有代理池时整格不出现：旧版后端上这一格没有可选项，摆一个空下拉框
  // 只会让人以为出口坏了。
  if (pool.status === 'unsupported' || pool.status === 'error') return null;

  const optimistic = pending !== null && pending.from === currentId ? pending.to : null;
  const selectedValue = optimistic ?? (currentId > 0 ? String(currentId) : '');
  const poolOptions = egressOptions(pool.entries).map((option) => ({
    value: option.value,
    label: option.enabled ? option.label : `${option.label} (${t('egress_pool.paused')})`,
    description: option.description,
  }));

  // 绑着的编号已经不在池里（那条出口被删了）：把它作为一个选项显示出来，
  // 否则下拉框会退回「没绑」，而实际上它指着一个不存在的东西。
  const dangling =
    currentId > 0 && !pool.entries.some((entry) => entry.id === currentId)
      ? [{ value: selectedValue, label: t('egress_pool.select_unknown', { id: currentId }) }]
      : [];

  // 顺序：直连永远第一位，当前绑的那条紧随其后，其余按池内编号排。
  const options = orderEgressChoices(
    { value: '', label: noneLabel },
    [...dangling, ...poolOptions],
    selectedValue
  );

  /**
   * 触发器上那条出口**现在怎么样**。
   *
   * 下拉框本身只说「绑的是第几条」，说不出这条出口通不通 —— 那正是它在一排状态里
   * 显得突兀的原因：旁边每一格都在报状态，只有它是个孤零零的选择框。这里补上池里
   * 已有的结论（启用位 + 上次测试），而且读的是**触发器上正显示的那一条**，所以刚
   * 改完就跟着变，不会先说旧的、再跳到新的。
   */
  const shownId = Number(selectedValue);
  const bound = shownId > 0 ? (pool.entries.find((entry) => entry.id === shownId) ?? null) : null;
  const boundState: { tone: string; text: string; title?: string } | null = (() => {
    if (bound === null) return null;
    if (!bound.enabled) return { tone: 'stateMuted', text: t('egress_pool.paused') };
    if (bound.probe === null) return { tone: 'stateMuted', text: t('egress_pool.untested') };
    if (!bound.probe.ok) {
      return {
        tone: 'stateBad',
        text: t('egress_pool.bound_failed'),
        title: bound.probe.error,
      };
    }
    const latency =
      bound.probe.latencyMs === null
        ? ''
        : t('egress_pool.bound_latency', { ms: Math.round(bound.probe.latencyMs) });
    return {
      tone: 'stateGood',
      text:
        [latency, bound.probe.region].filter((part) => part !== '').join(' · ') ||
        t('egress_pool.bound_reachable'),
      title: bound.probe.ip,
    };
  })();

  return (
    <span className={styles.wrap}>
      <Select
        value={selectedValue}
        options={options}
        size="sm"
        ariaLabel={ariaLabel}
        disabled={disabled || saving || pool.status === 'loading'}
        onChange={(nextValue) => void change(nextValue)}
      />
      {boundState !== null && (
        <span className={`${styles.state} ${styles[boundState.tone]}`} title={boundState.title}>
          <span className={styles.dot} aria-hidden="true" />
          {boundState.text}
        </span>
      )}
      {error !== '' && (
        <span role="alert" className={styles.error}>
          {error}
        </span>
      )}
    </span>
  );
}
