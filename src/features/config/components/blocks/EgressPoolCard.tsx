/**
 * 代理 URL 池：这台机器买下的地址，以及谁在用。
 *
 * 这是代理这件事唯一的地方：每条出口的地址只写在这一行里，账号与渠道按编号指向
 * 其中一条。换一个 IP 就是改这一行，所有指向它的账号与渠道立刻跟着走。
 *
 * 池不参与「保存配置」：加一条、改一条、删一条都立即生效。放进网络配置是因为
 * 出口本来就是网络配置的一部分 —— 但它上面没有「保存」按钮，这一点必须让人一眼
 * 看出来，所以每条出口的改动都在行内即时完成。
 *
 * 一条出口的地址通不通，只有测一次才知道。测试是这一行的动作，不属于编辑表单：
 * 它测的是**已经存下的**地址，跟「改地址」是两件事 —— 藏进表单里就等于要求先改点
 * 什么才能测，而真正要测的人往往什么都不想改。
 */

import { useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Pagination } from '@/components/ui/Pagination';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconAlertTriangle,
  IconPencil,
  IconPlug,
  IconPlus,
  IconTrash2,
} from '@/components/ui/icons';
import { EgressHealth } from '@/features/egress/EgressHealth';
import { PAGE_SIZE_OPTIONS, usePagination } from '@/hooks/usePagination';
import { useEgressPool } from '@/hooks/useEgressPool';
import { egressPoolApi, type EgressPoolEntry } from '@/services/api/egressPool';
import { useNotificationStore } from '@/stores';
import { SPONSORS } from '../../sponsors';
import fieldStyles from '../fields/Field.module.scss';
import styles from './EgressPoolCard.module.scss';

/** 一条出口的编辑表单。`url` 留空表示地址不变（读回来的是脱敏值）。 */
type Draft = { id: number | null; url: string; label: string; note: string };

const EMPTY_DRAFT: Draft = { id: null, url: '', label: '', note: '' };

export type EgressPoolCardProps = {
  /** 页面处于只读态（源码模式 / 正在保存）时，这里也不能改。 */
  disabled?: boolean;
};

