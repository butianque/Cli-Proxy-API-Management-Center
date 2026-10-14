/**
 * 渠道配置卡：所有来源的列表 + 编辑弹窗。
 *
 * 一条来源可以同时服务手机号和邮箱。表格把所有来源混在一起，每行显示：
 * 名称 | 服务类型（手机/邮箱）| 类别 | 连接方式 | 状态 | 启用开关
 *
 * 编辑弹窗：名称 + 类别 + 手机号/邮箱 tab + 每 tab 多选连接方式 + 各自连接信息。
 */

import { useCallback, useEffect, useState } from 'react';
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
  IconPencil,
  IconPlug,
  IconPlus,
  IconTrash2,
} from '@/components/ui/icons';
import { supplyApi, type SupplyChannelInput, type SupplyKindConfigInput, type SupplyConnectionInput } from '@/services/api/supply';
import { toNatureOptions, toSupplyChannels } from './smsMapping';
import type { SupplyChannel, SupplyNature, SupplyNatureOption } from './types';
import styles from './SmsServicePage.module.scss';

export interface SupplyChannelCardProps {
  /** 手机号侧：打开凭据弹窗（豪猪的 API/网页登录）。 */
  onEditCredential?: () => void;
}

const NATURE_LABEL: Record<SupplyNature, string> = {
  api: 'sms_service.nature_api',
  imap: 'sms_service.nature_imap',
  web: 'sms_service.nature_web',
};

const CATEGORY_LABEL: Record<string, string> = {
  'third-party': 'sms_service.category_third_party',
  'self-owned': 'sms_service.category_self_owned',
  'self-built': 'sms_service.category_self_built',
};

const CATEGORY_OPTIONS = ['third-party', 'self-owned', 'self-built'] as const;

/** Draft for one kind's connection to a specific nature. */
interface ConnectionDraft {
  endpoint: string;
  account: string;
  secret: string;
  usage: string;
  domain: string;
}

/** Draft for one kind block. */
interface KindDraft {
  active: boolean;
  natures: Set<SupplyNature>;
  connections: Partial<Record<SupplyNature, ConnectionDraft>>;
}

interface ChannelDraft {
  id: string;
  label: string;
  category: string;
  phone: KindDraft;
  email: KindDraft;
  editTab: 'phone' | 'email';
}

const emptyConnection = (): ConnectionDraft => ({
  endpoint: '', account: '', secret: '', usage: '', domain: '',
});

const emptyKindDraft = (): KindDraft => ({
  active: false, natures: new Set(), connections: {},
});

const EMPTY_DRAFT: ChannelDraft = {
  id: '', label: '', category: 'third-party',
  phone: emptyKindDraft(), email: emptyKindDraft(),
  editTab: 'phone',
};

function kindDraftFromChannel(channel: SupplyChannel, kind: 'phone' | 'email'): KindDraft {
  const kc = kind === 'phone' ? channel.phone : channel.email;
  if (!kc) return emptyKindDraft();
  const conns: Partial<Record<SupplyNature, ConnectionDraft>> = {};
  for (const [nature, conn] of Object.entries(kc.connections)) {
    conns[nature as SupplyNature] = {
      endpoint: conn.endpoint, account: conn.account, secret: conn.secret,
      usage: conn.usage, domain: conn.domain,
    };
  }
  return { active: true, natures: new Set(kc.natures), connections: conns };
}

function kindDraftToInput(draft: KindDraft): SupplyKindConfigInput | undefined {
  if (!draft.active || draft.natures.size === 0) return undefined;
  const natures = [...draft.natures];
  const connections: Record<string, SupplyConnectionInput> = {};
  for (const n of natures) {
    const c = draft.connections[n] ?? emptyConnection();
    connections[n] = {
      endpoint: c.endpoint.trim(), account: c.account.trim(),
      secret: c.secret.trim(), usage: c.usage, domain: c.domain.trim(),
    };
  }
  return { enabled: true, natures, connections };
}

/** Which natures can serve a given kind (from the backend's nature list). */
function naturesForKind(allNatures: SupplyNatureOption[], kind: 'phone' | 'email'): SupplyNature[] {
  return allNatures
    .filter((o) => o.kinds.includes(kind))
    .map((o) => o.nature);
}

/** Summarize natures as a label string. */
function naturesLabel(natures: SupplyNature[], t: (key: string) => string): string {
  return natures.map((n) => t(NATURE_LABEL[n])).join(' + ') || '—';
}

/** Summarize which kinds a channel serves. */
function kindsLabel(channel: SupplyChannel, t: (key: string) => string): string {
  const parts: string[] = [];
  if (channel.phone) parts.push(t('sms_service.tab_phone'));
  if (channel.email) parts.push(t('sms_service.tab_email'));
  return parts.join(' + ') || '—';
}

