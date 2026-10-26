/**
 * 收件箱 —— 三栏：邮箱 → 这个邮箱的信 → 选中那封信的内容。
 *
 * 一列混排时「哪个邮箱有新信」只能靠眼睛扫；池子里有二十个号，扫不动。按邮箱分栏后，
 * 左边是邮箱、中间是这个邮箱收到的信、右边是选中那封的全部可得字段。
 *
 * 四条边界：
 *
 * 1. **弹性读取**：池子清单不连邮箱（免费），一进来就列全；信要连上邮箱才读得到，所以
 *    先读一批、点了谁再读谁、并顺带预热后面几个 —— 进入不用等整池登录完。
 * 2. **没读到 ≠ 没有信**：还没读的说「未读取」，读失败的说「读取失败」。把没打开过的
 *    信箱画成空的，人会去翻一个从没打开过的地方。
 * 3. **默认落在最新的一封**：第一批回来就选中「最新来信的那个邮箱」的第一封，不用先点
 *    两下；用户自己点过之后不再自动改选。
 * 4. **右栏照实显示**：一封信在 HTTP 上只有元数据与 240 字节摘录（全文只走插件通道），
 *    所以 JSON 里就是这些字段，不多不少；验证码单独可复制。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { IconAlertTriangle, IconCopy, IconRefreshCw } from '@/components/ui/icons';
import { emailApi } from '@/services/api/email';
import { supplyApi } from '@/services/api/supply';
import { copyToClipboard } from '@/utils/clipboard';
import {
  formatReceivedAt,
  orderMailboxAddresses,
  pickDefaultMailbox,
  toMailboxReading,
  toMessageDocument,
  toPoolAddresses,
  type EmailMailboxSlot,
} from './emailMapping';
import styles from './InboxModal.module.scss';

/** 进来先读几个邮箱：第一批回来就有真实排序和默认选中，不用等整池登录完。 */
const FIRST_BATCH = 4;

/** 点一个邮箱时顺带预热几个：再点下一个就不用等。 */
const PREFETCH = 3;

/** 每个邮箱读多少封。基座每个文件夹留 20 封，这里不再要更多。 */
const MAIL_LIMIT = 20;

/** 「已复制」留多久。 */
const COPIED_HINT_MS = 2000;

/** 还没读过的一行。共享同一个对象：它不会被改。 */
const NOT_READ: EmailMailboxSlot = { loading: false, reading: null };

type Phase = 'loading' | 'ready' | 'error';

interface InboxModalProps {
  open: boolean;
  onClose: () => void;
}

