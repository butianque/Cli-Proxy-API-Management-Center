/**
 * 导入邮箱 —— 把一批邮箱一次写进密钥库与渠道表。
 *
 * 入口在号码池页头，紧挨「配置」：买回来的一批邮箱先落库，才谈得上用。
 *
 * 四条约定：
 * 1. **值不经过面板**：文本框里粘的是卖家的原始行，整段发给基座；基座解析、验证、
 *    写库，回包里只有账号与结局。面板既不解析凭据，也不缓存它。
 * 2. **先说明白导入的是哪种邮箱，再问怎么收信**：这一批的文本格式是 Outlook 的，
 *    而同一份刷新令牌通常只带一种访问权 —— 邮箱服务器或者微软邮件接口。收信方式是
 *    使用者的答案，不是基座能猜的；选错时基座会说「令牌没有被授予这条路的权限」，
 *    换另一个再导一次即可。
 * 3. **验证默认打开**：验证不通过的邮箱不会入库 —— 一条连不上的渠道只会在表里
 *    多一行永远读不到信的东西，还得有人手工清。
 * 4. **分批发送**：一批里每个邮箱都要做一次令牌交换和一次登录，默认的 30 秒
 *    请求超时只够几个；按 {@link IMPORT_CHUNK_LINES} 切片既能给出进度，也不会让
 *    一次请求等到超时。
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { IconAlertTriangle, IconCheckCircle2 } from '@/components/ui/icons';
import { emailApi, type EmailImportLineWire } from '@/services/api/email';
import styles from './ImportMailboxesModal.module.scss';

/** 一次请求最多带多少行。基座在这批里并发验证，一片正好落在一次请求的超时之内。 */
const IMPORT_CHUNK_LINES = 20;

/**
 * 能导入的邮箱类型。
 *
 * 现在只有一种，所以它是一个**结论**而不是一个选项：卖家给的批量文本就是 Outlook 的
 * （账号、密码、应用 ID、刷新令牌），别的邮箱要的是另一种文本格式与另一种凭据。
 * 只有一个选项的单选画出来点不动任何东西，那是假控件；等真支持第二种再改回选择器。
 */
const MAILBOX_TYPE_LABEL = 'sms_service.import_type_outlook';

/** 收信方式。同一个信箱只走一条路，所以是单选。 */
type ReceivingMethod = 'graph' | 'oauth2';

const RECEIVING_METHODS: readonly ReceivingMethod[] = ['graph', 'oauth2'];

/** 失败清单最多列多少条：整批都失败时，列 200 条既看不清也没有用。 */
const FAILURE_LIST_LIMIT = 20;

interface ImportMailboxesModalProps {
  open: boolean;
  onClose: () => void;
  /** 关闭时调用，且只有真的导入过才调用 —— 页面据此把结果露出来。 */
  onImported: () => void;
}

type Phase = 'idle' | 'busy' | 'done';

interface Summary {
  imported: number;
  updated: number;
  failed: number;
}

export function ImportMailboxesModal({ open, onClose, onImported }: ImportMailboxesModalProps) {
  const { t } = useTranslation();

  const [text, setText] = useState('');
  const [verify, setVerify] = useState(true);
  const [method, setMethod] = useState<ReceivingMethod>('graph');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failures, setFailures] = useState<EmailImportLineWire[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 每次打开都是一次新的导入：上一批的结论留在上一批。
  useEffect(() => {
    if (!open) return;
    setText('');
    setVerify(true);
    setMethod('graph');
    setPhase('idle');
    setProgress({ done: 0, total: 0 });
    setSummary(null);
    setFailures([]);
    setError(null);
  }, [open]);

  // 只数「会真的发出去」的行：空行与 `#` 开头的说明行基座也会跳过。
  const lineCount = useMemo(
    () =>
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#')).length,
    [text]
  );

  const handleImport = async () => {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
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

  const importedSomething = (summary?.imported ?? 0) + (summary?.updated ?? 0) > 0;

  const handleClose = () => {
    if (importedSomething) onImported();
    onClose();
  };

  const footer =
    phase === 'done' ? (
      <Button variant="secondary" onClick={handleClose}>
        {t('sms_service.import_close')}
      </Button>
    ) : (
      <>
        <Button variant="ghost" onClick={onClose} disabled={phase === 'busy'}>
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

  return (
    <Modal open={open} title={t('sms_service.import_title')} onClose={onClose} footer={footer} width={640}>
      <div className={styles.body}>
        <p className={styles.lead}>{t('sms_service.import_lead')}</p>

        {/* 先说明是哪种邮箱，再问这条路怎么走：类型决定文本格式，方式决定基座去问哪一边。 */}
        <div className={styles.choiceGroup}>
          <span className={styles.fieldLabel}>{t('sms_service.import_type_label')}</span>
          <span className={styles.typeValue}>{t(MAILBOX_TYPE_LABEL)}</span>
        </div>

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
          <span className={styles.note}>{t('sms_service.import_method_hint')}</span>
        </div>

        <label className={styles.fieldLabel} htmlFor="mailbox-import-list">
          {t('sms_service.import_field_list')}
        </label>
        <textarea
          id="mailbox-import-list"
          className={styles.textarea}
          spellCheck={false}
          autoComplete="off"
          rows={8}
          placeholder={t('sms_service.import_placeholder')}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={phase === 'busy'}
        />
        {lineCount > 0 && (
          <span className={styles.note}>{t('sms_service.import_count', { count: lineCount })}</span>
        )}

        <div className={styles.verifyRow}>
          <SelectionCheckbox
            checked={verify}
            onChange={setVerify}
            disabled={phase === 'busy'}
            label={t('sms_service.import_verify')}
          />
          <span className={styles.note}>{t('sms_service.import_verify_note')}</span>
        </div>

        {error && (
          <div className={styles.errorRow}>
            <IconAlertTriangle size={15} />
            <span>{error}</span>
          </div>
        )}

        {phase === 'done' && summary && (
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
      </div>
    </Modal>
  );
}
