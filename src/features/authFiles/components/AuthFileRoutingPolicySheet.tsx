import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sheet } from '@/components/ui/Sheet';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import type { AccountChannel, AccountPolicy } from '@/types/accounts';
import {
  ACCOUNT_POLICY_AUTO,
  routingPolicyOptions,
} from '@/features/authFiles/accountPool';
import styles from './AuthFileRoutingPolicySheet.module.scss';

export type AuthFileRoutingPolicySheetProps = {
  open: boolean;
  /** 抽屉标题：这次改的是哪个凭证。 */
  fileName: string;
  /** 当前策略；缺省 = 默认。 */
  policy?: AccountPolicy;
  /** 该账号实际可用的渠道；缺省/空 = 只有「默认」一项，不造渠道。 */
  channels?: readonly AccountChannel[];
  /** 保存中：控件与关闭都锁住，避免半途改动。 */
  saving: boolean;
  disabled: boolean;
  onClose: () => void;
  /** 选完立刻回传（改即存）；通知归调用方。 */
  onChange: (policy: AccountPolicy | null) => void;
  /** 让宿主重新探测这个账号的渠道；空态里的动作，缺省就不给动作。 */
  onRefreshChannels?: () => void | Promise<void>;
};

/**
 * 路由策略抽屉。策略是「账号池」层面的开关，卡片正文只留状态与额度，
 * 这个开关收进抽屉，改完立即生效（下一次请求起效）。
 *
 * 选项随账号实际拿到的渠道走（`routingPolicyOptions`）：渠道名来自后端，
 * 不写死枚举，否则选项与账号真实渠道对不上。
 */
export function AuthFileRoutingPolicySheet(props: AuthFileRoutingPolicySheetProps) {
  const { t } = useTranslation();
  const labelId = useId();
  const [refreshing, setRefreshing] = useState(false);
  // Select 的 label 是已翻译文本，不是 i18n key。
  const options = routingPolicyOptions(props.channels ?? [], props.policy).map((option) => ({
    value: option.value,
    label:
      option.channelLabel === null
        ? t('account_pool.policy_default')
        : t('account_pool.policy_only', { name: option.channelLabel }),
  }));
  // 只剩「默认」一项时，这个下拉改了也改变不了任何东西：改成说清现状 + 下一步。
  const hasChoice = options.length > 1;

  const handleChange = (value: string) => {
    // 下拉只会产出本列表里的值；词表外的值按「默认」处理，不做无校验的断言。
    const picked = options.find((option) => option.value === value);
    props.onChange(picked ? picked.value : null);
  };

  const handleRefreshChannels = async () => {
    if (refreshing || !props.onRefreshChannels) return;
    setRefreshing(true);
    try {
      await props.onRefreshChannels();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      size="md"
      closeDisabled={props.saving}
      eyebrow={t('auth_files.routing_policy_button')}
      title={props.fileName}
    >
      <div className={styles.body}>
        {hasChoice ? (
          <div className="form-group">
            <label id={labelId}>{t('account_pool.policy_label')}</label>
            <Select
              value={props.policy ?? ACCOUNT_POLICY_AUTO}
              options={options}
              ariaLabelledBy={labelId}
              disabled={props.disabled || props.saving}
              onChange={handleChange}
            />
            <div className="hint">{t('account_pool.policy_hint')}</div>
          </div>
        ) : (
          <EmptyState
            title={t('account_pool.policy_no_channels_title')}
            description={t('account_pool.policy_no_channels_desc')}
            action={
              props.onRefreshChannels ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={refreshing}
                  disabled={props.disabled}
                  onClick={() => void handleRefreshChannels()}
                >
                  {t('account_pool.policy_no_channels_action')}
                </Button>
              ) : undefined
            }
          />
        )}
        {props.saving && (
          <div className={styles.saving} role="status">
            <LoadingSpinner size={14} />
            <span>{t('auth_files.routing_policy_saving')}</span>
          </div>
        )}
      </div>
    </Sheet>
  );
}
