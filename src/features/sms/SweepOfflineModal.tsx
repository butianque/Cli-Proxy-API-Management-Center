/**
 * 扫活弹窗 —— 一次把台账里**自带凭据的邮箱**都连一次，只列出真的连不上的那些。
 *
 * 它回答的是「哪些号现在收不到信」，所以清单里的每一行都有一条真实依据（基座连
 * 了一次、失败了；或者密钥库里确定没有它的凭据）。判断不了的号不进这张单子，只在
 * 末尾报个数 —— 把「没测成」混进来，这份清单就不再是「要处理的号」。
 *
 * 列出来的每个号只有三条出路，对应三种真实处境：
 *
 * - **原样导出**：留档（卖家对账、换一批再导入），一行一个地址。
 * - **重新授权导入**：令牌过期了，账号本人再登录一次就能救回来。
 * - **移出供应池**：这个号不要了，把它的台账记录清掉。
 *
 * 三条都作用在**选中的**行上：清单可能很长，一条一条点不是人在这个页面上的做法。
 *
 * 版面按收件箱那一套来：撑满高度、清单自己滚、抬头一条分割线、一行两行字
 * （地址 + 原因 / 依据）。同一批号常常一起过期，所以「每一行都是同一句报错」时
 * 那句话只写一次，行里不再重复 73 遍。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import {
  IconAlertTriangle,
  IconCheckCircle2,
  IconDownload,
  IconTrash2,
  IconUpload,
} from '@/components/ui/icons';
import { emailApi } from '@/services/api/email';
import { supplyApi } from '@/services/api/supply';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { downloadBlob } from '@/utils/download';
import { toMailboxProbes } from './smsMapping';
import {
  canReauthorize,
  chunkAddresses,
  classifyOffline,
  sharedOfflineDetail,
  sweepAddresses,
  type SweepVerdict,
} from './sweepOffline';
import type { MailboxProbe, PoolEntry } from './types';
import styles from './SweepOfflineModal.module.scss';

interface SweepOfflineModalProps {
  open: boolean;
  onClose: () => void;
  /** 台账当前的全部身份：扫活自己决定哪些该查。 */
  entries: PoolEntry[];
  /** 选中的地址交回页面，由它带着它们打开授权导入。 */
  onReauthorize: (addresses: string[]) => void;
  /** 有身份真的被移出了供应池：台账要重读一次。 */
  onRemoved: () => void;
}

/** 检查中 / 检查完。没有「失败」这一态：一次没连成仍然是结论。 */
type Phase = 'scanning' | 'done';

