import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { IconAlertTriangle } from '@/components/ui/icons';
import { Sheet } from '@/components/ui/Sheet';
import type { SupplyKind, SupplyNature, SupplyNatureOption } from './types';
import type { ChannelDraft, ConnectionDraft, KindDraft } from './SupplyChannelCard';

const NATURE_LABEL: Record<SupplyNature, string> = {
  api: 'sms_service.nature_api',
  imap: 'sms_service.nature_imap',
  web: 'sms_service.nature_web',
};
const CATEGORY_OPTIONS = ['third-party', 'self-owned', 'self-built'] as const;
const CATEGORY_LABEL: Record<string, string> = {
  'third-party': 'sms_service.category_third_party',
  'self-owned': 'sms_service.category_self_owned',
  'self-built': 'sms_service.category_self_built',
};

interface Props {
  draft: ChannelDraft | null;
  kind: SupplyKind;
  initialKind: SupplyKind;
  natures: SupplyNatureOption[];
  error: string;
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
  onDraftChange: (draft: ChannelDraft | null) => void;
  onKindChange: (kind: SupplyKind, updater: (draft: KindDraft) => KindDraft) => void;
  onNatureToggle: (kind: SupplyKind, nature: SupplyNature) => void;
  onConnectionChange: (kind: SupplyKind, nature: SupplyNature, field: keyof ConnectionDraft, value: string) => void;
}

export function ChannelEditorModal(props: Props) {
  const { t } = useTranslation();
  const [editorKind, setEditorKind] = useState<SupplyKind>(props.initialKind);
  const [categoryPointer, setCategoryPointer] = useState({ x: 50, y: 50 });
  const { draft } = props;
  useEffect(() => {
    if (draft) setEditorKind(props.initialKind);
  }, [draft?.id, props.initialKind]);
  if (!draft) return null;
  const current = draft[editorKind];
  const allowed = props.natures.filter((item) => item.kinds.includes(editorKind));
  return (
    <Sheet
      open
      onClose={props.onClose}
      size="lg"
      title={draft.id ? t('sms_service.config_edit') : t('sms_service.config_add')}
      description={t('sms_service.config_editor_desc')}
      footer={<div className="sms-editor-footer">
        <Button variant="secondary" onClick={props.onClose} disabled={props.saving}>{t('sms_service.source_cancel')}</Button>
        <Button onClick={props.onSave} disabled={props.saving}>{props.saving ? t('sms_service.config_saving') : t('sms_service.source_save')}</Button>
      </div>}
    >
      <div className="sms-editor-body">
        {props.error && <Notice tone="danger" role="alert" icon={<IconAlertTriangle size={15} />}>{props.error}</Notice>}
        <div className="sms-editor-grid">
          <Input label={t('sms_service.source_field_name')} placeholder={t('sms_service.source_ph_name')} value={draft.label} onChange={(e) => props.onDraftChange({ ...draft, label: e.target.value })} />
           <label className="sms-category-field">
             <span className="sms-field-label">{t('sms_service.field_category')}</span>
             <span
               className="sms-category-select"
               style={{ '--pointer-x': `${categoryPointer.x}%`, '--pointer-y': `${categoryPointer.y}%` } as CSSProperties}
               onPointerMove={(event) => {
                 const rect = event.currentTarget.getBoundingClientRect();
                 setCategoryPointer({
                   x: ((event.clientX - rect.left) / rect.width) * 100,
                   y: ((event.clientY - rect.top) / rect.height) * 100,
                 });
               }}
               onPointerLeave={() => setCategoryPointer({ x: 50, y: 50 })}
             >
               <Select value={draft.category} options={CATEGORY_OPTIONS.map((value) => ({ value, label: t(CATEGORY_LABEL[value]) }))} onChange={(category) => props.onDraftChange({ ...draft, category })} ariaLabel={t('sms_service.field_category')} />
             </span>
           </label>
        </div>
        <div className="sms-editor-kind-tabs" role="tablist" aria-label={t('sms_service.tabs_label')}>
          {(['phone', 'email'] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={editorKind === value} className={editorKind === value ? 'active' : ''} onClick={() => setEditorKind(value)}>{t(`sms_service.tab_${value}`)}</button>)}
        </div>
         <div className="sms-editor-methods">
          <div className="sms-editor-label">{t('sms_service.field_natures')}</div>
           <div className="sms-editor-method-cards">
             {allowed.map(({ nature }) => {
               const inputId = `sms-${editorKind}-${nature}`;
               return (
                 <label className="sms-editor-method-card" htmlFor={inputId} key={nature}>
                   <input
                     id={inputId}
                     type="checkbox"
                     checked={current.natures.has(nature)}
                     onChange={() => props.onNatureToggle(editorKind, nature)}
                   />
                   <span>{t(NATURE_LABEL[nature])}</span>
                 </label>
               );
             })}
           </div>
          {[...current.natures].map((nature) => {
            const conn = current.connections[nature] ?? { endpoint: '', account: '', secret: '', usage: '', domain: '' };
            return <div className="sms-editor-connection" key={nature}>
              <div className="sms-editor-label">{t(NATURE_LABEL[nature])}</div>
              {nature !== 'web' && <Input label={t('sms_service.source_field_endpoint')} value={conn.endpoint} onChange={(e) => props.onConnectionChange(editorKind, nature, 'endpoint', e.target.value)} />}
              <Input label={t('sms_service.source_field_account')} value={conn.account} onChange={(e) => props.onConnectionChange(editorKind, nature, 'account', e.target.value)} />
              <Input label={t('sms_service.source_field_secret')} type="password" value={conn.secret} onChange={(e) => props.onConnectionChange(editorKind, nature, 'secret', e.target.value)} />
              {nature === 'imap' && <><Select value={conn.usage || 'personal'} options={[{ value: 'personal', label: t('sms_service.usage_personal') }, { value: 'self-domain', label: t('sms_service.usage_self_domain') }]} onChange={(usage) => props.onConnectionChange(editorKind, nature, 'usage', usage)} ariaLabel={t('sms_service.field_usage')} />{conn.usage === 'self-domain' && <Input label={t('sms_service.field_domain')} value={conn.domain} onChange={(e) => props.onConnectionChange(editorKind, nature, 'domain', e.target.value)} />}</>}
            </div>;
          })}
         </div>
      </div>
    </Sheet>
  );
}
