import { useTranslation } from 'react-i18next';
import { sharedResetAt } from '@/features/authFiles/accountPool';
import type { AccountQuotaBucket, AccountView } from '@/types/accounts';
import { formatDateTimeValue } from '@/utils/format';
import { formatInstantShort } from '@/utils/quota';
import styles from './AuthFilePoolSection.module.scss';

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

/**
 * 剩余比例 → 额度条颜色。三档：> 0.5 绿、> 0.2 琥珀、其余红。
 * 只用主题 token，不写死颜色；琥珀是 `--caution-color`，不能用 `--warning-color`
 * （本主题里它与 `--error-color` 同色，是红）。
 */
const fractionToneClass = (fraction: number): string => {
  if (fraction > 0.5) return styles.barSuccess;
  if (fraction > 0.2) return styles.barCaution;
  return styles.barDanger;
};

export type AuthFilePoolSectionProps = {
  account?: AccountView;
  /** 该账号是否有宿主额度通道。false/缺省 ⇒ 不渲染额度区块。 */
  quotaCapable?: boolean;
};

export function AuthFilePoolSection({ account, quotaCapable = false }: AuthFilePoolSectionProps) {
  const { t, i18n } = useTranslation();
  // 没有匹配到账号视图：这一行没有池信息可说，不占位。
  if (!account) return null;

  const poolState = resolvePoolState(account);
  const stateClass = {
    eligible: styles.stateEligible,
    cooling: styles.stateCooling,
    off: styles.stateOff,
    unknown: styles.stateUnknown,
  }[poolState];

  return (
    <div className={styles.poolSection}>
      <div className={styles.sectionTitle}>{t('account_pool.section_title')}</div>

      <div className={styles.row}>
        <span className={styles.fieldLabel}>{t('account_pool.state_label')}</span>
        <span className={`${styles.stateValue} ${stateClass}`}>
          {t(POOL_STATE_LABEL[poolState])}
        </span>
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

/** 一个渠道（`bucket.group`）下的额度桶；`name` 为空 = 后端没给渠道名，不造。 */
type QuotaGroup = {
  key: string;
  name: string | null;
  buckets: AccountQuotaBucket[];
};

/**
 * 按 `bucket.group` 分组，组内保持后端下发顺序；组之间也保持首次出现的顺序。
 * 缺 `group` 的桶归入一个无名的组（不臆造渠道名，只按模型逐行列出）。
 */
const groupQuotaBuckets = (buckets: readonly AccountQuotaBucket[]): QuotaGroup[] => {
  const groups: QuotaGroup[] = [];
  const byName = new Map<string, QuotaGroup>();

  buckets.forEach((bucket) => {
    const name = bucket.group?.trim() ?? '';
    let group = byName.get(name);
    if (!group) {
      group = { key: `group-${groups.length}`, name: name || null, buckets: [] };
      byName.set(name, group);
      groups.push(group);
    }
    group.buckets.push(bucket);
  });

  return groups;
};

/**
 * 到期/重置时刻：宿主按 RFC3339 下发（源自上游的 `expires_at` / `period_end` /
 * `nextResetTime`），这里渲染成卡片惯用的 `MM-DD HH:mm`（浏览器本地时区）。
 * 解析不出来返回 null —— 宁可不显示，也不摆一个「未知」占位。
 */
const formatResetAt = (value: string | null | undefined): string | null => {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? formatInstantShort(ms) : null;
};

/**
 * 额度摘要。后端无法确定的值一律省略或 `null`：
 * 无快照是 `unknown`（空态 + 下一步），查询失败是 `query-error`，
 * 两者都不显示 0；桶上的 `remaining` / `total` 缺省即不显示该项。
 *
 * 三个分支（顺序固定）：报出 `total` ⇒ 报出真实数值 + 比例条；没有 `total`
 * 但有 `description` ⇒ 只给后端下发的说明，**不画比例条**（比例无从谈起）；
 * 两者皆缺 ⇒ 只留比例条。
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
    <ul className={styles.quotaGroups}>
      {groupQuotaBuckets(account.quota).map((group) => {
        // 到期时刻是**套餐（渠道）一级**的事实，挂在组头说一次即可；组内各模型窗口
        // 期限不同时 `sharedResetAt` 返回 null，那时才退回逐行各报各的。
        const groupResetAt = formatResetAt(sharedResetAt(group.buckets));
        return (
          <li className={styles.quotaGroup} key={group.key}>
            {group.name && (
              <div className={styles.groupHead}>
                <span className={styles.groupName} title={group.name}>
                  {group.name}
                </span>
                <span className={styles.groupCount}>
                  {t('account_pool.quota_group_models', { count: group.buckets.length })}
                </span>
              </div>
            )}
            {groupResetAt && (
              <span className={styles.groupExpiry}>
                {t('account_pool.quota_expires_at', { time: groupResetAt })}
              </span>
            )}
            <ul className={styles.bucketList}>
              {group.buckets.map((bucket, index) => {
                // 渠道名已升为分组标题，行内只留模型名；后端没给就不造标签。
                const label = bucket.model?.trim() ?? '';
                // remainingFraction 是契约里的必填项：0 表示已用尽，是真实值，不是「未知」。
                const fraction = Number.isFinite(bucket.remainingFraction)
                  ? Math.min(Math.max(bucket.remainingFraction, 0), 1)
                  : null;
                // 「剩余 x / y」需要两个数：只有 total 没有 remaining 时不拼半个句子。
                const amount =
                  bucket.remaining !== undefined && bucket.total !== undefined
                    ? t('account_pool.quota_remaining', {
                        remaining: bucket.remaining,
                        total: bucket.total,
                      })
                    : null;
                // 说明文字只在没有数值可报时顶上，避免与数值重复。
                const description = amount === null ? bucket.description : undefined;
                // 组头已报过同一个时刻就不再逐行重复。
                const expiresAt = groupResetAt ? null : formatResetAt(bucket.resetAt);
                return (
                  <li className={styles.bucket} key={`${bucket.model ?? ''}:${index}`}>
                    <div className={styles.bucketHead}>
                      {label && <span className={styles.bucketLabel}>{label}</span>}
                      {amount && <span className={styles.bucketAmount}>{amount}</span>}
                    </div>
                    {description && <span className={styles.bucketDescription}>{description}</span>}
                    {description === undefined && fraction !== null && (
                      <span className={styles.bucketBar} aria-hidden="true">
                        <span
                          className={`${styles.bucketBarFill} ${fractionToneClass(fraction)}`}
                          style={{ width: `${fraction * 100}%` }}
                        />
                      </span>
                    )}
                    {expiresAt && (
                      <span className={styles.bucketExpiry}>
                        {t('account_pool.quota_expires_at', { time: expiresAt })}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
