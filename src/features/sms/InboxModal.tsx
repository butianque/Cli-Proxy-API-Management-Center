/**
 * 收件箱 —— 供应池里的邮箱最近收到了什么，一处看完。
 *
 * 它是**弹窗**，不是第三个视图：来信是「现在到了什么」，看完就关，回到台账继续干活。
 * 一次调用读全部（`scope=pool`），不逐地址去问 —— 逐地址读等于把同一个信箱连 N 次，
 * 而 N 只是池子里有多少个号。
 *
 * 四条边界：
 *
 * 1. **每条信都说出是哪个邮箱收到的**：一个池子有很多地址，只说「有一封」等于没说。
 * 2. **有码才显示码**：码是这里最常被拿的东西，所以它可点、复制后当场给回执；没有码
 *    的信不显示「无验证码」这种噪音。
 * 3. **没读到 ≠ 没有信**：读不到的信箱单独列出来，否则人会去翻一个根本没打开过的信箱。
 * 4. **没有可读的邮箱是空态**，不是错误：给出「下一步做什么」，不把内部原因摆上来。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { IconAlertTriangle } from '@/components/ui/icons';
import { emailApi } from '@/services/api/email';
import { copyToClipboard } from '@/utils/clipboard';
import { formatReceivedAt, toInboxView, type EmailInboxView } from './emailMapping';
import styles from './InboxModal.module.scss';

/** 一次看多少封。基座上限 50，再多一屏也翻不完。 */
const INBOX_LIMIT = 50;

/** 「已复制」留多久。 */
const COPIED_HINT_MS = 2000;

type Phase = 'loading' | 'ready' | 'error';

interface InboxModalProps {
  open: boolean;
  onClose: () => void;
}

export function InboxModal({ open, onClose }: InboxModalProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('loading');
  const [view, setView] = useState<EmailInboxView | null>(null);
  const [error, setError] = useState('');
  // 刷新与重试是同一个动作：重新读一次。计数器变化即重读。
  const [reloadKey, setReloadKey] = useState(0);
  const [copiedCode, setCopiedCode] = useState('');

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPhase('loading');
    setError('');
    void (async () => {
      try {
        const reading = toInboxView(
          await emailApi.getInbox({ scope: 'pool', limit: INBOX_LIMIT })
        );
        if (!alive) return;
        setView(reading);
        setPhase('ready');
      } catch (readError) {
        if (!alive) return;
        // 「还没有可读的邮箱」不是错误，是还没开始用。
        if (emailApi.isUnavailable(readError)) {
          setView(null);
          setPhase('ready');
          return;
        }
        setError(emailApi.describeError(readError, t('sms_service.inbox_error')));
        setPhase('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, reloadKey, t]);

  useEffect(() => {
    if (!copiedCode) return;
    const timer = window.setTimeout(() => setCopiedCode(''), COPIED_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [copiedCode]);

  const reload = () => setReloadKey((value) => value + 1);

  const handleCopyCode = async (code: string) => {
    if (await copyToClipboard(code)) setCopiedCode(code);
  };

  const messages = view?.messages ?? [];
  const unread = view?.unread ?? [];
  const readable = view !== null && view.enabled;
  const empty = phase === 'ready' && (!readable || (messages.length === 0 && unread.length === 0));

  return (
    <Modal
      open={open}
      title={t('sms_service.inbox_title')}
      onClose={onClose}
      width={720}
      footer={
        <>
          <Button variant="ghost" onClick={reload} loading={phase === 'loading'}>
            {t('sms_service.inbox_refresh')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        {phase === 'loading' && (
          <div className={styles.loading}>
            <LoadingSpinner size={16} />
            <span className={styles.note}>{t('common.loading')}</span>
          </div>
        )}

        {phase === 'error' && (
          <div className={styles.errorRow}>
            <IconAlertTriangle size={15} />
            <span className={styles.errorText}>{error}</span>
            <Button variant="secondary" size="sm" onClick={reload}>
              {t('sms_service.inbox_retry')}
            </Button>
          </div>
        )}

        {empty && (
          <EmptyState
            title={t('sms_service.inbox_empty')}
            description={t('sms_service.inbox_empty_desc')}
          />
        )}

        {phase === 'ready' && messages.length > 0 && (
          <ul className={styles.list}>
            {messages.map((mail, index) => (
              <li
                className={styles.item}
                key={`${mail.channelId}-${mail.receivedAt ?? ''}-${index}`}
              >
                <div className={styles.itemHead}>
                  {mail.mailbox !== '' && (
                    <span className={styles.itemMailbox}>{mail.mailbox}</span>
                  )}
                  {formatReceivedAt(mail.receivedAt) !== '' && (
                    <span className={styles.itemTime}>
                      {formatReceivedAt(mail.receivedAt)}
                    </span>
                  )}
                </div>
                <div className={styles.itemMain}>
                  <div className={styles.itemText}>
                    {mail.subject !== '' && (
                      <span className={styles.itemSubject}>{mail.subject}</span>
                    )}
                    {mail.from !== '' && <span className={styles.itemFrom}>{mail.from}</span>}
                    {mail.preview !== '' && <p className={styles.itemPreview}>{mail.preview}</p>}
                  </div>
                  {mail.code !== '' && (
                    <button
                      type="button"
                      className={styles.codeChip}
                      aria-label={t('sms_service.inbox_copy_code', { code: mail.code })}
                      onClick={() => void handleCopyCode(mail.code)}
                    >
                      {copiedCode === mail.code
                        ? t('sms_service.inbox_copied')
                        : mail.code}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* 没读到的信箱单独说：它解释的是「这些地方没有答案」，不是「这些地方没有信」。 */}
        {unread.length > 0 && (
          <div className={styles.unreadBlock}>
            <div className={styles.unreadTitle}>{t('sms_service.inbox_unread_mailboxes')}</div>
            <ul className={styles.failureList}>
              {unread.map((item) => (
                <li key={item.channelId || item.mailbox} className={styles.failureItem}>
                  <span className={styles.failureAccount}>{item.mailbox}</span>
                  <span className={styles.failureDetail}>{item.error}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
