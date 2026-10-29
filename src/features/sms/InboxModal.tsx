/**
 * 收件箱 —— 三栏：邮箱 → 这个邮箱的信 → 选中那封信的内容。
 *
 * 一列混排时「哪个邮箱有新信」只能靠眼睛扫；池子里有上百个号，扫不动。按邮箱分栏后，
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

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import {
  IconAlertTriangle,
  IconCopy,
  IconRefreshCw,
  IconSearch,
} from '@/components/ui/icons';
import { emailApi } from '@/services/api/email';
import { supplyApi } from '@/services/api/supply';
import { copyToClipboard } from '@/utils/clipboard';
import {
  formatReceivedAt,
  orderMailboxAddresses,
  pickDefaultMailbox,
  prefetchBelow,
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

/** 键 = `"某字段":`，值 = 这一行剩下的部分（含逗号）。只用来上色，不改一个字符。 */
const JSON_KEY_LINE = /^(\s*"[A-Za-z]+":\s*)(.*)$/;

type Phase = 'loading' | 'ready' | 'error';

interface InboxModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 一行 JSON 拆成「键 + 值」。
 *
 * 文本本身来自 `JSON.stringify`，这里只是挑出键来上色 —— 复制出去与看到的逐字符一致。
 */
function splitJsonLine(line: string): { key: string; value: string } {
  const match = JSON_KEY_LINE.exec(line);
  if (!match) return { key: '', value: line };
  return { key: match[1], value: match[2] };
}