export function SweepOfflineModal({
  open,
  onClose,
  entries,
  onReauthorize,
  onRemoved,
}: SweepOfflineModalProps) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);

  const [phase, setPhase] = useState<Phase>('scanning');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [verdict, setVerdict] = useState<SweepVerdict | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanError, setScanError] = useState<{ error: unknown } | null>(null);
  const [removeError, setRemoveError] = useState('');
  const [removing, setRemoving] = useState(false);

  // 一次打开只扫一次。移出一个号之后台账会重读（`entries` 换新），那不意味着要把
  // 整本台账再连 73 次 —— 已经判断过的结论还在，成功的行也已经在本地剔掉了。
  const scannedRef = useRef(false);

  /**
   * 打开就扫，一次扫完整本台账。
   *
   * 分片发、分片报进度：一屏之外的身份也要检查，所以这里不看当前页；一次请求最多
   * 带上限那么多地址，剩下的接着来，进度才不会停在 0 上让人以为卡住了。
   *
   * 依赖里没有 `t`：`t` 每换一次语言就换一个身份，写进依赖 = 扫到一半被掐断，又
   * 因为「已经扫过」不再开始，弹窗永远停在「正在检查」。所以这里只留原文，文案在
   * 渲染时套外壳。
   */
  useEffect(() => {
    if (!open) {
      scannedRef.current = false;
      return;
    }
    if (scannedRef.current) return;
    scannedRef.current = true;

    let cancelled = false;
    const addresses = sweepAddresses(entries);
    setProgress({ done: 0, total: addresses.length });
    setVerdict(null);
    setSelected(new Set());
    setScanError(null);
    setRemoveError('');
    setRemoving(false);
    setPhase('scanning');

    const scan = async () => {
      const probes = new Map<string, MailboxProbe>();
      try {
        for (const chunk of chunkAddresses(addresses)) {
          if (cancelled) return;
          const states = await emailApi.probeAddresses(chunk);
          for (const [address, probe] of toMailboxProbes(states)) probes.set(address, probe);
          if (cancelled) return;
          setProgress((current) => ({ ...current, done: current.done + chunk.length }));
        }
      } catch (error) {
        if (cancelled) return;
        setScanError({ error });
        setPhase('done');
        return;
      }
      if (cancelled) return;
      const result = classifyOffline(entries, probes);
      setVerdict(result);
      // 全是坏号的时候，最省事的做法是「全选」；这也是这份清单的默认答案。
      setSelected(new Set(result.offline.map((row) => row.entry.identity)));
      setPhase('done');
    };
    void scan();

    return () => {
      cancelled = true;
    };
  }, [open, entries]);

  const offline = useMemo(() => verdict?.offline ?? [], [verdict]);

  // 73 行里写 73 遍同一句话，人只会读第一行；相同就收成抬头的一句。
  const sharedDetail = useMemo(() => sharedOfflineDetail(offline), [offline]);

  const selectedRows = useMemo(
    () => offline.filter((row) => selected.has(row.entry.identity)),
    [offline, selected]
  );
  const selectedCount = selectedRows.length;
  const reauthorizable = canReauthorize(selectedRows);

  const toggleRow = useCallback((address: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((current) =>
      current.size === offline.length ? new Set() : new Set(offline.map((row) => row.entry.identity))
    );
  }, [offline]);

  /** 导出的是一份能原样再贴回来的清单：一行一个地址。 */
  const handleExport = () => {
    if (selectedRows.length === 0) return;
    const text = selectedRows.map((row) => row.entry.identity).join('\n');
    downloadBlob({
      filename: 'offline-mailboxes.txt',
      blob: new Blob([`${text}\n`], { type: 'text/plain;charset=utf-8' }),
    });
    showNotification(t('sms_service.sweep_export_done', { count: selectedRows.length }), 'success');
  };

  const handleReauthorize = () => {
    if (!reauthorizable) return;
    onReauthorize(selectedRows.map((row) => row.entry.identity));
    onClose();
  };

  /**
   * 移出供应池：先问一次，再逐个删。
   *
   * 一个失败不该让整批停下，也不该把已经删掉的留在清单里 —— 成功的行立刻从清单
   * 上消失，失败的原样留着并说出原因，等操作者再决定。
   */
  const handleRemove = () => {
    if (selectedCount === 0) return;
    const addresses = selectedRows.map((row) => row.entry.identity);
    showConfirmation({
      title: t('sms_service.sweep_remove_confirm_title', { count: addresses.length }),
      message: t('sms_service.sweep_remove_confirm', { count: addresses.length }),
      variant: 'danger',
      confirmText: t('common.confirm'),
      cancelText: t('common.cancel'),
      onConfirm: async () => {
        setRemoving(true);
        setRemoveError('');
        const failed: string[] = [];
        let firstMessage = '';
        for (const address of addresses) {
          const result = await supplyApi.removePoolAccount('email', address);
          if (result.ok) continue;
          failed.push(address);
          if (firstMessage === '') firstMessage = result.message;
        }
        setRemoving(false);
        const removed = addresses.filter((address) => !failed.includes(address));
        if (removed.length > 0) {
          const gone = new Set(removed);
          setVerdict((current) =>
            current
              ? { ...current, offline: current.offline.filter((row) => !gone.has(row.entry.identity)) }
              : current
          );
          setSelected((current) => {
            const next = new Set(current);
            for (const address of gone) next.delete(address);
            return next;
          });
          onRemoved();
        }
        if (failed.length > 0) {
          setRemoveError(
            t('sms_service.sweep_remove_failed', {
              count: failed.length,
              message: firstMessage,
            })
          );
          return;
        }
        showNotification(t('sms_service.sweep_remove_done', { count: removed.length }), 'success');
        onClose();
      },
    });
  };

  // 检查中底栏什么都不放：等的是基座一条一条连，这里没有可做的事；右上角的 X 就是
  // 关闭，底栏再放一个「关闭」等于把同一个动作做两遍。
  const footer =
    phase === 'scanning' ? undefined : (
      // 三个处置是这一批号的出路；关闭只有右上角那一个。
      <div className={styles.footerActions}>
        <Button
          variant="secondary"
          onClick={handleExport}
          disabled={selectedCount === 0 || removing}
        >
          <span className={styles.buttonLabel}>
            <IconDownload size={14} />
            {t('sms_service.sweep_export')}
          </span>
        </Button>
        <Button
          variant="secondary"
          onClick={handleReauthorize}
          disabled={!reauthorizable || removing}
          title={reauthorizable ? undefined : t('sms_service.sweep_reauthorize_hint')}
        >
          <span className={styles.buttonLabel}>
            <IconUpload size={14} />
            {t('sms_service.sweep_reauthorize')}
          </span>
        </Button>
        <Button
          variant="danger"
          onClick={handleRemove}
          loading={removing}
          disabled={selectedCount === 0}
        >
          <span className={styles.buttonLabel}>
            <IconTrash2 size={14} />
            {t('sms_service.sweep_remove')}
          </span>
        </Button>
      </div>
    );

  const footnotes =
    removeError !== '' ||
    (selectedCount > 0 && !reauthorizable) ||
    (verdict !== null && offline.length > 0 && verdict.unknown.length > 0);

  return (
    <Modal
      open={open}
      title={t('sms_service.sweep_title')}
      onClose={onClose}
      footer={footer}
      width={720}
      className={styles.modal}
      closeDisabled={removing}
    >
      <div className={styles.body}>
        {phase === 'scanning' && (
          <div className={styles.scan}>
            <LoadingSpinner size={14} />
            <span>{t('sms_service.sweep_scanning', progress)}</span>
          </div>
        )}

        {phase === 'done' && scanError !== null && (
          <div className={styles.noticeWrap}>
            <Notice tone="danger" role="alert" icon={<IconAlertTriangle size={15} />}>
              {t('sms_service.sweep_err_probe', {
                message: emailApi.describeError(scanError.error, t('common.unknown_error')),
              })}
            </Notice>
          </div>
        )}

        {phase === 'done' && scanError === null && offline.length === 0 && (
          <div className={styles.clearBox}>
            <IconCheckCircle2 size={16} />
            <div>
              <div className={styles.clearTitle}>{t('sms_service.sweep_clear')}</div>
              <div className={styles.clearDesc}>
                {t('sms_service.sweep_clear_desc', { count: verdict?.online.length ?? 0 })}
              </div>
              {/* 判断不了的号既不算通过也不算失败：清空态里也要承认它们的存在，
                  否则「没有连不上的」会被读成「全都验过了」。 */}
              {verdict !== null && verdict.unknown.length > 0 && (
                <div className={styles.clearDesc}>
                  {t('sms_service.sweep_unknown', { count: verdict.unknown.length })}
                </div>
              )}
            </div>
          </div>
        )}

        {offline.length > 0 && (
          <>
            <div className={styles.summary}>
              <p className={styles.lead}>
                {t('sms_service.sweep_lead', { count: offline.length })}
              </p>
              {sharedDetail !== '' && (
                <p className={styles.shared}>
                  <span className={styles.sharedLabel}>
                    {t('sms_service.sweep_shared_cause_label')}
                  </span>
                  {sharedDetail}
                </p>
              )}
            </div>

            <div className={styles.toolbar}>
              <SelectionCheckbox
                checked={selectedCount === offline.length && offline.length > 0}
                onChange={toggleAll}
                label={t('sms_service.sweep_select_all')}
                disabled={removing}
              />
              <span className={styles.count}>
                {t('sms_service.sweep_selected', { count: selectedCount })}
              </span>
            </div>

            <ul className={styles.list}>
              {offline.map((row) => (
                <li className={styles.row} key={row.entry.identity}>
                  <SelectionCheckbox
                    checked={selected.has(row.entry.identity)}
                    onChange={() => toggleRow(row.entry.identity)}
                    ariaLabel={row.entry.identity}
                    disabled={removing}
                  />
                  <div className={styles.rowBody}>
                    <span className={styles.address} title={row.entry.identity}>
                      {row.entry.identity}
                    </span>
                    <span
                      className={`${styles.cause} ${
                        row.cause === 'credential-missing'
                          ? styles.causeMissing
                          : styles.causeUnreachable
                      }`}
                    >
                      {t(`sms_service.sweep_cause_${row.cause}`)}
                    </span>
                    {/* 每一行都是同一句时，那句已经在抬头里了。 */}
                    {row.detail !== '' && row.detail.trim() !== sharedDetail && (
                      <span className={styles.detail} title={row.detail}>
                        {row.detail}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {footnotes && (
          <div className={styles.footnotes}>
            {verdict !== null && offline.length > 0 && verdict.unknown.length > 0 && (
              <span className={styles.note}>
                {t('sms_service.sweep_unknown', { count: verdict.unknown.length })}
              </span>
            )}
            {/* 选中的号里只要有一个不是微软那条路，重新授权就帮不上忙：说一句，
                而不是只把它变灰 —— 灰掉的按钮不会解释自己。 */}
            {selectedCount > 0 && !reauthorizable && (
              <span className={styles.note}>{t('sms_service.sweep_reauthorize_hint')}</span>
            )}
            {removeError !== '' && (
              <Notice tone="danger" role="alert" icon={<IconAlertTriangle size={15} />}>
                {removeError}
              </Notice>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}