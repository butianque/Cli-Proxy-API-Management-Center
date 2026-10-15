import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import type { AccountPolicy, AccountView } from '@/types/accounts';
import { formatDateTimeValue } from '@/utils/format';
import { policyI18nSuffix } from '@/features/authFiles/accountPool';
import styles from './AuthFilePoolSection.module.scss';

/** 后端路由策略词表（`sdk/pluginapi/types.go:1975-1980`）；数组顺序即下拉顺序。 */
const POLICY_VALUES: readonly AccountPolicy[] = [
  'start-plan-only',
  'api-key-only',
  'start-plan-first',
  'disabled',
];

/**
 * 池状态。后端用 `eligible`（`!unavailable`）与 `manuallyDisabled` 表达：
 * 手动关闭优先，其次是冷却判定下的可用性；两个开关都缺省即「不知道」——
 * 既不猜「可用」，也不猜「冷却」。
 */
type PoolState = 'eligible' | 'cooling' | 'off' | 'unknown';

const POOL_STATE_LABEL: Record<PoolState, string> = {
  eligible: 'account_pool.state_eligible',
  cooling: 'account_pool.state_cooling',
  off: 'account_pool.state_off',
  unknown: 'account_pool.state_unknown',
};

const resolvePoolState = (account: AccountView): PoolState => {
  if (account.manuallyDisabled === true) return 'off';
  if (account.eligible === true) return 'eligible';
  if (account.eligible === false) return 'cooling';
  return 'unknown';
};

export type AuthFilePoolSectionProps = {
  account?: AccountView;
  mutating?: boolean;
  onPolicyChange?: (policy: AccountPolicy | null) => void;
  /** 该账号是否有宿主额度通道。false/缺省 ⇒ 不渲染额度区块。 */
  quotaCapable?: boolean;
};

export function AuthFilePoolSection({
  account,
  mutating = false,
  onPolicyChange,
  quotaCapable = false,
}: AuthFilePoolSectionProps) {
  const { t, i18n } = useTranslation();
  const policyLabelId = useId();
  // 没有匹配到账号视图：这一行没有池信息可说，不占位。
  if (!account) return null;

  const poolState = resolvePoolState(account);
  const stateClass = {
    eligible: styles.stateEligible,
    cooling: styles.stateCooling,
    off: styles.stateOff,
    unknown: styles.stateUnknown,
  }[poolState];
  // Select 的 label 是已翻译文本，不是 i18n key。
  const policyOptions = [
    { value: '', label: t('account_pool.policy_default') },
    ...POLICY_VALUES.map((policy) => ({
      value: policy,
      label: t(`account_pool.policy_${policyI18nSuffix(policy)}`),
    })),
  ];
  const showQuotaMeta = Boolean(account.planId) || Boolean(account.channel);

  return (
    <div className={styles.poolSection}>
      <div className={styles.sectionTitle}>{t('account_pool.section_title')}</div>

      <div className={styles.row}>
        <span className={styles.fieldLabel}>{t('account_pool.state_label')}</span>
        <span className={`${styles.stateValue} ${stateClass}`}>
          {t(POOL_STATE_LABEL[poolState])}
        </span>
      </div>

      <div className={styles.policyBlock}>
        <label className={styles.fieldLabel} id={policyLabelId}>
          {t('account_pool.policy_label')}
        </label>
        <Select
          size="sm"
          ariaLabelledBy={policyLabelId}
          value={account.policy ?? ''}
          options={policyOptions}
          disabled={mutating}
          onChange={(value) => onPolicyChange?.(value === '' ? null : (value as AccountPolicy))}
        />
        <p className={styles.hint}>{t('account_pool.policy_hint')}</p>
      </div>

      {quotaCapable && (
        <div className={styles.quotaBlock}>
          <div className={styles.quotaHead}>
            <span className={styles.fieldLabel}>{t('account_pool.quota_label')}</span>
            {account.fetchedAt && (
              <span className={styles.quotaUpdated}>
                {t('account_pool.quota_updated', {
                  time: formatDateTimeValue(account.fetchedAt, i18n.language),
                })}
              </span>
            )}
          </div>
          <QuotaSummary account={account} />
          {showQuotaMeta && (
            <div className={styles.quotaMeta}>
              {account.planId && (
                <span className={styles.metaItem}>
                  <span className={styles.metaLabel}>{t('account_pool.quota_plan')}</span>
                  <span className={styles.metaValue}>{account.planId}</span>
                </span>
              )}
              {account.channel && (
                <span className={styles.metaItem}>
                  <span className={styles.metaLabel}>{t('account_pool.quota_channel')}</span>
                  <span className={styles.metaValue}>{account.channel}</span>
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {account.failureClass && (
        <div className={styles.row}>
          <span className={styles.fieldLabel}>{t('account_pool.failure_label')}</span>
          <span className={styles.failureValue}>
            {t(`account_pool.failure_${account.failureClass}`)}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * 额度摘要。后端无法确定的值一律省略或 `null`：
 * 无快照是 `unknown`（空态 + 下一步），查询失败是 `query-error`，
 * 两者都不显示 0；桶上的 `remaining` / `total` 缺省即不显示该项。
 */
function QuotaSummary({ account }: { account: AccountView }) {
  const { t } = useTranslation();

  if (account.quotaState === 'query-error') {
    return <p className={styles.quotaError}>{t('account_pool.quota_error')}</p>;
  }
  if (account.quotaState === 'unknown') {
    return (
      <p className={styles.quotaEmpty}>
        <span>{t('account_pool.quota_unknown')}</span>
        <span className={styles.quotaEmptyHint}>{t('account_pool.quota_unknown_hint')}</span>
      </p>
    );
  }
  if (account.quota.length === 0) {
    return <p className={styles.quotaEmpty}>{t('account_pool.quota_empty')}</p>;
  }

  return (
    <ul className={styles.bucketList}>
      {account.quota.map((bucket, index) => {
        const label = [bucket.group, bucket.model].filter(Boolean).join(' · ');
        // remainingFraction 是契约里的必填项：0 表示已用尽，是真实值，不是「未知」。
        const fraction = Number.isFinite(bucket.remainingFraction)
          ? Math.min(Math.max(bucket.remainingFraction, 0), 1)
          : null;
        return (
          <li
            className={styles.bucket}
            key={`${bucket.group ?? ''}:${bucket.model ?? ''}:${index}`}
          >
            <div className={styles.bucketHead}>
              {label && <span className={styles.bucketLabel}>{label}</span>}
              {bucket.remaining !== undefined && bucket.total !== undefined && (
                <span className={styles.bucketAmount}>
                  {t('account_pool.quota_remaining', {
                    remaining: bucket.remaining,
                    total: bucket.total,
                  })}
                </span>
              )}
            </div>
            {fraction !== null && (
              <span className={styles.bucketBar} aria-hidden="true">
                <span className={styles.bucketBarFill} style={{ width: `${fraction * 100}%` }} />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
