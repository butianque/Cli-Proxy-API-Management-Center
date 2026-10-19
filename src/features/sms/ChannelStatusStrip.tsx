/**
 * 渠道池里**一行下面那条状态带**：这条渠道自己现在是什么样。
 *
 * 它属于上面那一行，不属于页面。第一句永远是**这条渠道往供应池送了多少身份**
 * （`该渠道入池 3 个手机号`）：渠道池是供应池的上游，这是它唯一该报的数量。
 * 后面才是它自己的运行情况 —— 手机号行说平台余额还剩多少，邮箱行说读的是哪个信箱、
 * 最新一封是什么码。多条渠道各说各的，不合并成一句摘要 —— 合并之后就没人说得清
 * 「有 3 封」是哪个邮箱的。
 *
 * 状态带只读、只陈述。取不到就明说取不到（并给出原因），不拿 0 或占位符顶替。
 */

import { useTranslation } from 'react-i18next';
import { formatReceivedAt } from './emailMapping';
import type { ChannelStatus, SupplyKind } from './types';
import styles from './SmsServicePage.module.scss';

export interface ChannelStatusStripProps {
  kind: SupplyKind;
  status: ChannelStatus;
  /**
   * 这条渠道已经往供应池送了几个身份。
   *
   * `undefined` = 后端报不出这个数，整句不出现；`0` 是「数过，一个都没有」。
   */
  pooled?: number;
}

export function ChannelStatusStrip({ kind, status, pooled }: ChannelStatusStripProps) {
  const { t } = useTranslation();

  // 五种「没有数字可说」的状态各有各的话：停用、锁着、凭据没存、读失败、还在读。
  // 把它们渲染成空白会让一条关掉的渠道看起来和一条空的渠道一样。
  const note = (() => {
    switch (status.kind) {
      case 'loading':
        return t('sms_service.row_status_loading');
      case 'disabled':
        return t('sms_service.row_status_disabled');
      case 'locked':
        return t('sms_service.row_status_locked');
      case 'unready':
        return t(
          kind === 'email'
            ? 'sms_service.row_status_unready_email'
            : 'sms_service.row_status_unready_phone'
        );
      case 'error':
        return t('sms_service.row_status_error', { message: status.message });
      default:
        return '';
    }
  })();

  // 这条渠道往供应池送了多少身份。它与平台读得通不通无关：数是台账数出来的，
  // 所以停用、锁着、读失败时照样说，只有「后端报不出」才不说。
  const pooledText =
    typeof pooled === 'number'
      ? t(
          kind === 'phone' ? 'sms_service.row_pooled_phone' : 'sms_service.row_pooled_email',
          { n: pooled }
        )
      : '';

  if (note) {
    const tone = status.kind === 'error' ? styles.stripWarning : styles.stripNote;
    // 失败的原因已经在句子里了，不再挂一份悬停提示（同一句话不说两遍）。
    return (
      <div className={styles.strip}>
        {pooledText && <span className={styles.stripItem}>{pooledText}</span>}
        <span className={tone}>{note}</span>
      </div>
    );
  }

  if (status.kind === 'phone') {
    return (
      <div className={styles.strip}>
        {pooledText && <span className={styles.stripItem}>{pooledText}</span>}
        <span className={styles.stripItem}>
          {status.balanceCny === null ? (
            <span title={status.balanceError || undefined}>
              {t('sms_service.row_phone_balance_unknown')}
            </span>
          ) : (
            t('sms_service.row_phone_balance', { amount: status.balanceCny.toFixed(2) })
          )}
        </span>
        {status.latestAt && (
          <span className={styles.stripItem}>
            {t('sms_service.row_phone_latest', { time: formatReceivedAt(status.latestAt) })}
          </span>
        )}
      </div>
    );
  }

  if (status.kind !== 'email') return null;

  // 邮箱：读的是哪个信箱、最新一封是谁发的、里面有没有码。
  const latest = status.latest;
  const received = latest ? formatReceivedAt(latest.receivedAt) : '';
  return (
    <div className={styles.strip}>
      {pooledText && <span className={styles.stripItem}>{pooledText}</span>}
      {status.mailbox && (
        <span className={`${styles.stripItem} ${styles.mono}`}>
          {status.domain ? `${status.mailbox} → @${status.domain}` : status.mailbox}
        </span>
      )}
      {latest && (
        <span className={styles.stripItem}>
          {received && `${t('sms_service.row_email_latest', { time: received })} · `}
          {latest.from || latest.subject || '—'}
          {latest.code && (
            <span className={styles.stripCode}>
              {t('sms_service.row_email_code', { code: latest.code })}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