export function InboxModal({ open, onClose }: InboxModalProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('loading');
  const [addresses, setAddresses] = useState<string[]>([]);
  const [slots, setSlots] = useState<Record<string, EmailMailboxSlot>>({});
  const [selected, setSelected] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  // 第一批读完了没有。默认选中要等它 —— 否则会挑到「最先回来的」而不是「最新来信的」。
  const [batchDone, setBatchDone] = useState(false);
  // 重新读：计数器变化即重读。列表读不出来时由它重试。
  const [reloadKey, setReloadKey] = useState(0);
  const [copiedCode, setCopiedCode] = useState('');
  const [copiedJson, setCopiedJson] = useState(false);

  // 一次打开算一次会话：换会话后回来的响应一律作废，否则旧邮箱的信会落到新列表上。
  const runRef = useRef(0);
  // 同一个邮箱不并发读两遍：一次读取就是一次登录。键里带会话号，重读时不会误挡自己。
  const inflightRef = useRef(new Set<string>());
  // 异步回来的错误文案要用当下的语言，而不是发起那一刻的。
  const translateRef = useRef(t);

  useEffect(() => {
    translateRef.current = t;
  }, [t]);

  const readMailbox = useCallback(async (address: string) => {
    const run = runRef.current;
    const key = `${run}:${address}`;
    if (inflightRef.current.has(key)) return;
    inflightRef.current.add(key);
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
      // 读失败不抹掉上一次读到的信：一封已经在眼前，不能因为一次刷新失败就消失。
      setSlots((current) => {
        const previous = current[address]?.reading ?? null;
        return {
          ...current,
          [address]: {
            loading: false,
            reading: {
              messages: previous?.messages ?? [],
              latestAt: previous?.latestAt ?? null,
              error: reason,
            },
          },
        };
      });
    } finally {
      inflightRef.current.delete(key);
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
    setQuery('');
    setBatchDone(false);
    void (async () => {
      try {
        // 池子清单不连邮箱：先把地址列全，读信再一个个来。
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
    // 从点的这一行往下预热：只数没读过、也没在读的，数满 PREFETCH 个真正的新请求。
    for (const candidate of prefetchBelow(addresses, slots, address, PREFETCH)) {
      void readMailbox(candidate);
    }
  };

  const handleCopyCode = async (code: string) => {
    if (await copyToClipboard(code)) setCopiedCode(code);
  };

  const handleCopyJson = async (json: string) => {
    if (await copyToClipboard(json)) setCopiedJson(true);
  };

  const ordered = orderMailboxAddresses(addresses, slots);
  const needle = query.trim().toLowerCase();
  const visible =
    needle === ''
      ? ordered
      : ordered.filter((address) => address.toLowerCase().includes(needle));

  const readCount = addresses.filter((address) => {
    const reading = slots[address]?.reading ?? null;
    return reading !== null && reading.error === '';
  }).length;

  const selectedSlot = slots[selected] ?? NOT_READ;
  const reading = selectedSlot.reading;
  const messages = reading?.messages ?? [];
  // 按当下来信数夹住：重新读之后信变少了，中间高亮的和右栏显示的不能各说各的。
  const activeIndex = messages.length === 0 ? 0 : Math.min(selectedIndex, messages.length - 1);
  const mail = messages[activeIndex] ?? null;
  const mailDocument =
    mail !== null && selected !== '' ? toMessageDocument(selected, mail) : null;
  const json = mailDocument === null ? '' : JSON.stringify(mailDocument, null, 2);
  const jsonLines = json === '' ? [] : json.split('\n');

  const poolEmpty = phase === 'ready' && addresses.length === 0;
  // 正在重读时不算失败：上一次的原因先收起来，别让「重试」按钮跟着一闪。
  const readingFailed = !selectedSlot.loading && reading !== null && reading.error !== '';

  return (
    <Modal
      open={open}
      title={t('sms_service.inbox_title')}
      onClose={onClose}
      width={1080}
      className={styles.modal}
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
            <aside className={styles.mailboxes} aria-label={t('sms_service.inbox_mailboxes')}>
              <div className={styles.paneHead}>
                <span className={styles.paneTitle}>{t('sms_service.inbox_mailboxes')}</span>
                <span className={styles.progress}>
                  {t('sms_service.inbox_progress', {
                    done: readCount,
                    total: addresses.length,
                  })}
                </span>
              </div>

              <div className={styles.filterRow}>
                <IconSearch size={14} />
                <input
                  type="search"
                  className={`input ${styles.filterInput}`}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('sms_service.inbox_filter')}
                  aria-label={t('sms_service.inbox_filter')}
                />
              </div>

              <ul className={styles.mailboxList}>
                {visible.map((address) => {
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
                        <span className={styles.mailboxTop}>
                          <span className={styles.mailboxAddress} title={address}>
                            {address}
                          </span>
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
                        <span className={styles.mailboxMeta}>{meta}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              {visible.length === 0 && (
                <p className={styles.panePlaceholder}>{t('sms_service.inbox_filter_empty')}</p>
              )}
            </aside>

            <section className={styles.messages} aria-label={t('sms_service.inbox_messages')}>
              <div className={styles.paneHead}>
                <span className={styles.paneTitleMono} title={selected}>
                  {selected === '' ? t('sms_service.inbox_messages') : selected}
                </span>
                {selected !== '' && (
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label={t('sms_service.inbox_refresh')}
                    title={t('sms_service.inbox_refresh')}
                    onClick={() => void readMailbox(selected)}
                    disabled={selectedSlot.loading}
                  >
                    <IconRefreshCw size={14} />
                  </button>
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

              {selected !== '' && selectedSlot.loading && messages.length === 0 && (
                <div className={styles.center}>
                  <LoadingSpinner size={16} />
                </div>
              )}

              {selected !== '' && readingFailed && (
                <div className={styles.paneError}>
                  <div className={styles.errorRow}>
                    <IconAlertTriangle size={15} />
                    <span className={styles.errorText}>{t('sms_service.inbox_failed')}</span>
                  </div>
                  {reading !== null && reading.error !== '' && (
                    <p className={styles.paneErrorDetail}>{reading.error}</p>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void readMailbox(selected)}
                  >
                    {t('sms_service.inbox_retry')}
                  </Button>
                </div>
              )}

              {selected !== '' &&
                !selectedSlot.loading &&
                !readingFailed &&
                messages.length === 0 && (
                  <p className={styles.placeholder}>{t('sms_service.inbox_mailbox_empty')}</p>
                )}

              {messages.length > 0 && (
                <ul className={styles.messageList}>
                  {messages.map((item, index) => (
                    <li key={`${item.receivedAt ?? ''}-${index}`}>
                      <button
                        type="button"
                        className={`${styles.message} ${
                          index === activeIndex ? styles.messageActive : ''
                        }`}
                        aria-current={index === activeIndex ? 'true' : undefined}
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

            <section className={styles.content} aria-label={t('sms_service.inbox_content_title')}>
              <div className={styles.paneHead}>
                <span className={styles.paneTitle}>
                  {t('sms_service.inbox_content_title')}
                </span>
                {mailDocument !== null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleCopyJson(json)}
                  >
                    <IconCopy size={14} />
                    {copiedJson ? t('sms_service.inbox_copied') : t('sms_service.inbox_copy_json')}
                  </Button>
                )}
              </div>

              {mailDocument === null || mail === null ? (
                <p className={styles.placeholder}>{t('sms_service.inbox_select_message')}</p>
              ) : (
                <div className={styles.contentBody}>
                  {mail.code !== '' && (
                    <div className={styles.codeBar}>
                      <span className={styles.codeLabel}>
                        {t('sms_service.inbox_code_label')}
                      </span>
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
                    </div>
                  )}
                  <pre className={styles.json}>
                    {jsonLines.map((line, index) => {
                      const { key, value } = splitJsonLine(line);
                      const trimmed = value.replace(/,\s*$/, '').trim();
                      const valueClass =
                        trimmed === '""' || trimmed === '[]' || trimmed === 'null'
                          ? styles.jsonEmpty
                          : styles.jsonValue;
                      return (
                        <Fragment key={index}>
                          {key !== '' ? (
                            <>
                              <span className={styles.jsonKey}>{key}</span>
                              <span className={valueClass}>{value}</span>
                            </>
                          ) : (
                            <span
                              className={
                                /^[[\]{}]/.test(value.trim())
                                  ? styles.jsonPunctuation
                                  : valueClass
                              }
                            >
                              {value}
                            </span>
                          )}
                          {index < jsonLines.length - 1 ? '\n' : ''}
                        </Fragment>
                      );
                    })}
                  </pre>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}