/**
 * 导入邮箱 —— 把一批邮箱一次写进密钥库与供应池。
 *
 * 入口在号码池页头，紧挨「配置」：买回来的一批邮箱先落库，才谈得上用。
 *
 * 卖家给的批次有两种形态，所以这里先问「你手上是什么」，再走各自的路：
 *
 * - **粘贴导入**：卖家给了刷新令牌。整段文本发给基座，基座解析、验证、写库，回包里
 *   只有账号与结局。面板既不解析凭据，也不缓存它。
 * - **登记地址**：手上已经有一个在用的地址（多半是自建域下现编的），只要能查得到
 *   「它注册过什么」就够了。这条只写台账，不写凭据 —— 那个域的信全落进渠道的
 *   catch-all 信箱，给一个虚拟地址配一份口令，没人用得上。
 * - **授权导入**：卖家只给了账号。刷新令牌只能由账号本人在微软页面上登录一次换来，
 *   所以基座给出 8 位码，操作者逐个登录，凭据自动落库。
 *
 * 三条路共同的约定：
 *
 * 1. **值不经过面板**：面板从不持有、不解析、不落盘任何凭据；授权导入里它连凭据都
 *    见不到 —— 令牌从微软直接进基座的密钥库。
 * 2. **先说明白导入的是哪种邮箱，再问怎么收信**：同一份凭据通常只带一种访问权 —— 微软
 *    邮件接口、邮箱服务器、或者邮箱自己的密码。收信方式是使用者的答案，不是基座能猜
 *    的；选错时基座会说「令牌没有被授予这条路的权限」，换另一个再导一次即可。授权导入
 *    拿到的令牌只覆盖微软邮件接口，所以那一条不问。自建域名下的地址也没有自己的信箱 ——
 *    它走「登记地址」，读信交给渠道。
 * 3. **验证默认打开**：验证不通过的邮箱不会入库 —— 一条连不上的渠道只会在表里多一
 *    行永远读不到信的东西，还得有人手工清。
 * 4. **分批发送**：一批里每个邮箱都要做一次令牌交换和一次登录，默认的 30 秒请求超时
 *    只够几个；按 {@link IMPORT_CHUNK_LINES} 切片既能给出进度，也不会让一次请求等到
 *    超时。授权导入不用切片：它一次只等一个人。
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { IconAlertTriangle, IconCheckCircle2 } from '@/components/ui/icons';
import { emailApi, type EmailAuthorizeFlowWire, type EmailImportLineWire } from '@/services/api/email';
import { touchSession } from '@/services/api/session';
import { supplyApi } from '@/services/api/supply';
import { copyToClipboard } from '@/utils/clipboard';
import styles from './ImportMailboxesModal.module.scss';

/** 一次请求最多带多少行。基座在这批里并发验证，一片正好落在一次请求的超时之内。 */
const IMPORT_CHUNK_LINES = 20;

/** 登记地址一次最多带多少行，与基座的上限一致。 */
const NOTE_CHUNK_LINES = 500;

/**
 * 一批邮箱是怎么来的。
 *
 * 这不是排版上的花样：每条路的输入、基座做的事、操作者要做的事全都不同，混在一个
 * 输入框里只会让「粘了账号却提示格式不对」变成常态。
 */
type ImportMode = 'paste' | 'signin' | 'note';

const IMPORT_MODES: readonly ImportMode[] = ['paste', 'signin', 'note'];

/**
 * 收信方式。同一个信箱只走一条路，所以是单选。
 *
 * 三条路读的是同一批信，差别只在「拿什么去开这个信箱」：微软账号的授权、卖家给的
 * 刷新令牌、或者邮箱自己的密码。自有域名邮箱只有最后一条可用 —— 它的服务器不认识
 * 微软，也没有人会为它签发刷新令牌。
 */
type ReceivingMethod = 'graph' | 'oauth2' | 'imap';

const RECEIVING_METHODS: readonly ReceivingMethod[] = ['graph', 'oauth2', 'imap'];

/** 失败清单最多列多少条：整批都失败时，列 200 条既看不清也没有用。 */
const FAILURE_LIST_LIMIT = 20;

/** 等登录时的轮询间隔。读的是一张内存表，快一点也不会给微软添麻烦。 */
const SIGNIN_POLL_MS = 2000;