export function EgressPoolCard({ disabled = false }: EgressPoolCardProps) {
  const { t } = useTranslation();
  const { status, entries, error, reload } = useEgressPool();
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');
  const titleId = useId();

  // 出口一多，一屏铺不下：分页显示，翻页只换行，不改任何一条出口。
  const paged = usePagination(entries);

  /**
   * 一条出口挂了多少账号与渠道。没人在用时这一行不出现：空着就是「没人用」，
   * 再写一句「没有账号或渠道在用它」只是把空格填满。
   */
  const describeUsage = useCallback(
    (entry: EgressPoolEntry): string => {
      const parts: string[] = [];
      if (entry.accounts > 0)
        parts.push(t('egress_pool.count_accounts', { count: entry.accounts }));
      if (entry.channels > 0)
        parts.push(t('egress_pool.count_channels', { count: entry.channels }));
      return parts.join(' · ');
    },
    [t]
  );

  const openDraft = useCallback((next: Draft) => {
    setDraftError('');
    setDraft(next);
  }, []);

  const closeDraft = useCallback(() => {
    setDraft(null);
    setDraftError('');
  }, []);

  const submitDraft = useCallback(async () => {
    if (!draft) return;
    const url = draft.url.trim();
    if (draft.id === null && url === '') {
      setDraftError(t('egress_pool.form_url_required'));
      return;
    }
    setSaving(true);
    setDraftError('');
    try {
      if (draft.id === null) {
        await egressPoolApi.add({ url, label: draft.label, note: draft.note });
      } else {
        await egressPoolApi.patch(draft.id, {
          url: url === '' ? undefined : url,
          label: draft.label,
          note: draft.note,
        });
      }
      closeDraft();
      await reload();
    } catch (failure) {
      setDraftError(
        t('egress_pool.form_save_failed', {
          message: failure instanceof Error && failure.message ? failure.message : '',
        })
      );
    } finally {
      setSaving(false);
    }
  }, [closeDraft, draft, reload, t]);

  const toggleEnabled = useCallback(
    async (entry: EgressPoolEntry, enabled: boolean) => {
      setActionError('');
      setPendingId(entry.id);
      try {
        await egressPoolApi.patch(entry.id, { enabled });
        await reload();
      } catch (failure) {
        setActionError(
          t('egress_pool.save_failed', {
            message: failure instanceof Error && failure.message ? failure.message : '',
          })
        );
      } finally {
        setPendingId(null);
      }
    },
    [reload, t]
  );

  /** 测一次这条出口，结论写回池里，这一行的状态跟着刷新。 */
  const testEntry = useCallback(
    async (entry: EgressPoolEntry) => {
      setActionError('');
      setTestingId(entry.id);
      try {
        const outcome = await egressPoolApi.probe(entry.id);
        if (!outcome.ok) {
          setActionError(
            outcome.message === ''
              ? t('egress_pool.test_failed')
              : t('egress_pool.test_failed_reason', { message: outcome.message })
          );
        }
        await reload();
      } finally {
        setTestingId(null);
      }
    },
    [reload, t]
  );

  const remove = useCallback(
    (entry: EgressPoolEntry) => {
      // 删除会连带影响挂在这条出口上的东西，所以先问一次；被占用时后端还会拒绝。
      showConfirmation({
        title: t('egress_pool.remove_title', { id: entry.id }),
        message:
          entry.total > 0
            ? t('egress_pool.remove_confirm_in_use', { count: entry.total })
            : t('egress_pool.remove_confirm'),
        variant: 'danger',
        confirmText: t('egress_pool.remove'),
        onConfirm: async () => {
          setActionError('');
          setPendingId(entry.id);
          try {
            await egressPoolApi.remove(entry.id);
            await reload();
          } catch (failure) {
            // 还有东西挂在上面时后端拒绝。这句话要说清下一步，而不是只说「失败」。
            const blocked = (failure as { status?: number })?.status === 409;
            setActionError(
              blocked
                ? t('egress_pool.remove_blocked', { count: entry.total })
                : t('egress_pool.remove_failed', {
                    message: failure instanceof Error && failure.message ? failure.message : '',
                  })
            );
          } finally {
            setPendingId(null);
          }
        },
      });
    },
    [reload, showConfirmation, t]
  );

  const unsupported = status === 'unsupported';
  const canEdit = !disabled && !unsupported;

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.headerCopy}>
          <h3 className={styles.title} id={titleId}>
            {t('egress_pool.title')}
          </h3>
          <p className={styles.description}>{t('egress_pool.description')}</p>
          {SPONSORS[0] && (
            <p className={fieldStyles.fieldSponsorHint}>
              {t('config_management.visual.sections.network.proxy_url_sponsor_hint')}{' '}
              <a
                className={fieldStyles.fieldSponsorLink}
                href={SPONSORS[0].url}
                target="_blank"
                rel="noopener noreferrer sponsored"
              >
                {SPONSORS[0].logo ? (
                  <img className={fieldStyles.fieldSponsorLogo} src={SPONSORS[0].logo} alt="" />
                ) : null}
                {SPONSORS[0].name}
              </a>
            </p>
          )}
        </div>
        <Button size="sm" onClick={() => openDraft(EMPTY_DRAFT)} disabled={!canEdit}>
          <IconPlus size={14} />
          {t('egress_pool.add')}
        </Button>
      </div>

      {actionError !== '' && (
        <Notice tone="danger" role="alert" icon={<IconAlertTriangle size={15} />}>
          {actionError}
        </Notice>
      )}

      {unsupported ? (
        <EmptyState
          title={t('egress_pool.unavailable_title')}
          description={t('egress_pool.unavailable_desc')}
        />
      ) : status === 'loading' && entries.length === 0 ? (
        <div className={styles.loading}>
          <LoadingSpinner size={16} />
        </div>
      ) : status === 'error' ? (
        <Notice
          tone="danger"
          role="alert"
          icon={<IconAlertTriangle size={15} />}
          action={
            <Button variant="secondary" size="sm" onClick={() => void reload()}>
              {t('egress_pool.retry')}
            </Button>
          }
        >
          {error === ''
            ? t('egress_pool.load_failed')
            : t('egress_pool.load_failed_reason', { message: error })}
        </Notice>
      ) : entries.length === 0 ? (
        <EmptyState
          title={t('egress_pool.empty_title')}
          description={t('egress_pool.empty_desc')}
        />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <colgroup>
              <col className={styles.colExit} />
              <col className={styles.colUrl} />
              <col className={styles.colStatus} />
              <col className={styles.colNote} />
              <col className={styles.colAction} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{t('egress_pool.col_exit')}</th>
                <th scope="col">{t('egress_pool.col_url')}</th>
                <th scope="col">{t('egress_pool.col_status')}</th>
                <th scope="col">{t('egress_pool.col_note')}</th>
                <th scope="col" className={styles.actionHead}>
                  {t('egress_pool.col_action')}
                </th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((entry) => {
                const usage = describeUsage(entry);
                const busy = pendingId === entry.id;
                const testing = testingId === entry.id;
                return (
                  <tr key={entry.id}>
                    <td>
                      <div className={styles.cellStack}>
                        <span className={styles.exitLine}>
                          <span className={styles.idPill}>#{entry.id}</span>
                          <span
                            className={entry.label === '' ? styles.empty : styles.name}
                            title={entry.label || undefined}
                          >
                            {entry.label === '' ? '—' : entry.label}
                          </span>
                        </span>
                        {usage !== '' && <span className={styles.usage}>{usage}</span>}
                      </div>
                    </td>
                    <td>
                      <span className={styles.url} title={entry.url}>
                        {entry.url}
                      </span>
                    </td>
                    <td>
                      <div className={styles.cellStack}>
                        <span className={styles.toggleRow}>
                          <ToggleSwitch
                            checked={entry.enabled}
                            ariaLabel={t('egress_pool.enabled_toggle', { id: entry.id })}
                            disabled={!canEdit || busy}
                            onChange={(next) => void toggleEnabled(entry, next)}
                          />
                          <span className={styles.toggleLabel}>
                            {entry.enabled ? t('egress_pool.enabled') : t('egress_pool.paused')}
                          </span>
                        </span>
                        <span className={styles.health}>
                          <EgressHealth probe={entry.probe} showProbeAt />
                        </span>
                      </div>
                    </td>
                    <td>
                      <span
                        className={entry.note === '' ? styles.empty : styles.note}
                        title={entry.note || undefined}
                      >
                        {entry.note === '' ? '—' : entry.note}
                      </span>
                    </td>
                    <td className={styles.cellAction}>
                      <span className={styles.actionGroup}>
                        <button
                          type="button"
                          className={styles.actionPill}
                          onClick={() => void testEntry(entry)}
                          disabled={!canEdit || busy || testing}
                          title={t('egress_pool.test_title', { id: entry.id })}
                          aria-label={t('egress_pool.test_title', { id: entry.id })}
                        >
                          {testing ? <LoadingSpinner size={12} /> : <IconPlug size={14} />}
                          {t('egress_pool.test')}
                        </button>
                        <button
                          type="button"
                          className={styles.actionPill}
                          onClick={() =>
                            openDraft({
                              id: entry.id,
                              url: entry.url,
                              label: entry.label,
                              note: entry.note,
                            })
                          }
                          disabled={!canEdit}
                          title={t('egress_pool.form_edit_title', { id: entry.id })}
                        >
                          <IconPencil size={14} />
                          {t('egress_pool.edit')}
                        </button>
                        <button
                          type="button"
                          className={styles.actionPill}
                          onClick={() => remove(entry)}
                          disabled={!canEdit || busy}
                          title={t('egress_pool.remove_title', { id: entry.id })}
                          aria-label={t('egress_pool.remove_title', { id: entry.id })}
                        >
                          <IconTrash2 size={14} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={paged.page}
        totalPages={paged.totalPages}
        total={paged.total}
        from={paged.from}
        to={paged.to}
        onPageChange={paged.setPage}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        pageSize={paged.pageSize}
        onPageSizeChange={paged.setPageSize}
      />

      <Modal
        open={draft !== null}
        title={
          draft?.id === null || draft === null
            ? t('egress_pool.form_add_title')
            : t('egress_pool.form_edit_title', { id: draft.id })
        }
        onClose={() => {
          if (saving) return;
          closeDraft();
        }}
        closeDisabled={saving}
        footer={
          <>
            <Button variant="secondary" onClick={closeDraft} disabled={saving}>
              {t('egress_pool.form_cancel')}
            </Button>
            <Button onClick={() => void submitDraft()} loading={saving} disabled={saving}>
              {t('egress_pool.form_save')}
            </Button>
          </>
        }
      >
        {draft !== null && (
          <>
            <Input
              label={t('egress_pool.form_url')}
              placeholder="socks5://user:pass@127.0.0.1:1080"
              value={draft.url}
              onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              hint={
                draft.id === null
                  ? t('egress_pool.form_url_hint')
                  : t('egress_pool.form_url_hidden_hint')
              }
              disabled={saving}
            />
            <Input
              label={t('egress_pool.form_label')}
              placeholder={t('egress_pool.form_label_placeholder')}
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              disabled={saving}
            />
            <Input
              label={t('egress_pool.form_note')}
              value={draft.note}
              onChange={(event) => setDraft({ ...draft, note: event.target.value })}
              disabled={saving}
            />
            {draftError !== '' && (
              <Notice tone="danger" role="alert" icon={<IconAlertTriangle size={15} />}>
                {draftError}
              </Notice>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
