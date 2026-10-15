/**
 * 邮箱来源卡：邮箱来源的列表 + 编辑弹窗。
 *
 * 版面与手机号页对齐：同一条页头操作行 + 同一套卡片节奏；列表用与「渠道池」
 * 同形的行式（状态点 + 名称 + 状态标签 + 元信息 + 编辑/删除），不再用表格。
 * 后端一条来源仍可同时带手机号与邮箱块；本卡只列出邮箱来源，编辑器也只改邮箱块
 * （手机号的凭据走密钥库，由 `PhoneSupplyView` 负责）。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import {
  IconAlertTriangle,
  IconPencil,
  IconPlug,
  IconPlus,
  IconTrash2,
} from '@/components/ui/icons';
import {
  supplyApi,
  type SupplyChannelInput,
  type SupplyKindConfigInput,
  type SupplyConnectionInput,
} from '@/services/api/supply';
import { toNatureOptions, toSupplyChannels } from './smsMapping';
import type { SupplyChannel, SupplyNature, SupplyNatureOption } from './types';
import { ChannelEditorModal } from './ChannelEditorModal';
import styles from './SmsServicePage.module.scss';

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


/** Draft for one kind's connection to a specific nature. */
export interface ConnectionDraft {
  endpoint: string;
  account: string;
  secret: string;
  usage: string;
  domain: string;
}

/** Draft for one kind block. */
export interface KindDraft {
  natures: Set<SupplyNature>;
  connections: Partial<Record<SupplyNature, ConnectionDraft>>;
}

export interface ChannelDraft {
  id: string;
  label: string;
  category: string;
  phone: KindDraft;
  email: KindDraft;
}

export const emptyConnection = (): ConnectionDraft => ({
  endpoint: '',
  account: '',
  secret: '',
  usage: '',
  domain: '',
});

export const emptyKindDraft = (): KindDraft => ({
  natures: new Set(),
  connections: {},
});

export const EMPTY_DRAFT: ChannelDraft = {
  id: '',
  label: '',
  category: 'third-party',
  phone: emptyKindDraft(),
  email: emptyKindDraft(),
};

function kindDraftFromChannel(channel: SupplyChannel, kind: 'phone' | 'email'): KindDraft {
  const kc = kind === 'phone' ? channel.phone : channel.email;
  if (!kc) return emptyKindDraft();
  const conns: Partial<Record<SupplyNature, ConnectionDraft>> = {};
  for (const [nature, conn] of Object.entries(kc.connections)) {
    conns[nature as SupplyNature] = {
      endpoint: conn.endpoint,
      account: conn.account,
      secret: conn.secret,
      usage: conn.usage,
      domain: conn.domain,
    };
  }
  return { natures: new Set(kc.natures), connections: conns };
}

function kindDraftToInput(draft: KindDraft): SupplyKindConfigInput | undefined {
  if (draft.natures.size === 0) return undefined;
  const natures = [...draft.natures];
  const connections: Record<string, SupplyConnectionInput> = {};
  for (const n of natures) {
    const c = draft.connections[n] ?? emptyConnection();
    connections[n] = {
      endpoint: c.endpoint.trim(),
      account: c.account.trim(),
      secret: c.secret.trim(),
      usage: c.usage,
      domain: c.domain.trim(),
    };
  }
  return { enabled: true, natures, connections };
}

/** Summarize natures as a label string. */
function naturesLabel(natures: SupplyNature[], t: (key: string) => string): string {
  return natures.map((n) => t(NATURE_LABEL[n])).join(' + ') || '—';
}

/** Is the email block enabled? This card lists email sources only. */
function isEnabled(channel: SupplyChannel): boolean {
  return channel.email?.enabled ?? false;
}

