/**
 * 来源（渠道）：手机号与邮箱**共用**的一张卡。
 *
 * 一条来源 = 标签 + 性质 + 连接信息：
 * - **标签**是给人看、给人选的；
 * - **性质**（我们怎么连它）才是基座那个分支，它决定连接表单，也决定池的样式。
 * 所以改名不动实现 —— id 是稳定的那个键，标签是自由文本。
 *
 * 规矩：
 * - 凭据的值**永不**出现在这里，只出现凭据的**名字**和「有没有存」；
 * - 可选性质由**基座**给出（`/supply/channels` 的 `natures`），页面不自己维护一份 ——
 *   自己维护就会在两处漂移：后端拒了、页面还在让人选；
 * - 没有数据就是空态，不摆占位行、不摆不能用的控件。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import {
  IconAlertTriangle,
  IconKey,
  IconPencil,
  IconPlus,
  IconPlug,
  IconTrash2,
} from '@/components/ui/icons';
import { supplyApi, type SupplyChannelInput } from '@/services/api/supply';
import { toNatureOptions, toSupplyChannels } from './smsMapping';
import type { SupplyChannel, SupplyKind, SupplyNature, SupplyNatureOption } from './types';
import styles from './SmsServicePage.module.scss';

export interface SupplyChannelCardProps {
  /** 这一类身份（手机号 / 邮箱）。 */
  kind: SupplyKind;
  /** 数据变化后通知外层（手机号侧据此刷新状态行）。 */
  onChanged?: () => void;
  /** 手机号侧：打开凭据弹窗。邮箱侧暂不传。 */
  onEditCredential?: () => void;
}

/** 性质 → 页面上的说法。这里只放「怎么连它」，不放「身份从哪来」。 */
const NATURE_LABEL_KEY: Record<SupplyNature, string> = {
  api: 'sms_service.nature_api',
  imap: 'sms_service.nature_imap',
  web: 'sms_service.nature_web',
};

/** 编辑器里的草稿；`id` 为空表示新建。 */
interface ChannelDraft {
  id: string;
  label: string;
  nature: SupplyNature;
  endpoint: string;
  account: string;
  secret: string;
  enabled: boolean;
}

const EMPTY_DRAFT: ChannelDraft = {
  id: '',
  label: '',
  nature: 'api',
  endpoint: '',
  account: '',
  secret: '',
  enabled: true,
};