/** All natures across all kind blocks. */
function allNaturesOf(channel: SupplyChannel): SupplyNature[] {
  const set = new Set<SupplyNature>();
  for (const kc of [channel.phone, channel.email]) {
    if (kc) kc.natures.forEach((n) => set.add(n));
  }
  return [...set];
}

/** Is the channel fully enabled (at least one kind block is enabled)? */
function isEnabled(channel: SupplyChannel): boolean {
  return (channel.phone?.enabled ?? false) || (channel.email?.enabled ?? false);
}

export function SupplyChannelCard({ onEditCredential }: SupplyChannelCardProps) {
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

  const load = useCallback(async () => {
    try {
      const result = await supplyApi.listChannels();
      setChannels(toSupplyChannels(result.channels));
      setNatures(toNatureOptions(result.natures));
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openEditor = useCallback((channel: SupplyChannel | null) => {
    setDraftError('');
    if (channel) {
      setDraft({
        id: channel.id, label: channel.label, category: channel.category,
        phone: kindDraftFromChannel(channel, 'phone'),
        email: kindDraftFromChannel(channel, 'email'),
        editTab: channel.phone ? 'phone' : 'email',
      });
    } else {
      setDraft({ ...EMPTY_DRAFT, phone: emptyKindDraft(), email: emptyKindDraft() });
    }
  }, []);

  const saveDraft = useCallback(async () => {
    if (!draft) return;
    const label = draft.label.trim();
    if (!label) { setDraftError(t('sms_service.source_err_name')); return; }
    const phoneInput = kindDraftToInput(draft.phone);
    const emailInput = kindDraftToInput(draft.email);
    if (!phoneInput && !emailInput) {
      setDraftError(t('sms_service.source_err_no_kind'));
      return;
    }
    const input: SupplyChannelInput = {
      label, category: draft.category,
      phone: phoneInput, email: emailInput,
    };
    if (draft.id) input.id = draft.id;
    setSaving(true);
    const result = await supplyApi.saveChannel(input);
    setSaving(false);
    if (!result.ok) { setDraftError(result.message || t('sms_service.source_err_generic')); return; }
    setActionError('');
    setDraft(null);
    await load();
  }, [draft, load, t]);

  const remove = useCallback(async (channel: SupplyChannel) => {
    setActionError('');
    setBusyId(channel.id);
    const result = await supplyApi.removeChannel(channel.id);
    setBusyId('');
    if (!result.ok) { setActionError(result.message); return; }
    setActionError('');
    await load();
  }, [load]);

  /** Update one field inside the current kind's draft. */
  const updateKindDraft = (kind: 'phone' | 'email', updater: (kd: KindDraft) => KindDraft) => {
    if (!draft) return;
    setDraft({ ...draft, [kind]: updater(draft[kind]) });
  };

  /** Toggle a nature in the current kind draft. */
  const toggleNature = (kind: 'phone' | 'email', nature: SupplyNature) => {
    updateKindDraft(kind, (kd) => {
      const next = new Set(kd.natures);
      if (next.has(nature)) next.delete(nature); else next.add(nature);
      const connections = { ...kd.connections };
      if (!connections[nature]) connections[nature] = emptyConnection();
      return { ...kd, natures: next, connections };
    });
  };

  /** Update a connection field for a nature. */
  const updateConnection = (
    kind: 'phone' | 'email', nature: SupplyNature,
    field: keyof ConnectionDraft, value: string
  ) => {
    updateKindDraft(kind, (kd) => {
      const conn = { ...(kd.connections[nature] ?? emptyConnection()), [field]: value };
      return { ...kd, connections: { ...kd.connections, [nature]: conn } };
    });
  };

  const currentKindDraft = draft ? draft[draft.editTab] : null;
  const allowedNatures = draft ? naturesForKind(natures, draft.editTab) : [];

  return (
    <Card
      title={
        <span className={styles.cardTitle}>
          <IconPlug size={17} />
          {t('sms_service.config_title')}
        </span>
      }
      extra={
        <div className={styles.headerActions}>
          {onEditCredential && (
            <button type="button" className={styles.actionPill} onClick={onEditCredential}>
              {t('sms_service.phone_credential')}
            </button>
          )}
          <button type="button" className={styles.actionPill} onClick={() => openEditor(null)}>
            <IconPlus size={14} />
            {t('sms_service.config_add')}
          </button>
        </div>
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
              <TableHead>{t('sms_service.source_col_service_type')}</TableHead>
              <TableHead>{t('sms_service.source_col_category')}</TableHead>
              <TableHead>{t('sms_service.source_col_connection')}</TableHead>
              <TableHead>{t('sms_service.source_col_state')}</TableHead>
              <TableHead>{t('sms_service.source_col_enabled')}</TableHead>
              <TableHead alignRight aria-label={t('sms_service.col_actions')} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {channels.map((channel) => (
              <TableRow key={channel.id}>
                <TableCell>
                  <span className={styles.channelName}>{channel.label}</span>
                </TableCell>
                <TableCell>{kindsLabel(channel, t)}</TableCell>
                <TableCell>
                  <span className={`${styles.tag} ${styles.tagMuted}`}>
                    {t(CATEGORY_LABEL[channel.category] ?? 'sms_service.category_third_party')}
                  </span>
                </TableCell>
                <TableCell>{naturesLabel(allNaturesOf(channel), t)}</TableCell>
                <TableCell>
                  <span className={`${styles.tag} ${styles.tagMuted}`}>
                    {t('sms_service.source_state_untested')}
                  </span>
                </TableCell>
                <TableCell>
                  <span className={`${styles.tag} ${isEnabled(channel) ? styles.tagGood : styles.tagMuted}`}>
                    {isEnabled(channel) ? t('sms_service.source_state_on') : t('sms_service.source_state_off')}
                  </span>
                </TableCell>
                <TableCell>
                  <div className={styles.channelActions}>
                    <button type="button" className={styles.actionPill} onClick={() => openEditor(channel)}>
                      <IconPencil size={14} />
                    </button>
                    <button
                      type="button" className={styles.actionPill}
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
            ))}
          </TableBody>
        </Table>
      )}

      {/* ──── 编辑弹窗 ──── */}
      <Modal
        open={draft !== null}
        title={draft?.id ? t('sms_service.config_edit') : t('sms_service.config_add')}
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
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />

            <Select
              value={draft.category}
              options={CATEGORY_OPTIONS.map((c) => ({
                value: c, label: t(CATEGORY_LABEL[c]),
              }))}
              onChange={(v) => setDraft({ ...draft, category: v })}
              ariaLabel={t('sms_service.field_category')}
            />

            {/* 手机号 / 邮箱 tab */}
            <div className={styles.tabs} role="tablist">
              {(['phone', 'email'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button" role="tab"
                  aria-selected={draft.editTab === kind}
                  className={`${styles.tab} ${draft.editTab === kind ? styles.tabActive : ''}`}
                  onClick={() => setDraft({ ...draft, editTab: kind })}
                >
                  {t(kind === 'phone' ? 'sms_service.tab_phone' : 'sms_service.tab_email')}
                </button>
              ))}
            </div>

            {/* 当前 tab 的 active 开关 */}
            <ToggleSwitch
              checked={currentKindDraft?.active ?? false}
              onChange={(v) => updateKindDraft(draft.editTab, (kd) => ({ ...kd, active: v }))}
              label={t(draft.editTab === 'phone' ? 'sms_service.kind_enable_phone' : 'sms_service.kind_enable_email')}
            />

            {/* 连接方式多选 */}
            {currentKindDraft?.active && (
              <>
                <div className={styles.statLabel}>{t('sms_service.field_natures')}</div>
                {allowedNatures.map((nature) => (
                  <ToggleSwitch
                    key={nature}
                    checked={currentKindDraft.natures.has(nature)}
                    onChange={() => toggleNature(draft.editTab, nature)}
                    label={t(NATURE_LABEL[nature])}
                  />
                ))}

                {/* 每种勾选的连接方式的连接信息 */}
                {[...currentKindDraft.natures].map((nature) => {
                  const conn = currentKindDraft.connections[nature] ?? emptyConnection();
                  return (
                    <div key={nature} style={{ marginTop: 12, paddingLeft: 8, borderLeft: '2px solid var(--border)' }}>
                      <div className={styles.statLabel}>{t(NATURE_LABEL[nature])}</div>
                      {nature !== 'web' && (
                        <Input
                          label={t('sms_service.source_field_endpoint')}
                          value={conn.endpoint}
                          onChange={(e) => updateConnection(draft.editTab, nature, 'endpoint', e.target.value)}
                        />
                      )}
                      <Input
                        label={t('sms_service.source_field_account')}
                        value={conn.account}
                        onChange={(e) => updateConnection(draft.editTab, nature, 'account', e.target.value)}
                      />
                      <Input
                        label={t('sms_service.source_field_secret')}
                        labelExtra={
                          <span className={styles.statLabel}>{t('sms_service.source_secret_hint')}</span>
                        }
                        value={conn.secret}
                        onChange={(e) => updateConnection(draft.editTab, nature, 'secret', e.target.value)}
                      />
                      {nature === 'imap' && (
                        <>
                          <Select
                            value={conn.usage || 'personal'}
                            options={[
                              { value: 'personal', label: t('sms_service.usage_personal') },
                              { value: 'self-domain', label: t('sms_service.usage_self_domain') },
                            ]}
                            onChange={(v) => updateConnection(draft.editTab, nature, 'usage', v)}
                            ariaLabel={t('sms_service.field_usage')}
                          />
                          {conn.usage === 'self-domain' && (
                            <Input
                              label={t('sms_service.field_domain')}
                              placeholder="ormnes.com"
                              value={conn.domain}
                              onChange={(e) => updateConnection(draft.editTab, nature, 'domain', e.target.value)}
                            />
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}
      </Modal>
    </Card>
  );
}
