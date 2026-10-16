/**
 * 邮箱来源视图：邮箱这一类渠道的列表 + 编辑弹窗。
 *
 * 版面与手机号视图对齐：同一条页头操作行（添加渠道）+ 同一张渠道池表
 * （`SupplyPoolTable`，表头与手机号页完全一致）。
 *
 * 本文件只剩两件事：邮箱渠道的**草稿模型**（`ChannelDraft` / `ConnectionDraft`，
 * 编辑器要用）与**编辑器弹窗**的接线。列表、开关、删除都在共享的表里。
 *
 * 后端一条来源仍可同时带手机号与邮箱块；本视图只列与只改邮箱块
 * （手机号的凭据走密钥库，由 `PhoneSupplyView` 负责），手机号块原样带回，不丢。
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconPlus } from '@/components/ui/icons';
import { supplyApi, type SupplyChannelInput, type SupplyKindConfigInput, type SupplyConnectionInput } from '@/services/api/supply';
import { SupplyPoolTable } from './SupplyPoolTable';
import type { SupplyChannel, SupplyNature, SupplyNatureOption } from './types';
import { ChannelEditorModal } from './ChannelEditorModal';
import styles from './SmsServicePage.module.scss';

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
  /** 启用位：编辑器不展示它，但要原样带回，否则「编辑一次」会把停用的渠道悄悄打开。 */
  enabled: boolean;
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
  enabled: true,
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
  return { enabled: kc.enabled, natures: new Set(kc.natures), connections: conns };
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
  return { enabled: draft.enabled, natures, connections };
}

export function SupplyChannelCard() {
  const { t } = useTranslation();
  const [natures, setNatures] = useState<SupplyNatureOption[]>([]);
  const [draft, setDraft] = useState<ChannelDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const openEditor = useCallback((channel: SupplyChannel | null) => {
    setDraftError('');
    if (channel) {
      setDraft({
        id: channel.id,
        label: channel.label,
        category: channel.category,
        // The phone block rides along untouched. This view cannot edit it, and dropping it
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
    setDraft(null);
    setReloadKey((key) => key + 1);
  }, [draft, t]);

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

      <SupplyPoolTable
        kind="email"
        reloadKey={reloadKey}
        onAdd={() => openEditor(null)}
        onEdit={openEditor}
        onNatures={setNatures}
      />

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
    </div>
  );
}