export function SupplyChannelCard({ kind, onChanged, onEditCredential }: SupplyChannelCardProps) {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<SupplyChannel[]>([]);
  const [natures, setNatures] = useState<SupplyNatureOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [draft, setDraft] = useState<ChannelDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [draftError, setDraftError] = useState('');

  /** 基座允许用在这一类身份上的性质。 */
  const allowedNatures = useMemo(
    () => natures.filter((option) => option.kinds.includes(kind)),
    [natures, kind]
  );

  const load = useCallback(async () => {
    try {
      const result = await supplyApi.listChannels(kind);
      setChannels(toSupplyChannels(result.channels));
      setNatures(toNatureOptions(result.natures));
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoaded(true);
    }
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEditor = useCallback(
    (channel: SupplyChannel | null) => {
      setDraftError('');
      if (channel) {
        setDraft({
          id: channel.id,
          label: channel.label,
          nature: channel.nature,
          endpoint: channel.endpoint,
          account: channel.account,
          secret: channel.secret,
          enabled: channel.enabled,
        });
        return;
      }
      // 新建时用**基座允许的第一个**性质起步，而不是写死一个可能不被接受的。
      setDraft({ ...EMPTY_DRAFT, nature: allowedNatures[0]?.nature ?? EMPTY_DRAFT.nature });
    },
    [allowedNatures]
  );

  const saveDraft = useCallback(async () => {
    if (!draft) return;
    const label = draft.label.trim();
    if (!label) {
      setDraftError(t('sms_service.source_err_name'));
      return;
    }
    const input: SupplyChannelInput = {
      kind,
      label,
      nature: draft.nature,
      endpoint: draft.endpoint.trim(),
      account: draft.account.trim(),
      secret: draft.secret.trim(),
      enabled: draft.enabled,
    };
    if (draft.id) input.id = draft.id;
    setSaving(true);
    const result = await supplyApi.saveChannel(input);
    setSaving(false);
    if (!result.ok) {
      setDraftError(result.message || t('sms_service.source_err_generic'));
      return;
    }
    setActionError('');
    setDraft(null);
    await load();
    onChanged?.();
  }, [draft, kind, load, onChanged, t]);

  const remove = useCallback(
    async (channel: SupplyChannel) => {
      setActionError('');
      setBusyId(channel.id);
      const result = await supplyApi.removeChannel(channel.id);
      setBusyId('');
      if (!result.ok) {
        setActionError(result.message);
        return;
      }
      setActionError('');
      await load();
      onChanged?.();
    },
    [load, onChanged]
  );

  /**
   * 一条来源的连接状态：关了 / 凭据没配 / 还没试过。
   *
   * 第三档**不写「就绪」**：页面上还没有「测试连接」这一步，没有任何人验证过它能否连上。
   * 把没测过的东西说成「就绪」，就是拿状态词充数；「待测试」既是真的，也指出了下一步。
   */
  const stateOf = (channel: SupplyChannel) => {
    if (!channel.enabled) return { key: 'off', className: styles.tagMuted };
    if (channel.secret !== '' && !channel.secretPresent) {
      return { key: 'missing_cred', className: styles.tagWarning };
    }
    return { key: 'untested', className: styles.tagMuted };
  };

  return (
    <Card
      title={
        <span className={styles.cardTitle}>
          <IconPlug size={17} />
          {t('sms_service.source_title')}
        </span>
      }
      extra={
        <button type="button" className={styles.actionPill} onClick={() => openEditor(null)}>
          <IconPlus size={14} />
          {t('sms_service.source_add')}
        </button>
      }
    >
      {loadError && (
        <Notice tone="danger" role="alert" icon={<IconAlertTriangle size={15} />}>
          {t('sms_service.source_error_load', { message: loadError })}
        </Notice>
      )}
      {actionError && (
        <Notice tone="danger" role="alert" icon={<IconAlertTriangle size={15} />}>
          {t('sms_service.source_error_change', { message: actionError })}
        </Notice>
      )}

      {/* 加载完成前不画空表头：那是「还没有数据」和「还没读到」混在一起。 */}
      {!loaded ? null : channels.length === 0 ? (
        <EmptyState
          title={t('sms_service.source_empty')}
          description={t('sms_service.source_empty_desc')}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('sms_service.source_col_name')}</TableHead>
              <TableHead>{t('sms_service.source_col_type')}</TableHead>
              <TableHead>{t('sms_service.source_col_state')}</TableHead>
              <TableHead alignRight aria-label={t('sms_service.col_actions')} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {channels.map((channel) => {
              const state = stateOf(channel);
              return (
                <TableRow key={channel.id}>
                  <TableCell>
                    <span className={styles.channelName}>{channel.label}</span>
                  </TableCell>
                  <TableCell>
                    <span className={`${styles.tag} ${styles.tagMuted}`}>
                      {t(NATURE_LABEL_KEY[channel.nature])}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className={`${styles.tag} ${state.className}`}>
                      {t(`sms_service.source_state_${state.key}`)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className={styles.channelActions}>
                      {onEditCredential && (
                        <button
                          type="button"
                          className={styles.actionPill}
                          onClick={onEditCredential}
                        >
                          <IconKey size={14} />
                          {t('sms_service.source_credential')}
                        </button>
                      )}
                      <button
                        type="button"
                        className={styles.actionPill}
                        onClick={() => openEditor(channel)}
                      >
                        <IconPencil size={14} />
                        {t('sms_service.configure_edit')}
                      </button>
                      <button
                        type="button"
                        className={styles.actionPill}
                        onClick={() => void remove(channel)}
                        disabled={busyId === channel.id}
                        title={t('sms_service.source_remove')}
                        aria-label={t('sms_service.source_remove')}
                      >
                        <IconTrash2 size={14} />
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Modal
        open={draft !== null}
        title={t('sms_service.source_editor_title')}
        onClose={() => setDraft(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={saving}>
              {t('sms_service.source_cancel')}
            </Button>
            <Button onClick={() => void saveDraft()} disabled={saving}>
              {saving ? t('sms_service.config_saving') : t('sms_service.source_save')}
            </Button>
          </>
        }
      >
        {draft && (
          <>
            {draftError && (
              <Notice tone="danger" role="alert" icon={<IconAlertTriangle size={15} />}>
                {draftError}
              </Notice>
            )}
            <Input
              label={t('sms_service.source_field_name')}
              placeholder={t('sms_service.source_ph_name')}
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
            <Select
              value={draft.nature}
              options={allowedNatures.map((option) => ({
                value: option.nature,
                label: t(NATURE_LABEL_KEY[option.nature]),
              }))}
              onChange={(value) => setDraft({ ...draft, nature: value as SupplyNature })}
              ariaLabel={t('sms_service.source_field_type')}
            />
            <Input
              label={t('sms_service.source_field_endpoint')}
              value={draft.endpoint}
              onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
            />
            <Input
              label={t('sms_service.source_field_account')}
              value={draft.account}
              onChange={(event) => setDraft({ ...draft, account: event.target.value })}
            />
            <Input
              label={t('sms_service.source_field_secret')}
              labelExtra={
                <span className={styles.statLabel}>{t('sms_service.source_secret_hint')}</span>
              }
              value={draft.secret}
              onChange={(event) => setDraft({ ...draft, secret: event.target.value })}
            />
            <ToggleSwitch
              checked={draft.enabled}
              onChange={(value) => setDraft({ ...draft, enabled: value })}
              label={t('sms_service.source_enabled')}
            />
          </>
        )}
      </Modal>
    </Card>
  );
}