/** 复制成功提示留多久。 */
const COPIED_HINT_MS = 2000;

/**
 * 已经不会再变的结局。
 *
 * 其余状态（等登录、核对、保存、等口令）都还在走，面板据此判断「这一批结束了没有」。
 */
const TERMINAL_STATUSES = [
  'done',
  'denied',
  'expired',
  'failed',
  'cancelled',
] as const;

/** 每个结局在界面上怎么说。键是基座给的状态值，未知值按「还在等」显示。 */
const STATUS_KEYS: Record<string, string> = {
  waiting: 'sms_service.import_signin_status_waiting',
  verifying: 'sms_service.import_signin_status_verifying',
  saving: 'sms_service.import_signin_status_saving',
  done: 'sms_service.import_signin_status_done',
  denied: 'sms_service.import_signin_status_denied',
  expired: 'sms_service.import_signin_status_expired',
  failed: 'sms_service.import_signin_status_failed',
  cancelled: 'sms_service.import_signin_status_cancelled',
};

const isTerminal = (flow: EmailAuthorizeFlowWire): boolean =>
  (TERMINAL_STATUSES as readonly string[]).includes(flow.status ?? '');

const statusKey = (status: string | undefined): string =>
  STATUS_KEYS[status ?? ''] ?? 'sms_service.import_signin_status_waiting';

