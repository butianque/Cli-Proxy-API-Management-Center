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
import { egressOptions, egressPoolApi } from '@/services/api/egressPool';
import styles from './EgressBindingSelect.module.scss';

export interface EgressBindingSelectProps {
  /** 账号用凭证文件名，渠道用渠道 id。 */
  name: string;
  kind: 'account' | 'channel';
  /** 现在绑的是第几条；`0` = 没绑。 */
  currentId: number;
  /** 「没绑」在这一处的实际含义（账号是直连，渠道是跟随供应整体出口）。 */
  noneLabel: string;
  /** 渠道专用：只改这一类块（`phone` / `email`）；省略表示这条渠道的全部。 */
  supplyKind?: string;
  disabled?: boolean;
  /** 无障碍名称：一个页面里可能有很多个同样的下拉框，必须能分辨。 */
  ariaLabel: string;
  /** 改完之后调用方重新读一次自己的列表。 */
  onChanged?: () => void;
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

  const change = useCallback(
    async (nextValue: string) => {
      setError('');
      setSaving(true);
      const target = supplyKind === undefined ? { kind, name } : { kind, name, supplyKind };
      try {
        if (nextValue === '') await egressPoolApi.unbind(target);
        else await egressPoolApi.bind(Number(nextValue), target);
        await pool.reload();
        onChanged?.();
      } catch (failure) {
        setError(
          t('egress_pool.select_save_failed', {
            message: failure instanceof Error && failure.message ? failure.message : '',
          })
        );
      } finally {
        setSaving(false);
      }
    },
    [kind, name, onChanged, pool, supplyKind, t]
  );

  // 服务端没有代理池时整格不出现：旧版后端上这一格没有可选项，摆一个空下拉框
  // 只会让人以为出口坏了。
  if (pool.status === 'unsupported' || pool.status === 'error') return null;

  const options = [
    { value: '', label: noneLabel },
    ...egressOptions(pool.entries).map((option) => ({
      value: option.value,
      label: option.enabled ? option.label : `${option.label} (${t('egress_pool.paused')})`,
    })),
  ];

  // 绑着的编号已经不在池里（那条出口被删了）：把它作为一个选项显示出来，
  // 否则下拉框会退回「没绑」，而实际上它指着一个不存在的东西。
  const value = currentId > 0 ? String(currentId) : '';
  if (currentId > 0 && !pool.entries.some((entry) => entry.id === currentId)) {
    options.push({
      value: String(currentId),
      label: t('egress_pool.select_unknown', { id: currentId }),
    });
  }

  return (
    <span className={styles.wrap}>
      <Select
        value={value}
        options={options}
        size="sm"
        ariaLabel={ariaLabel}
        disabled={disabled || saving || pool.status === 'loading'}
        onChange={(nextValue) => void change(nextValue)}
      />
      {error !== '' && (
        <span role="alert" className={styles.error}>
          {error}
        </span>
      )}
    </span>
  );
}