export function InboxModal({ open, onClose }: InboxModalProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('loading');
  const [addresses, setAddresses] = useState<string[]>([]);
  const [slots, setSlots] = useState<Record<string, EmailMailboxSlot>>({});
  const [selected, setSelected] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState('');
  // 第一批读完了没有。默认选中要等它 —— 否则会挑到「最先回来的」而不是「最新来信的」。
  const [batchDone, setBatchDone] = useState(false);
  // 刷新与重试是同一个动作：重新读一次。计数器变化即重读。
  const [reloadKey, setReloadKey] = useState(0);
  const [copiedCode, setCopiedCode] = useState('');
  const [copiedJson, setCopiedJson] = useState(false);

  // 一次打开算一次会话：换会话后回来的响应一律作废，否则旧邮箱的信会落到新列表上。
  const runRef = useRef(0);
  // 同一个邮箱不并发读两遍：一次读取就是一次登录。
  const inflightRef = useRef(new Set<string>());
  // 异步回来的错误文案要用当下的语言，而不是发起那一刻的。
  const translateRef = useRef(t);

  useEffect(() => {
    translateRef.current = t;
  }, [t]);

  const readMailbox = useCallback(async (address: string) => {
    if (inflightRef.current.has(address)) return;
    inflightRef.current.add(address);
    const run = runRef.current;
    setSlots((current) => ({
      ...current,
      [address]: { loading: true, reading: current[address]?.reading ?? null },
    }));
    try {
      const reading = toMailboxReading(
        await emailApi.getInbox({ address, limit: MAIL_LIMIT })
      );
      if (runRef.current !== run) return;
      setSlots((current) => ({ ...current, [address]: { loading: false, reading } }));
    } catch (readError) {
      if (runRef.current !== run) return;
      const reason = emailApi.describeError(
        readError,
        translateRef.current('sms_service.inbox_error')
      );
      setSlots((current) => ({
        ...current,
        [address]: { loading: false, reading: { messages: [], latestAt: null, error: reason } },
      }));
    } finally {
      inflightRef.current.delete(address);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const run = runRef.current + 1;
    runRef.current = run;
    inflightRef.current.clear();
    setPhase('loading');
    setError('');
    setAddresses([]);
    setSlots({});
    setSelected('');
    setSelectedIndex(0);
    setBatchDone(false);
    void (async () => {
      try {
        // 池子清单不连邮箱：先把二十个地址列全，读信再一个个来。
        const pool = toPoolAddresses(await supplyApi.listPool('email'));
        if (runRef.current !== run) return;
        setAddresses(pool);
        setPhase('ready');
        await Promise.all(pool.slice(0, FIRST_BATCH).map((address) => readMailbox(address)));
        if (runRef.current !== run) return;
        setBatchDone(true);
      } catch (listError) {
        if (runRef.current !== run) return;
        setError(
          emailApi.describeError(listError, translateRef.current('sms_service.inbox_error'))
        );
        setPhase('error');
      }
    })();
  }, [open, reloadKey, readMailbox]);

  // 默认选中：等第一批读完再挑，否则会挑到「最先回来的那个」而不是「最新来信的那个」。
  useEffect(() => {
    if (!batchDone || selected !== '') return;
    const pick = pickDefaultMailbox(addresses, slots);
    if (pick !== '') setSelected(pick);
  }, [addresses, batchDone, selected, slots]);

  useEffect(() => {
    if (!copiedCode) return;
    const timer = window.setTimeout(() => setCopiedCode(''), COPIED_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [copiedCode]);

  useEffect(() => {
    if (!copiedJson) return;
    const timer = window.setTimeout(() => setCopiedJson(false), COPIED_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [copiedJson]);

  const reload = () => setReloadKey((value) => value + 1);

  const handleSelectMailbox = (address: string) => {
    setSelected(address);
    setSelectedIndex(0);
    const slot = slots[address] ?? NOT_READ;
    // 读过就不再读：每点一次都登录一遍，等于把一个只读的动作做成有成本的。
    if (!slot.loading && (slot.reading === null || slot.reading.error !== '')) {
      void readMailbox(address);
    }
    // 预热后面几个：用户往下点的时候就不用再等。
    const ordered = orderMailboxAddresses(addresses, slots);
    const from = ordered.indexOf(address);
    if (from < 0) return;
    const ahead = ordered
      .slice(from + 1)
      .filter((candidate) => (slots[candidate]?.reading ?? null) === null)
      .slice(0, PREFETCH);
    for (const candidate of ahead) void readMailbox(candidate);
  };

  const handleCopyCode = async (code: string) => {
    if (await copyToClipboard(code)) setCopiedCode(code);
  };

  const handleCopyJson = async (json: string) => {
    if (await copyToClipboard(json)) setCopiedJson(true);
  };

  const ordered = orderMailboxAddresses(addresses, slots);
  const readCount = addresses.filter((address) => {
    const reading = slots[address]?.reading ?? null;
    return reading !== null && reading.error === '';
  }).length;

  const selectedSlot = slots[selected] ?? NOT_READ;
  const reading = selectedSlot.reading;
  const messages = reading?.messages ?? [];
  const mail = messages[Math.min(selectedIndex, Math.max(messages.length - 1, 0))] ?? null;
  const document = mail !== null && selected !== '' ? toMessageDocument(selected, mail) : null;

  const poolEmpty = phase === 'ready' && addresses.length === 0;
  // 正在重读时不算失败：上一次的原因先收起来，别让「重试」按钮跟着一闪。
  const readingFailed =
    !selectedSlot.loading && reading !== null && reading.error !== '';

  return (
    <Modal
      open={open}
      title={t('sms_service.inbox_title')}
      onClose={onClose}
      width={1080}
      className={styles.modal}
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
      <div className={styles.panes}>
        {phase === 'loading' && (
          <div className={styles.center}>
            <LoadingSpinner size={16} />
            <span className={styles.note}>{t('common.loading')}</span>
          </div>
        )}

        {phase === 'error' && (
          <div className={styles.center}>
            <div className={styles.errorRow}>
              <IconAlertTriangle size={15} />
              <span className={styles.errorText}>{error}</span>
            </div>
            <Button variant="secondary" size="sm" onClick={reload}>
              {t('sms_service.inbox_retry')}
            </Button>
          </div>
        )}

        {poolEmpty && (
          <div className={styles.center}>
            <EmptyState
              title={t('sms_service.inbox_empty')}
              description={t('sms_service.inbox_empty_desc')}
            />
          </div>
        )}

        {phase === 'ready' && addresses.length > 0 && (
          <>
            <aside className={styles.mailboxes}>
              <div className={styles.paneHead}>
                <span className={styles.paneTitle}>{t('sms_service.inbox_mailboxes')}</span>
                <span className={styles.progress}>
                  {t('sms_service.inbox_progress', {
                    done: readCount,
                    total: addresses.length,
                  })}
                </span>
              </div>
              <ul className={styles.mailboxList}>
                {ordered.map((address) => {
                  const slot = slots[address] ?? NOT_READ;
                  const box = slot.reading;
                  const active = address === selected;
                  let meta = (
                    <span className={styles.mailboxState}>{t('sms_service.inbox_unread')}</span>
                  );
                  if (slot.loading) {
                    meta = (
                      <span className={styles.mailboxState}>
                        {t('sms_service.inbox_reading')}
                      </span>
                    );
                  } else if (box !== null && box.error !== '') {
                    meta = (
                      <span className={styles.mailboxFailed}>{t('sms_service.inbox_failed')}</span>
                    );
                  } else if (box !== null && box.latestAt === null) {
                    meta = (
                      <span className={styles.mailboxState}>
                        {t('sms_service.inbox_mailbox_empty')}
                      </span>
                    );
                  } else if (box !== null && box.latestAt !== null) {
                    meta = (
                      <span className={styles.mailboxTime}>{formatReceivedAt(box.latestAt)}</span>
                    );
                  }
                  return (
                    <li key={address}>
                      <button
                        type="button"
                        className={`${styles.mailbox} ${active ? styles.mailboxActive : ''}`}
                        aria-current={active ? 'true' : undefined}
                        onClick={() => handleSelectMailbox(address)}
                      >
                        <span className={styles.mailboxAddress}>{address}</span>
                        <span className={styles.mailboxMeta}>
                          {meta}
                          {box !== null && box.error === '' && box.messages.length > 0 && (
                            <span
                              className={styles.countBadge}
                              aria-label={t('sms_service.inbox_count_label', {
                                count: box.messages.length,
                              })}
                            >
                              {box.messages.length >= MAIL_LIMIT
                                ? t('sms_service.inbox_count_more', { count: MAIL_LIMIT })
                                : box.messages.length}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </aside>

            <section className={styles.messages}>
              <div className={styles.paneHead}>
                <span className={styles.paneTitleMono}>
                  {selected === '' ? t('sms_service.inbox_messages') : selected}
                </span>
                {selected !== '' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('sms_service.inbox_refresh')}
                    onClick={() => void readMailbox(selected)}
                    loading={selectedSlot.loading}
                  >
                    <IconRefreshCw size={14} />
                  </Button>
                )}
              </div>

              {selected === '' && !batchDone && (
                <div className={styles.center}>
                  <LoadingSpinner size={16} />
                </div>
              )}

              {selected === '' && batchDone && (
                <p className={styles.placeholder}>{t('sms_service.inbox_select_mailbox')}</p>
              )}

              {selected !== '' && readingFailed && (
                <div className={styles.paneError}>
                  <div className={styles.errorRow}>
                    <IconAlertTriangle size={15} />
                    <span className={styles.errorText}>{reading?.error}</span>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void readMailbox(selected)}
                  >
                    {t('sms_service.inbox_retry')}
                  </Button>
                </div>
              )}

              {selected !== '' && selectedSlot.loading && messages.length === 0 && (
                <div className={styles.center}>
                  <LoadingSpinner size={16} />
                </div>
              )}

              {selected !== '' && !selectedSlot.loading && !readingFailed && messages.length === 0 && (
                <p className={styles.placeholder}>{t('sms_service.inbox_mailbox_empty')}</p>
              )}

              {messages.length > 0 && (
                <ul className={styles.messageList}>
                  {messages.map((item, index) => (
                    <li key={`${item.receivedAt ?? ''}-${index}`}>
                      <button
                        type="button"
                        className={`${styles.message} ${
                          index === selectedIndex ? styles.messageActive : ''
                        }`}
                        aria-current={index === selectedIndex ? 'true' : undefined}
                        onClick={() => setSelectedIndex(index)}
                      >
                        <span className={styles.messageTop}>
                          <span className={styles.messageSubject}>
                            {item.subject !== ''
                              ? item.subject
                              : t('sms_service.inbox_no_subject')}
                          </span>
                          <span className={styles.messageTime}>
                            {formatReceivedAt(item.receivedAt)}
                          </span>
                        </span>
                        {item.from !== '' && (
                          <span className={styles.messageFrom}>{item.from}</span>
                        )}
                        {item.preview !== '' && (
                          <span className={styles.messagePreview}>{item.preview}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={styles.content}>
              <div className={styles.paneHead}>
                <span className={styles.paneTitle}>
                  {t('sms_service.inbox_content_title')}
                </span>
                {document !== null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleCopyJson(JSON.stringify(document, null, 2))}
                  >
                    <IconCopy size={14} />
                    {copiedJson ? t('sms_service.inbox_copied') : t('sms_service.inbox_copy_json')}
                  </Button>
                )}
              </div>

              {document === null || mail === null ? (
                <p className={styles.placeholder}>{t('sms_service.inbox_select_message')}</p>
              ) : (
                <div className={styles.contentBody}>
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
                  <pre className={styles.json}>{JSON.stringify(document, null, 2)}</pre>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
