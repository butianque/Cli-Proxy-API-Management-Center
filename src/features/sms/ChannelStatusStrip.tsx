/**
 * 渠道池里**一行下面那条状态带**：这条渠道自己现在是什么样。
 *
 * 它属于上面那一行，不属于页面：邮箱行说「这个信箱收到了几封、最新一封是什么」，
 * 手机号行说「平台余额还剩多少、平台取过几个号」。多条渠道各说各的，不合并成
 * 一句摘要 —— 合并之后就没人说得清「有 3 封」是哪个邮箱的。
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
}

export function ChannelStatusStrip({ kind, status }: ChannelStatusStripProps) {
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

  if (note) {
    const tone = status.kind === 'error' ? styles.stripWarning : styles.stripNote;
    // 失败的原因已经在句子里了，不再挂一份悬停提示（同一句话不说两遍）。
    return (
      <div className={styles.strip}>
        <span className={tone}>{note}</span>
      </div>
    );
  }

  if (status.kind === 'phone') {
    return (
      <div className={styles.strip}>
        <span className={styles.stripItem}>
          {status.balanceCny === null ? (
            <span title={status.balanceError || undefined}>
              {t('sms_service.row_phone_balance_unknown')}
            </span>
          ) : (
            t('sms_service.row_phone_balance', { amount: status.balanceCny.toFixed(2) })
          )}
        </span>
        <span className={styles.stripItem}>
          {t('sms_service.row_phone_taken', { n: status.taken })}
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

  // 邮箱：读的是哪个信箱、这次往前看多久收到几封、最新一封是谁发的、里面有没有码。
  const latest = status.latest;
  const received = latest ? formatReceivedAt(latest.receivedAt) : '';
  return (
    <div className={styles.strip}>
      {status.mailbox && (
        <span className={`${styles.stripItem} ${styles.mono}`}>
          {status.domain ? `${status.mailbox} → @${status.domain}` : status.mailbox}
        </span>
      )}
      <span className={styles.stripItem}>
        {windowLabel(status.count, status.windowHours, t)}
      </span>
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

/**
 * 「近 3 天 2 封」里的那段话。
 *
 * 窗口多长由基座给（它决定往前看多久），页面不假设 —— 后端没说就只报「N 封」，
 * 免得把「最近 20 封」说成「近三天」。
 */
function windowLabel(
  count: number,
  hours: number,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (hours >= 24 && hours % 24 === 0) {
    return t('sms_service.row_email_window_days', { days: hours / 24, n: count });
  }
  if (hours > 0) {
    return t('sms_service.row_email_window_hours', { hours, n: count });
  }
  return t('sms_service.row_email_count', { n: count });
}
