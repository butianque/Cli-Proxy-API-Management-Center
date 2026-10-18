import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { remainingMinutes, resolveResetInstant, sharedResetAt } from '@/features/authFiles/accountPool';
import { resolveCredentialSite } from '@/features/authFiles/siteIdentity';
import { useNow } from '@/hooks/useNow';
import type { AccountQuotaBucket, AccountView } from '@/types/accounts';
import { formatDateValue, formatDateTimeValue } from '@/utils/format';
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
  /** 该凭证的 provider 键：站点行由它查表，不猜域名。 */
  providerKey?: string;
  /** 该账号是否有宿主额度通道。false/缺省 ⇒ 不渲染额度区块。 */
  quotaCapable?: boolean;
};

export function AuthFilePoolSection({
  account,
  providerKey = '',
  quotaCapable = false,
}: AuthFilePoolSectionProps) {
  const { t, i18n } = useTranslation();
  // 倒计时读应用级的分钟时钟（全应用一个定时器），而不是每张卡片各起一个。
  // 放在提前返回之前，钩子不能有条件地调用。
  const now = useNow();
  // 没有匹配到账号视图：这一行没有池信息可说，不占位。
  if (!account) return null;

  const poolState = resolvePoolState(account);
  // 站点是凭证自己的事实（上游域名 + 国内/国际），来自 provider 键的固定映射；
  // 未登记就不出这一行，不拿别的字段凑。
  const site = resolveCredentialSite(providerKey);
  // 开通日期只按「能格式化成日期」才出现：宿主与归一化层都会丢掉非法值，这里再兜一次，
  // 免得出现一个只有标签、没有值的空行。
  const openedAt = account.openedAt ? formatDateValue(account.openedAt, i18n.language) : '';
  const stateClass = {
    eligible: styles.stateEligible,
    cooling: styles.stateCooling,
    off: styles.stateOff,
    unknown: styles.stateUnknown,
  }[poolState];

  return (
    <div className={styles.poolSection}>
      {site && (
        <div className={styles.row}>
          <span className={styles.fieldLabel}>{t('account_pool.site_label')}</span>
          <span className={styles.siteValue}>
            <span className={styles.siteRegion}>{t(`auth_files.region_${site.region}`)}</span>
            <span className={styles.siteDomain}>{site.domain}</span>
          </span>
        </div>
      )}

      <div className={styles.row}>
        <span className={styles.fieldLabel}>{t('account_pool.state_label')}</span>
        <span className={`${styles.stateValue} ${stateClass}`}>
          {t(POOL_STATE_LABEL[poolState])}
        </span>
      </div>

      {/* 账号多大年纪是账号自己的事实：宿主只在插件真的报了这个时刻时才下发，
          读不到就整行不出现，不拿凭证创建时间顶替。 */}
      {openedAt && (
        <div className={styles.row}>
          <span className={styles.fieldLabel}>{t('account_pool.opened_at_label')}</span>
          <span className={styles.openedAtValue}>{openedAt}</span>
        </div>
      )}

      {quotaCapable && (
        <div className={styles.quotaBlock}>
          <div className={styles.quotaHead}>
            <span className={styles.fieldLabel}>
              {t(
                account.quota.some((bucket) => (bucket.group?.trim() ?? '') !== '')
                  ? 'account_pool.quota_label'
                  : 'account_pool.quota_label_plain'
              )}
            </span>
            {account.fetchedAt && (
              <span className={styles.quotaUpdated}>
                {t('account_pool.quota_updated', {
                  time: formatDateTimeValue(account.fetchedAt, i18n.language),
                })}
              </span>
            )}
          </div>
          <QuotaSummary account={account} now={now} />
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
 * 后端用稳定 token 说明「这个渠道没有额度可报」的原因，措辞归前端所有 ——
 * 插件没有语言环境，句子只能在这里组装，六种语言才都成立。上游错误的原文不是
 * token，照原样显示，那是诊断信息，不该被翻译掩盖。
 */
const QUOTA_STATE_LABEL: Record<string, string> = {
  'not-subscribed': 'account_pool.quota_not_subscribed',
};

const describeQuotaBucket = (
  description: string | undefined,
  t: TFunction
): string | undefined => {
  if (!description) return undefined;
  const key = QUOTA_STATE_LABEL[description];
  return key ? t(key) : description;
};

/**
 * 到期/重置一行：**绝对时刻 + 剩余分钟**。只有时刻没有剩余时，读者还得自己做减法；
 * 只有剩余没有时刻，又没法安排。两个都给，`now` 由卡片统一提供（应用级分钟时钟），
 * 组头与模型行读同一个 `now`，不会各算各的。
 *
 * 时刻解析不出 ⇒ 整行不渲染（不摆「未知」占位）；已经过去 ⇒ 只报时刻，
 * 因为「剩余」为负没有意义。按日窗口不会落到「已经过去」，见 `resolveResetInstant`。
 */
function ExpiryLine({
  labelKey,
  resetAt,
  window,
  now,
  className,
}: {
  labelKey: string;
  resetAt: string | null | undefined;
  window?: string | null;
  now: number;
  className: string;
}) {
  const { t } = useTranslation();
  const at = resolveResetInstant(resetAt, window, now);
  if (at === null) return null;
  const minutes = remainingMinutes(at, now);
  return (
    <span className={className}>
      {t(labelKey, { time: formatInstantShort(at) })}
      {minutes !== null && ` · ${t('account_pool.quota_remaining_time', { minutes })}`}
    </span>
  );
}

/**
 * 额度摘要。后端无法确定的值一律省略或 `null`：
 * 没有读数是 `unknown`，读到了但一个额度都没有是空数组——两者对读者是同一件事：
 * **这个账号没有可用额度**。分开说会逼出一句「刷新以获取额度」的空头承诺（刚刷完
 * 也还是这句话），所以合并成一句陈述；只有**读取失败**才是另一回事（`query-error`）。
 *
 * 措辞只说状态、不说机制：空数组就是「没有可用额度」，不能写成「未上报」——
 * 那读起来像采集坏了，而实际上探测刚成功、账号就是没有额度。
 *
 * 两者都不显示 0；桶上的 `remaining` / `total` 缺省即不显示该项。
 *
 * 三种桶形状（顺序固定）：
 *   1. 报出 `total` ⇒ 有分母，报出「剩余 x / y」并画比例条；
 *   2. 只报出 `remaining` ⇒ 余额（没有分母，比例无从谈起），只报数值、不画条；
 *   3. 两者皆缺 ⇒ 有 `description` 就报说明，否则只留比例条。
 */
function QuotaSummary({ account, now }: { account: AccountView; now: number }) {
  const { t, i18n } = useTranslation();

  if (account.quotaState === 'query-error') {
    return <p className={styles.quotaError}>{t('account_pool.quota_error')}</p>;
  }
  if (account.quota.length === 0) {
    return <p className={styles.quotaEmpty}>{t('account_pool.quota_empty')}</p>;
  }

  return (
    <ul className={styles.quotaGroups}>
      {groupQuotaBuckets(account.quota).map((group) => {
        // 到期时刻是**套餐（渠道）一级**的事实，挂在组头说一次即可。没有组头就没有
        // 这个位置（无名组），此时退回逐行；组内各桶值不一致时 `sharedResetAt`
        // 返回 null，同样逐行各报各的。
        const groupResetAt = group.name ? sharedResetAt(group.buckets) : null;
        // 只有状态、没有读数的一组（例如「未开通」）不报模型数：那不是「1 个模型」。
        const hasReadings = group.buckets.some(
          (bucket) =>
            Boolean(bucket.model?.trim()) ||
            bucket.total !== undefined ||
            bucket.remaining !== undefined
        );
        return (
          <li className={styles.quotaGroup} key={group.key}>
            {group.name && (
              <div className={styles.groupHead}>
                <span className={styles.groupName} title={group.name}>
                  {group.name}
                </span>
                {hasReadings && (
                  <span className={styles.groupCount}>
                    {t('account_pool.quota_group_models', { count: group.buckets.length })}
                  </span>
                )}
              </div>
            )}
            {groupResetAt && (
              // 组头说的是**套餐期限**（到期，不是重置），所以不传 window：
              // 这里的时刻落在过去就真的到期了，不该按天往前滚。
              <ExpiryLine
                labelKey="account_pool.quota_expires_at"
                resetAt={groupResetAt}
                now={now}
                className={styles.groupExpiry}
              />
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
                const hasTotal = bucket.remaining !== undefined && bucket.total !== undefined;
                const hasBalance = bucket.remaining !== undefined && !hasTotal;
                const amount = hasTotal
                  ? t('account_pool.quota_remaining', {
                      remaining: bucket.remaining,
                      total: bucket.total,
                    })
                  : hasBalance
                    ? bucket.remaining!.toLocaleString(i18n.language)
                    : null;
                // 说明文字只在没有数值可报时顶上，避免与数值重复。
                const description =
                  amount === null ? describeQuotaBucket(bucket.description, t) : undefined;
                // 比例条只在比例有依据时画：有分母就画；既无数值也无说明时，比例条是
                // 该桶唯一能表达的东西。只有余额（无分母）时比例无从谈起，不画。
                const drawsBar =
                  bucket.total !== undefined ||
                  (bucket.remaining === undefined && description === undefined);
                // 组头已报过同一个时刻就不再逐行重复。
                const expiresAt = groupResetAt ? null : bucket.resetAt;
                // 按日窗口到期是「重置」，其余窗口才是「到期」：积分/日限只换一天，不过期。
                const expiryLabel =
                  bucket.window?.trim() === 'daily'
                    ? 'account_pool.quota_resets_at'
                    : 'account_pool.quota_expires_at';
                return (
                  <li className={styles.bucket} key={`${bucket.model ?? ''}:${index}`}>
                    <div className={styles.bucketHead}>
                      {label && <span className={styles.bucketLabel}>{label}</span>}
                      {amount && <span className={styles.bucketAmount}>{amount}</span>}
                    </div>
                    {description && <span className={styles.bucketDescription}>{description}</span>}
                    {description === undefined && drawsBar && fraction !== null && (
                      <span className={styles.bucketBar} aria-hidden="true">
                        <span
                          className={`${styles.bucketBarFill} ${fractionToneClass(fraction)}`}
                          style={{ width: `${fraction * 100}%` }}
                        />
                      </span>
                    )}
                    {expiresAt && (
                      <ExpiryLine
                        labelKey={expiryLabel}
                        resetAt={expiresAt}
                        window={bucket.window}
                        now={now}
                        className={styles.bucketExpiry}
                      />
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