export function SupplyChannelCard() {
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
      const result = await supplyApi.listChannels('email');
      setChannels(toSupplyChannels(result.channels));
      setNatures(toNatureOptions(result.natures));
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openEditor = useCallback((channel: SupplyChannel | null) => {
    setDraftError('');
    if (channel) {
      setDraft({
        id: channel.id,
        label: channel.label,
        category: channel.category,
        // The phone block rides along untouched. This card cannot edit it, and dropping it
        // would silently delete a block the operator had already saved.
        phone: kindDraftFromChannel(channel, 'phone'),
        email: kindDraftFromChannel(channel, 'email'),
      });
    } else {
      setDraft({ ...EMPTY_DRAFT, phone: emptyKindDraft(), email: emptyKindDraft() });
    }
  }, []);

  const saveDraft = useCallback(async () => {
    if (!draft) return;
    const label = draft.label.trim();
    if (!label) {
      setDraftError(t('sms_service.source_err_name'));
      return;
    }
    const phoneInput = kindDraftToInput(draft.phone);
    const emailInput = kindDraftToInput(draft.email);
    if (!phoneInput && !emailInput) {
      setDraftError(t('sms_service.source_err_no_kind'));
      return;
    }
    const input: SupplyChannelInput = {
      label,
      category: draft.category,
      phone: phoneInput,
      email: emailInput,
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
  }, [draft, load, t]);

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
    },
    [load]
  );

  const updateKindDraft = (kind: 'phone' | 'email', updater: (kd: KindDraft) => KindDraft) => {
    if (!draft) return;
    setDraft({ ...draft, [kind]: updater(draft[kind]) });
  };

  const toggleNature = (kind: 'phone' | 'email', nature: SupplyNature) => {
    updateKindDraft(kind, (kd) => {
      const next = new Set(kd.natures);
      if (next.has(nature)) next.delete(nature);
      else next.add(nature);
      const connections = { ...kd.connections };
      if (!connections[nature]) connections[nature] = emptyConnection();
      return { ...kd, natures: next, connections };
    });
  };

  const updateConnection = (
    kind: 'phone' | 'email',
    nature: SupplyNature,
    field: keyof ConnectionDraft,
    value: string
  ) => {
    updateKindDraft(kind, (kd) => {
      const conn = { ...(kd.connections[nature] ?? emptyConnection()), [field]: value };
      return { ...kd, connections: { ...kd.connections, [nature]: conn } };
    });
  };

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.headerActions}>
          <button type="button" className={styles.actionPill} onClick={() => openEditor(null)}>
            <IconPlus size={14} />
            {t('sms_service.config_add_email')}
          </button>
        </div>
      </header>

      <Card
        title={
          <span className={styles.cardTitle}>
            <IconPlug size={17} />
            {t('sms_service.source_title')}
          </span>
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
          <div className={styles.platformRows}>
            {channels.map((channel) => {
              const enabled = isEnabled(channel);
              return (
                <div key={channel.id} className={styles.platformRow}>
                  <span
                    className={`${styles.healthDot} ${
                      enabled ? styles.healthGood : styles.healthCritical
                    }`}
                    aria-hidden="true"
                  />
                  <span className={styles.platformRowText}>
                    <span className={styles.platformRowName}>
                      {channel.label}
                      <span
                        className={`${styles.tag} ${enabled ? styles.tagGood : styles.tagMuted}`}
                      >
                        {enabled
                          ? t('sms_service.source_state_on')
                          : t('sms_service.source_state_off')}
                      </span>
                    </span>
                    <span className={styles.platformRowMeta}>
                      <span className={`${styles.tag} ${styles.tagMuted}`}>
                        {t(CATEGORY_LABEL[channel.category] ?? 'sms_service.category_third_party')}
                      </span>
                      <span className={styles.ledgerDot} aria-hidden="true" />
                      <span>{naturesLabel(channel.email?.natures ?? [], t)}</span>
                      <span className={styles.ledgerDot} aria-hidden="true" />
                      <span className={styles.metaMuted}>
                        {t('sms_service.source_state_untested')}
                      </span>
                    </span>
                  </span>
                  <div className={styles.platformRowActions}>
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
                </div>
              );
            })}
          </div>
        )}

        <ChannelEditorModal
          draft={draft}
          natures={natures}
          error={draftError}
          saving={saving}
          onClose={() => setDraft(null)}
          onSave={() => void saveDraft()}
          onDraftChange={(next) => setDraft(next)}
          onNatureToggle={toggleNature}
          onConnectionChange={updateConnection}
        />
      </Card>
    </div>
  );
}
