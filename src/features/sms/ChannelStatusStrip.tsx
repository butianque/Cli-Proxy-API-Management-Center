/**
 * 渠道池里**一行下面那条状态块**：这条渠道自己现在是什么样。
 *
 * 它属于上面那一行，不属于页面。第一格永远是**这条渠道往供应池送了多少身份**
 * （`入池 3 个手机号`）：渠道池是供应池的上游，这是它唯一该报的数量。后面才是它
 * 自己的运行情况 —— 手机号行说平台余额还剩多少、最近什么时候取过号，邮箱行说读的是
 * 哪个信箱、最新一封是什么码。多条渠道各说各的，不合并成一句摘要 —— 合并之后就没人
 * 说得清「有 3 封」是哪个邮箱的。
 *
 * 出口绑定控件由调用方传进来（`egress`），但它在这块里占一格：出口属于这条渠道的
 * 状态，把它挂在删除按钮下面会让人以为它是个行内动作。
 *
 * 状态块只读、只陈述。取不到就明说取不到（并给出原因），不拿 0 或占位符顶替。
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatReceivedAt } from './emailMapping';
import { EntryStatus, EntryStatusFact, EntryStatusFacts, EntryStatusNote } from './EntryStatus';
import type { ChannelStatus, SupplyKind } from './types';
import styles from './SmsServicePage.module.scss';

export interface ChannelStatusStripProps {
  kind: SupplyKind;
  status: ChannelStatus;
  /**
   * 这条渠道已经往供应池送了几个身份。
   *
   * `undefined` = 后端报不出这个数，整格不出现；`0` 是「数过，一个都没有」。
   */
  pooled?: number;
  /** 出口绑定控件；`null` = 这版服务端没有出口池，那一格整个不出现。 */
  egress?: ReactNode;
}

export function ChannelStatusStrip({ kind, status, pooled, egress }: ChannelStatusStripProps) {
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

  return (
    <EntryStatus>
      <EntryStatusFacts>
        {/* 这条渠道往供应池送了多少身份。它与平台读得通不通无关：数是台账数出来的，
            所以停用、锁着、读失败时照样说，只有「后端报不出」才不说。 */}
        {typeof pooled === 'number' && (
          <EntryStatusFact label={t('sms_service.pool_fact_pooled')}>
            {t(
              kind === 'phone'
                ? 'sms_service.pool_value_pooled_phone'
                : 'sms_service.pool_value_pooled_email',
              { n: pooled }
            )}
          </EntryStatusFact>
        )}

        {status.kind === 'phone' && (
          <>
            <EntryStatusFact
              label={t('sms_service.pool_fact_balance')}
              tone={status.balanceCny === null ? 'warn' : 'plain'}
              title={status.balanceCny === null ? status.balanceError || undefined : undefined}
            >
              {status.balanceCny === null
                ? t('sms_service.row_phone_balance_unknown')
                : t('sms_service.pool_value_balance', { amount: status.balanceCny.toFixed(2) })}
            </EntryStatusFact>
            {status.latestAt !== null && (
              <EntryStatusFact label={t('sms_service.pool_fact_latest_phone')}>
                {formatReceivedAt(status.latestAt)}
              </EntryStatusFact>
            )}
          </>
        )}

        {status.kind === 'email' && (
          <>
            {status.mailbox !== '' && (
              <EntryStatusFact label={t('sms_service.pool_fact_mailbox')} mono>
                {status.domain ? `${status.mailbox} → @${status.domain}` : status.mailbox}
              </EntryStatusFact>
            )}
            {status.latest !== null && (
              <EntryStatusFact label={t('sms_service.pool_fact_latest_mail')}>
                <span>
                  {formatReceivedAt(status.latest.receivedAt) !== ''
                    ? `${formatReceivedAt(status.latest.receivedAt)} · `
                    : ''}
                  {status.latest.from || status.latest.subject || '—'}
                </span>
                {status.latest.code !== '' && (
                  <span className={styles.stripCode}>
                    {t('sms_service.row_email_code', { code: status.latest.code })}
                  </span>
                )}
              </EntryStatusFact>
            )}
          </>
        )}

        {egress !== undefined && egress !== null && (
          <EntryStatusFact label={t('egress_pool.account_label')}>{egress}</EntryStatusFact>
        )}
      </EntryStatusFacts>

      {note !== '' && (
        <EntryStatusNote tone={status.kind === 'error' ? 'warn' : 'muted'}>{note}</EntryStatusNote>
      )}
    </EntryStatus>
  );
}
