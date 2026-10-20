/**
 * 出口池：这台机器买下的地址，以及谁在用。
 *
 * 它不参与「保存配置」：池是独立状态，加一条、测一条、删一条都立即生效。
 * 放进网络配置是因为出口本来就是网络配置的一部分 —— 但它上面没有「保存」
 * 按钮，这一点必须让人一眼看出来，所以每条出口的改动都在行内即时完成。
 *
 * 一条出口的价值只有地址能证明，所以「测试」是每行的主操作，最近一次结论
 * 直接写在行上：测过就报问到的地址，没测过就说没测过，测失败就报原因。
 */

import { useCallback, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { IconAlertTriangle, IconPlus, IconTrash2 } from '@/components/ui/icons';
import { useEgressPool } from '@/hooks/useEgressPool';
import { egressPoolApi, type EgressPoolEntry } from '@/services/api/egressPool';
import { useNotificationStore } from '@/stores';
import { formatDateTimeValue } from '@/utils/format';
import styles from './EgressPoolCard.module.scss';

type ProbePhase = { kind: 'idle' } | { kind: 'testing' } | { kind: 'failed'; message: string };

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
  const [probePhases, setProbePhases] = useState<Record<number, ProbePhase>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');
  const titleId = useId();

  /** 一条出口占用了多少地方。三项都为 0 就是没人用。 */
  const describeUsage = useCallback(
    (entry: EgressPoolEntry): string => {
      const parts: string[] = [];
      if (entry.accounts > 0)
        parts.push(t('egress_pool.count_accounts', { count: entry.accounts }));
      if (entry.channels > 0)
        parts.push(t('egress_pool.count_channels', { count: entry.channels }));
      if (entry.supply) parts.push(t('egress_pool.count_supply'));
      return parts.length === 0 ? t('egress_pool.count_none') : parts.join(' · ');
    },
    [t]
  );

  const test = useCallback(
    async (id: number) => {
      setProbePhases((current) => ({ ...current, [id]: { kind: 'testing' } }));
      const outcome = await egressPoolApi.probe(id);
      setProbePhases((current) => ({
        ...current,
        [id]: outcome.ok ? { kind: 'idle' } : { kind: 'failed', message: outcome.message },
      }));
      // 结论落在池里，重新读一次让行上的地址与占用一起刷新。
      await reload();
    },
    [reload]
  );

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
      setDraft(null);
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
  }, [draft, reload, t]);

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
  const sorted = useMemo(() => entries, [entries]);

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.headerCopy}>
          <h3 className={styles.title} id={titleId}>
            {t('egress_pool.title')}
          </h3>
          <p className={styles.description}>{t('egress_pool.description')}</p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setDraftError('');
            setDraft(EMPTY_DRAFT);
          }}
          disabled={!canEdit}
        >
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
      ) : status === 'loading' && sorted.length === 0 ? (
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
      ) : sorted.length === 0 ? (
        <EmptyState
          title={t('egress_pool.empty_title')}
          description={t('egress_pool.empty_desc')}
        />
      ) : (
        <ul className={styles.list}>
          {sorted.map((entry) => {
            const phase = probePhases[entry.id] ?? { kind: 'idle' };
            const probe = entry.probe;
            return (
              <li key={entry.id} className={styles.entry}>
                <div className={styles.entryHead}>
                  <span className={styles.idPill}>{t('egress_pool.id', { id: entry.id })}</span>
                  <span className={styles.entryName} title={entry.label || entry.url}>
                    {entry.label !== '' ? entry.label : entry.url}
                  </span>
                  {!entry.enabled && (
                    <span className={styles.pausedPill}>{t('egress_pool.paused')}</span>
                  )}
                  <div className={styles.entryActions}>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void test(entry.id)}
                      loading={phase.kind === 'testing'}
                      disabled={phase.kind === 'testing'}
                    >
                      {t('egress_pool.test')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setDraftError('');
                        setDraft({
                          id: entry.id,
                          url: entry.url,
                          label: entry.label,
                          note: entry.note,
                        });
                      }}
                      disabled={!canEdit}
                    >
                      {t('egress_pool.edit')}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => remove(entry)}
                      disabled={!canEdit || pendingId === entry.id}
                      aria-label={t('egress_pool.remove_title', { id: entry.id })}
                    >
                      <IconTrash2 size={14} />
                    </Button>
                  </div>
                </div>

                <div className={styles.entryUrl}>{entry.url}</div>

                <div className={styles.entryFoot}>
                  <span className={styles.usage}>{describeUsage(entry)}</span>
                  <span className={styles.probeLine}>
                    {phase.kind === 'failed' ? (
                      <span className={styles.probeFailed} role="alert" title={phase.message}>
                        {phase.message === ''
                          ? t('egress_pool.probe_no_address')
                          : t('egress_pool.probe_failed', { message: phase.message })}
                      </span>
                    ) : probe === null ? (
                      <span className={styles.probeMuted}>{t('egress_pool.untested')}</span>
                    ) : probe.ok ? (
                      <>
                        <span className={styles.probeValue}>{probe.ip}</span>
                        {probe.region !== '' && (
                          <span className={styles.probeValue}>{probe.region}</span>
                        )}
                        {probe.network !== '' && (
                          <span className={styles.probeValue}>{probe.network}</span>
                        )}
                        {probe.at > 0 && (
                          <span className={styles.probeMuted}>
                            {t('egress_pool.probe_at', {
                              time: formatDateTimeValue(probe.at * 1000),
                            })}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className={styles.probeFailed} title={probe.error}>
                        {probe.error === ''
                          ? t('egress_pool.probe_no_address')
                          : t('egress_pool.probe_failed', { message: probe.error })}
                      </span>
                    )}
                  </span>
                  <span className={styles.enabledToggle}>
                    <span className={styles.enabledLabel}>{t('egress_pool.enabled')}</span>
                    <ToggleSwitch
                      checked={entry.enabled}
                      ariaLabel={t('egress_pool.enabled_toggle', { id: entry.id })}
                      disabled={!canEdit || pendingId === entry.id}
                      onChange={(next) => void toggleEnabled(entry, next)}
                    />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Modal
        open={draft !== null}
        title={
          draft?.id === null || draft === null
            ? t('egress_pool.form_add_title')
            : t('egress_pool.form_edit_title', { id: draft.id })
        }
        onClose={() => {
          if (saving) return;
          setDraft(null);
          setDraftError('');
        }}
        closeDisabled={saving}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(null);
                setDraftError('');
              }}
              disabled={saving}
            >
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