/** 剩余时间写成 `分:秒`：验证码以分钟计，秒数要一眼看得出在动。 */
function formatRemaining(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

interface ImportMailboxesModalProps {
  open: boolean;
  onClose: () => void;
  /** 关闭时调用，且只有真的导入过才调用 —— 页面据此把结果露出来。 */
  onImported: () => void;
  /**
   * 打开时停在哪条路、框里先放什么。
   *
   * 扫活里点「重新授权导入」就是这样进来的：那批号已经知道是哪些，让人再粘一遍
   * 等于把同一份清单抄两次。不传 = 从粘贴导入空着开始。
   */
  initialMode?: ImportMode | null;
  initialText?: string;
}

type Phase = 'idle' | 'busy' | 'done';

interface Summary {
  imported: number;
  updated: number;
  failed: number;
}

/** 登记地址的结论：登记了几条、更新了几条、几条不是地址、几条没有渠道覆盖。 */
interface NoteSummary {
  recorded: number;
  updated: number;
  failed: number;
  unlinked: number;
}

export function ImportMailboxesModal({
  open,
  onClose,
  onImported,
  initialMode = null,
  initialText = '',
}: ImportMailboxesModalProps) {
  const { t } = useTranslation();

  const [mode, setMode] = useState<ImportMode>('paste');

  // 粘贴导入
  const [text, setText] = useState('');
  const [verify, setVerify] = useState(true);
  const [method, setMethod] = useState<ReceivingMethod>('graph');
  // 自有邮箱的服务器地址。两段行没有地方写它，只能在这里给一次。
  const [imapHost, setImapHost] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failures, setFailures] = useState<EmailImportLineWire[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 授权导入
  const [flows, setFlows] = useState<EmailAuthorizeFlowWire[]>([]);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [signinError, setSigninError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [commitError, setCommitError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  // 登记地址
  const [notePhase, setNotePhase] = useState<Phase>('idle');
  const [noteSummary, setNoteSummary] = useState<NoteSummary | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);

  // 每次打开都是一次新的导入：上一批的结论留在上一批。
  useEffect(() => {
    if (!open) return;
    setMode(initialMode ?? 'paste');
    setText(initialText);
    setVerify(true);
    setMethod('graph');
    setImapHost('');
    setPhase('idle');
    setProgress({ done: 0, total: 0 });
    setSummary(null);
    setFailures([]);
    setError(null);
    setFlows([]);
    setStarting(false);
    setStopping(false);
    setSigninError(null);
    setCopied(false);
    setPassphrase('');
    setCommitError(null);
    setCommitting(false);
    setNotePhase('idle');
    setNoteSummary(null);
    setNoteError(null);
  }, [open, initialMode, initialText]);

  // 打开时先看一眼有没有还没走完的那一批。登录是人工的，一次可能等十几分钟，中途
  // 关掉弹窗或刷新页面都不该让它丢掉 —— 它还在基座那边等着，接上就行。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void emailApi
      .getAuthorization()
      .then((existing) => {
        if (cancelled) return;
        if (existing.some((flow) => !isTerminal(flow))) {
          setFlows(existing);
          setMode('signin');
        }
      })
      .catch(() => {
        // 读不到就是没有。这条路不该在打开弹窗时先给出一条错误。
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 只数「会真的发出去」的行：空行与 `#` 开头的说明行基座也会跳过。
  const lines = useMemo(
    () =>
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#')),
    [text]
  );
  const lineCount = lines.length;

  const current = flows.find((flow) => !isTerminal(flow)) ?? null;
  const running = current !== null;
  // 登录已经完成、只差保存：这一批不再自己往前走，等的是口令而不是码。此时给「停止」
  // 是一个点了看不出变化的按钮，所以底栏换成一个能真的收尾的「关闭」。
  const parked = current?.status === 'awaiting_unlock';
  const savedCount = flows.filter((flow) => flow.status === 'done').length;
  const missedFlows = flows.filter((flow) => isTerminal(flow) && flow.status !== 'done');
  // 填的地址与微软报的主地址不同（填的是别名）。这不是失败，但操作者要能看出
  // 这个号最终落在哪个地址上，否则池子里会多出一个他没写过的号。
  const aliasFlows = flows.filter(
    (flow) => flow.status === 'done' && flow.stored_as && flow.stored_as !== flow.account
  );
  const position = current ? flows.indexOf(current) + 1 : flows.length;
  const signinFinished = flows.length > 0 && !running;

  // 等登录期间一直读进展，并顺手替操作者续一次会话：服务端的空闲窗口是分钟级，而
  // 一次登录可能十几分钟 —— 不续的话，人还在输码就被登出了。
  useEffect(() => {
    if (!open || !running) return;
    const timer = window.setInterval(() => {
      void touchSession();
      void emailApi
        .getAuthorization()
        .then((next) => {
          if (next.length > 0) setFlows(next);
        })
        .catch(() => {
          // 一次读失败不该打断已经开始的那次登录；下一拍再试。
        });
    }, SIGNIN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, running]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleImport = async () => {
    if (lines.length === 0) {
      setError(t('sms_service.import_err_empty'));
      return;
    }
    setPhase('busy');
    setError(null);
    setFailures([]);
    setSummary(null);
    setProgress({ done: 0, total: lines.length });

    let imported = 0;
    let updated = 0;
    let failed = 0;
    const rejected: EmailImportLineWire[] = [];
    try {
      for (let start = 0; start < lines.length; start += IMPORT_CHUNK_LINES) {
        const chunk = lines.slice(start, start + IMPORT_CHUNK_LINES);
        const result = await emailApi.importMailboxes({
          text: chunk.join('\n'),
          probe: verify,
          nature: method,
          // 只有自有邮箱需要这一栏；其余两种的服务器地址是固定的，传上去反而多一个
          // 可以被误改的值。
          host: method === 'imap' ? imapHost : undefined,
        });
        if (!result.ok) {
          setError(
            result.reason === 'wrong-passphrase'
              ? t('sms_service.config_err_passphrase')
              : result.reason === 'locked'
                ? t('sms_service.config_err_locked')
                : t('sms_service.import_err_generic', { message: result.message })
          );
          break;
        }
        imported += result.imported;
        updated += result.updated;
        failed += result.failed;
        rejected.push(
          ...result.results.filter(
            (line) => line.outcome !== 'imported' && line.outcome !== 'updated'
          )
        );
        setProgress({ done: Math.min(start + IMPORT_CHUNK_LINES, lines.length), total: lines.length });
      }
    } finally {
      setSummary({ imported, updated, failed });
      setFailures(rejected);
      setPhase('done');
    }
  };

  /**
   * 登记已有的一批地址：只写台账，不碰凭据。
   *
   * 基座一次最多收 500 行，所以这里按同一个数切片 —— 超过的部分要么被整批拒掉，
   * 要么得让操作者自己分批，两种都比面板自己切开差。
   */
  const handleRecord = async () => {
    if (lines.length === 0) {
      setNoteError(t('sms_service.import_err_empty'));
      return;
    }
    setNotePhase('busy');
    setNoteError(null);
    setNoteSummary(null);
    let recorded = 0;
    let updated = 0;
    let failed = 0;
    let unlinked = 0;
    for (let start = 0; start < lines.length; start += NOTE_CHUNK_LINES) {
      const result = await supplyApi.importIdentities(
        lines.slice(start, start + NOTE_CHUNK_LINES)
      );
      if (!result.ok) {
        setNotePhase('done');
        setNoteError(t('sms_service.import_err_generic', { message: result.message }));
        return;
      }
      recorded += result.recorded;
      updated += result.updated;
      failed += result.failed;
      unlinked += result.unlinked;
    }
    setNotePhase('done');
    setNoteSummary({ recorded, updated, failed, unlinked });
  };

  const handleStartSignin = async () => {
    if (lines.length === 0) {
      setSigninError(t('sms_service.import_err_empty'));
      return;
    }
    setStarting(true);
    setSigninError(null);
    setFlows([]);
    const result = await emailApi.startAuthorization({ accounts: lines.join('\n') });
    setStarting(false);
    if (result.ok) {
      setFlows(result.flows);
      return;
    }
    if (result.reason === 'busy') {
      // 已经有一批在等：接上它。操作者要的是「继续」，不是一条错误。
      setFlows(await emailApi.getAuthorization());
      return;
    }
    setSigninError(
      result.reason === 'wrong-passphrase'
        ? t('sms_service.config_err_passphrase')
        : result.reason === 'locked'
          ? t('sms_service.config_err_locked')
          : t('sms_service.import_err_generic', { message: result.message })
    );
  };

  const handleStop = async () => {
    if (!current?.id) return;
    setStopping(true);
    try {
      setFlows(await emailApi.cancelAuthorization(current.id));
    } catch (stopError) {
      setSigninError(emailApi.describeError(stopError, t('sms_service.import_signin_err_stop')));
    } finally {
      setStopping(false);
    }
  };

  const handleCommit = async () => {
    if (!current?.id) return;
    setCommitting(true);
    setCommitError(null);
    const result = await emailApi.commitAuthorization(current.id, passphrase);
    setCommitting(false);
    if (!result.ok) {
      setCommitError(
        result.reason === 'wrong-passphrase'
          ? t('sms_service.config_err_passphrase')
          : result.reason === 'locked'
            ? t('sms_service.config_err_locked')
            : t('sms_service.import_err_generic', { message: result.message })
      );
      return;
    }
    setPassphrase('');
    setFlows(result.flows);
  };

  const handleCopyCode = async () => {
    if (!current?.user_code) return;
    if (await copyToClipboard(current.user_code)) setCopied(true);
  };

  const importedSomething =
    mode === 'signin'
      ? savedCount > 0
      : mode === 'note'
        ? (noteSummary?.recorded ?? 0) + (noteSummary?.updated ?? 0) > 0
        : (summary?.imported ?? 0) + (summary?.updated ?? 0) > 0;

  const handleClose = () => {
    if (importedSomething) onImported();
    onClose();
  };

  const pasteFooter =
    phase === 'done' ? (
      <Button variant="secondary" onClick={handleClose}>
        {t('sms_service.import_close')}
      </Button>
    ) : (
      <>
        <Button variant="ghost" onClick={handleClose} disabled={phase === 'busy'}>
          {t('sms_service.config_cancel')}
        </Button>
        <Button onClick={handleImport} loading={phase === 'busy'} disabled={lineCount === 0}>
          {phase === 'busy'
            ? t('sms_service.import_progress', {
                done: progress.done,
                total: progress.total,
              })
            : t('sms_service.import_start')}
        </Button>
      </>
    );

  // 登记地址：一批一请求，没有逐个进行的步骤，所以底栏只有「取消 / 登记」。
  const noteFooter =
    notePhase === 'done' ? (
      <Button variant="secondary" onClick={handleClose}>
        {t('sms_service.import_close')}
      </Button>
    ) : (
      <>
        <Button variant="ghost" onClick={handleClose} disabled={notePhase === 'busy'}>
          {t('sms_service.config_cancel')}
        </Button>
        <Button onClick={handleRecord} loading={notePhase === 'busy'} disabled={lineCount === 0}>
          {t('sms_service.import_note_start')}
        </Button>
      </>
    );

  // 等登录时只有一个动作：停止。等的是浏览器里的那个人，面板这边没有别的事可做。
  // 只差保存时（parked）连停止都不必了 —— 那一批已经不再自己往前走，底栏给关闭。
  const signinFooter = signinFinished || parked ? (
    <Button variant="secondary" onClick={handleClose}>
      {t('sms_service.import_close')}
    </Button>
  ) : running ? (
    <Button variant="ghost" onClick={handleStop} loading={stopping}>
      {t('sms_service.import_signin_stop')}
    </Button>
  ) : (
    <>
      <Button variant="ghost" onClick={handleClose}>
        {t('sms_service.config_cancel')}
      </Button>
      <Button onClick={handleStartSignin} loading={starting} disabled={lineCount === 0}>
        {t('sms_service.import_signin_start')}
      </Button>
    </>
  );

  return (
    <Modal
      open={open}
      title={t('sms_service.import_title')}
      onClose={handleClose}
      footer={
        mode === 'signin' ? signinFooter : mode === 'note' ? noteFooter : pasteFooter
      }
      width={640}
    >
      <div className={styles.body}>
        {/* 先问手上是什么，再问怎么走：每条路的输入完全不同，混在一起只会互相拖累。 */}
        <div className={styles.choiceGroup}>
          <span className={styles.fieldLabel}>{t('sms_service.import_mode_label')}</span>
          <div className={styles.choiceCards}>
            {IMPORT_MODES.map((value) => (
              <label className={styles.choiceCard} key={value}>
                <input
                  type="radio"
                  name="mailbox-import-mode"
                  checked={mode === value}
                  onChange={() => setMode(value)}
                  disabled={running || phase === 'busy' || notePhase === 'busy'}
                />
                <span className={styles.choiceTitle}>{t(`sms_service.import_mode_${value}`)}</span>
                <span className={styles.choiceNote}>
                  {t(`sms_service.import_mode_${value}_note`)}
                </span>
              </label>
            ))}
          </div>
        </div>

        <p className={styles.lead}>
          {mode === 'signin'
            ? t('sms_service.import_signin_lead')
            : mode === 'note'
              ? t('sms_service.import_note_lead')
              : method === 'imap'
                ? t('sms_service.import_lead_imap')
                : t('sms_service.import_lead')}
        </p>

        {mode === 'paste' && (
          <div className={styles.choiceGroup}>
            <span className={styles.fieldLabel}>{t('sms_service.import_method_label')}</span>
            <div className={styles.choiceCards}>
              {RECEIVING_METHODS.map((value) => (
                <label className={styles.choiceCard} key={value}>
                  <input
                    type="radio"
                    name="mailbox-import-method"
                    checked={method === value}
                    onChange={() => setMethod(value)}
                    disabled={phase === 'busy'}
                  />
                  <span className={styles.choiceTitle}>
                    {t(`sms_service.import_method_${value}`)}
                  </span>
                  <span className={styles.choiceNote}>
                    {t(`sms_service.import_method_${value}_note`)}
                  </span>
                </label>
              ))}
            </div>
            {method !== 'imap' && (
              <span className={styles.note}>{t('sms_service.import_method_hint')}</span>
            )}
          </div>
        )}

        {/* 自有邮箱的服务器地址：两段行没有地方写它，只能在这里给一次。三段的行会用
            自己那一段覆盖它，所以一栏可以同时服务两种写法。缺服务器的那一行由基座
            逐行拒绝并说清缺什么 —— 面板不解析粘贴内容，也就不会替它猜一个服务器。 */}
        {mode === 'paste' && method === 'imap' && (
          <Input
            label={t('sms_service.import_imap_host')}
            placeholder={t('sms_service.import_imap_host_placeholder')}
            value={imapHost}
            onChange={(event) => {
              setImapHost(event.target.value);
              setError(null);
            }}
            disabled={phase === 'busy'}
            autoComplete="off"
            spellCheck={false}
          />
        )}

        <label className={styles.fieldLabel} htmlFor="mailbox-import-list">
          {mode === 'signin'
            ? t('sms_service.import_signin_field_list')
            : mode === 'note'
              ? t('sms_service.import_note_field_list')
              : t('sms_service.import_field_list')}
        </label>
        <textarea
          id="mailbox-import-list"
          className={styles.textarea}
          spellCheck={false}
          autoComplete="off"
          rows={mode === 'signin' ? 6 : 8}
          placeholder={
            mode === 'signin'
              ? t('sms_service.import_signin_placeholder')
              : mode === 'note'
                ? t('sms_service.import_note_placeholder')
                : method === 'imap'
                  ? t('sms_service.import_imap_placeholder')
                  : t('sms_service.import_placeholder')
          }
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={phase === 'busy' || notePhase === 'busy' || running}
        />
        {lineCount > 0 && (
          <span className={styles.note}>
            {mode === 'note'
              ? t('sms_service.import_note_count', { count: lineCount })
              : t('sms_service.import_count', { count: lineCount })}
          </span>
        )}

        {mode === 'paste' && (
          <div className={styles.verifyRow}>
            <SelectionCheckbox
              checked={verify}
              onChange={setVerify}
              disabled={phase === 'busy'}
              label={t('sms_service.import_verify')}
            />
            <span className={styles.note}>{t('sms_service.import_verify_note')}</span>
          </div>
        )}

        {mode === 'paste' && error && (
          <div className={styles.errorRow}>
            <IconAlertTriangle size={15} />
            <span>{error}</span>
          </div>
        )}

        {mode === 'paste' && phase === 'done' && summary && (
          <div className={styles.resultBlock}>
            <div
              className={`${styles.summary} ${
                summary.failed > 0 ? styles.summaryWarn : styles.summaryOk
              }`}
            >
              {summary.failed > 0 ? (
                <IconAlertTriangle size={15} />
              ) : (
                <IconCheckCircle2 size={15} />
              )}
              <span>
                {t('sms_service.import_summary', {
                  imported: summary.imported,
                  updated: summary.updated,
                  failed: summary.failed,
                })}
              </span>
            </div>
            {failures.length > 0 && (
              <>
                <div className={styles.failureTitle}>{t('sms_service.import_failures')}</div>
                <ul className={styles.failureList}>
                  {failures.slice(0, FAILURE_LIST_LIMIT).map((line) => (
                    <li key={`${line.line}-${line.account}`} className={styles.failureItem}>
                      <span className={styles.failureAccount}>{line.account || `#${line.line}`}</span>
                      <span className={styles.failureDetail}>{line.detail}</span>
                    </li>
                  ))}
                </ul>
                {failures.length > FAILURE_LIST_LIMIT && (
                  <span className={styles.note}>
                    {t('sms_service.import_more', {
                      count: failures.length - FAILURE_LIST_LIMIT,
                    })}
                  </span>
                )}
              </>
            )}
          </div>
        )}

        {mode === 'note' && noteError && (
          <div className={styles.errorRow}>
            <IconAlertTriangle size={15} />
            <span>{noteError}</span>
          </div>
        )}

        {mode === 'note' && notePhase === 'done' && noteSummary && (
          <div className={styles.resultBlock}>
            <div
              className={`${styles.summary} ${
                noteSummary.failed > 0 || noteSummary.unlinked > 0
                  ? styles.summaryWarn
                  : styles.summaryOk
              }`}
            >
              {noteSummary.failed > 0 || noteSummary.unlinked > 0 ? (
                <IconAlertTriangle size={15} />
              ) : (
                <IconCheckCircle2 size={15} />
              )}
              <span>
                {t('sms_service.import_note_summary', {
                  recorded: noteSummary.recorded,
                  updated: noteSummary.updated,
                  failed: noteSummary.failed,
                })}
              </span>
            </div>
            {/* 没有渠道覆盖的地址照样登记了，但它的信没有归属 —— 这件事要说出来，
                否则「已登记」会被读成「能收信」。 */}
            {noteSummary.unlinked > 0 && (
              <span className={styles.note}>
                {t('sms_service.import_note_unlinked', { count: noteSummary.unlinked })}
              </span>
            )}
          </div>
        )}

        {mode === 'signin' && signinError && (
          <div className={styles.errorRow}>
            <IconAlertTriangle size={15} />
            <span>{signinError}</span>
          </div>
        )}

        {/* 正在等的那一个：码、去哪输、还剩多久、现在是什么状态。 */}
        {mode === 'signin' && current && (
          <div className={styles.codeBox}>
            <div className={styles.codeHead}>
              <span className={styles.codeAccount}>{current.account}</span>
              <span className={styles.codeStep}>
                {t('sms_service.import_signin_progress', {
                  done: position,
                  total: flows.length,
                })}
              </span>
            </div>

            {current.status === 'awaiting_unlock' ? (
              <>
                <span className={styles.codeHint}>{t('sms_service.import_signin_unlock_note')}</span>
                <div className={styles.unlockRow}>
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder={t('sms_service.import_signin_unlock_placeholder')}
                    value={passphrase}
                    onChange={(event) => {
                      setPassphrase(event.target.value);
                      setCommitError(null);
                    }}
                    error={commitError ?? undefined}
                  />
                  <Button
                    onClick={handleCommit}
                    loading={committing}
                    disabled={passphrase.trim() === ''}
                  >
                    {t('sms_service.import_signin_commit')}
                  </Button>
                </div>
              </>
            ) : current.user_code ? (
              <>
                <span className={styles.codeHint}>{t('sms_service.import_signin_code_hint')}</span>
                <div className={styles.codeRow}>
                  <span className={styles.codeValue}>{current.user_code}</span>
                  <Button variant="secondary" size="sm" onClick={handleCopyCode}>
                    {copied
                      ? t('sms_service.import_signin_copied')
                      : t('sms_service.import_signin_copy')}
                  </Button>
                </div>
                <div className={styles.codeActions}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!current.verify_url}
                    onClick={() => {
                      if (current.verify_url) {
                        window.open(current.verify_url, '_blank', 'noopener,noreferrer');
                      }
                    }}
                  >
                    {t('sms_service.import_signin_open')}
                  </Button>
                  {typeof current.expires_in === 'number' && current.expires_in > 0 && (
                    <span className={styles.codeExpiry}>
                      {t('sms_service.import_signin_expires', {
                        time: formatRemaining(current.expires_in),
                      })}
                    </span>
                  )}
                </div>
              </>
            ) : null}

            {current.status !== 'awaiting_unlock' && (
              <span className={styles.waitingRow}>
                <LoadingSpinner size={13} />
                {t(statusKey(current.status))}
              </span>
            )}
          </div>
        )}

        {mode === 'signin' && signinFinished && (
          <div className={styles.resultBlock}>
            <div
              className={`${styles.summary} ${
                missedFlows.length > 0 ? styles.summaryWarn : styles.summaryOk
              }`}
            >
              {missedFlows.length > 0 ? (
                <IconAlertTriangle size={15} />
              ) : (
                <IconCheckCircle2 size={15} />
              )}
              <span>
                {t('sms_service.import_signin_summary', {
                  saved: savedCount,
                  missed: missedFlows.length,
                })}
              </span>
            </div>
            {missedFlows.length > 0 && (
              <>
                <div className={styles.failureTitle}>{t('sms_service.import_failures')}</div>
                <ul className={styles.failureList}>
                  {missedFlows.slice(0, FAILURE_LIST_LIMIT).map((flow) => (
                    <li key={flow.id ?? flow.account} className={styles.failureItem}>
                      <span className={styles.failureAccount}>{flow.account}</span>
                      <span className={styles.failureDetail}>{t(statusKey(flow.status))}</span>
                    </li>
                  ))}
                </ul>
                {missedFlows.length > FAILURE_LIST_LIMIT && (
                  <span className={styles.note}>
                    {t('sms_service.import_more', {
                      count: missedFlows.length - FAILURE_LIST_LIMIT,
                    })}
                  </span>
                )}
              </>
            )}
            {aliasFlows.length > 0 && (
              <>
                <div className={styles.failureTitle}>{t('sms_service.import_signin_alias_title')}</div>
                <ul className={styles.failureList}>
                  {aliasFlows.slice(0, FAILURE_LIST_LIMIT).map((flow) => (
                    <li key={flow.id ?? flow.account} className={styles.failureItem}>
                      <span className={styles.failureAccount}>{flow.account}</span>
                      <span className={styles.failureDetail}>{flow.stored_as}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
