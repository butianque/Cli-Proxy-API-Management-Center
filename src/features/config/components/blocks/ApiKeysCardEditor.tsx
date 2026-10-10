import { memo, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useAuthStore, useNotificationStore } from '@/stores';
import { apiKeyNameFingerprint, readApiKeyNames, saveApiKeyName } from '../../apiKeyNames';
import {
  KEY_POOL_OPTIONS,
  areApiKeyPoolsEqual,
  candidateKeyPoolValues,
  isDuplicateApiKey,
  removeApiKeyPools,
  renameApiKeyPools,
  withApiKeyPools,
  type ApiKeyPools,
} from '../../keyPools';
import { copyToClipboard } from '@/utils/clipboard';
import { makeClientId } from '@/types/visualConfig';
import { generateSecureApiKey } from '@/utils/apiKey';
import { maskApiKey } from '@/utils/format';
import { isValidApiKeyCharset } from '@/utils/validation';
import { ApiKeyStrengthMeter } from './ApiKeyStrengthMeter';
import styles from './Blocks.module.scss';

interface ApiKeysCardEditorProps {
  value: string;
  pools: ApiKeyPools;
  disabled?: boolean;
  onChange: (patch: { apiKeysText: string; apiKeyPools: ApiKeyPools }) => void;
}

export const ApiKeysCardEditor = memo(function ApiKeysCardEditor(props: ApiKeysCardEditorProps) {
  const apiBase = useAuthStore((state) => state.apiBase);
  return <ScopedApiKeysCardEditor key={apiBase} {...props} apiBase={apiBase} />;
});

function ScopedApiKeysCardEditor({
  value,
  pools,
  disabled,
  onChange,
  apiBase,
}: ApiKeysCardEditorProps & { apiBase: string }) {
  const [names, setNames] = useState(() => readApiKeyNames(apiBase));
  const [nameValue, setNameValue] = useState('');
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const apiKeys = useMemo(
    () =>
      value
        .split('\n')
        .map((key) => key.trim())
        .filter(Boolean),
    [value]
  );
  const nameFingerprints = useMemo(
    () => apiKeys.map((key) => apiKeyNameFingerprint(apiBase, key)),
    [apiBase, apiKeys]
  );
  const [apiKeyIds, setApiKeyIds] = useState(() => apiKeys.map(() => makeClientId()));
  const renderApiKeyIds = useMemo(() => {
    if (apiKeyIds.length === apiKeys.length) return apiKeyIds;
    if (apiKeyIds.length > apiKeys.length) return apiKeyIds.slice(0, apiKeys.length);
    return [
      ...apiKeyIds,
      ...Array.from({ length: apiKeys.length - apiKeyIds.length }, () => makeClientId()),
    ];
  }, [apiKeyIds, apiKeys.length]);

  const apiKeyInputId = useId();
  const nameInputId = useId();
  const nameHintId = `${nameInputId}-hint`;
  const apiKeyHintId = `${apiKeyInputId}-hint`;
  const apiKeyErrorId = `${apiKeyInputId}-error`;
  const poolsLabelId = useId();
  const poolsHintId = `${poolsLabelId}-hint`;
  const [modalOpen, setModalOpen] = useState(false);
  const [editingApiKeyId, setEditingApiKeyId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [draftPools, setDraftPools] = useState<string[]>([]);
  const [poolValue, setPoolValue] = useState('');
  const [formError, setFormError] = useState('');

  const poolLabel = (pool: string) => {
    const option = KEY_POOL_OPTIONS.find((candidate) => candidate.value === pool);
    return option ? t(option.labelKey) : pool;
  };

  const openAddModal = () => {
    setNameValue('');
    setEditingApiKeyId(null);
    setInputValue('');
    setDraftPools([]);
    setPoolValue('');
    setFormError('');
    setModalOpen(true);
  };

  const openEditModal = (apiKeyId: string) => {
    const editingIndex = renderApiKeyIds.findIndex((id) => id === apiKeyId);
    const latestNames = readApiKeyNames(apiBase);
    setNames(latestNames);
    setNameValue(latestNames[nameFingerprints[editingIndex]] ?? '');
    setEditingApiKeyId(apiKeyId);
    setInputValue(apiKeys[editingIndex] ?? '');
    setDraftPools(pools[apiKeys[editingIndex] ?? ''] ?? []);
    setPoolValue('');
    setFormError('');
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setInputValue('');
    setDraftPools([]);
    setPoolValue('');
    setEditingApiKeyId(null);
    setFormError('');
  };

  const toggleDraftPool = (pool: string) => {
    setDraftPools((current) =>
      current.includes(pool) ? current.filter((item) => item !== pool) : [...current, pool]
    );
  };

  const addCustomPool = () => {
    const trimmed = poolValue.trim();
    if (!trimmed) return;
    setDraftPools((current) => (current.includes(trimmed) ? current : [...current, trimmed]));
    setPoolValue('');
  };

  const handleDelete = (apiKeyId: string) => {
    const index = renderApiKeyIds.findIndex((id) => id === apiKeyId);
    if (index < 0) return;
    const removedKey = apiKeys[index] ?? '';
    setApiKeyIds(renderApiKeyIds.filter((id) => id !== apiKeyId));
    onChange({
      apiKeysText: apiKeys.filter((_, i) => i !== index).join('\n'),
      apiKeyPools: removeApiKeyPools(pools, removedKey),
    });
  };

  const handleSave = () => {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setFormError(t('config_management.visual.api_keys.error_empty'));
      return;
    }
    if (!isValidApiKeyCharset(trimmed)) {
      setFormError(t('config_management.visual.api_keys.error_invalid'));
      return;
    }

    const editingIndex = editingApiKeyId
      ? renderApiKeyIds.findIndex((id) => id === editingApiKeyId)
      : -1;
    // One entry per key: the pool scope is keyed by the key value, so a duplicate
    // would share it (and a rename onto an existing value would overwrite it).
    if (isDuplicateApiKey(apiKeys, trimmed, editingIndex)) {
      setFormError(t('config_management.visual.api_keys.error_duplicate'));
      return;
    }
    const nextKeys =
      editingApiKeyId === null
        ? [...apiKeys, trimmed]
        : apiKeys.map((key, idx) => (idx === editingIndex ? trimmed : key));
    if (!saveApiKeyName(apiBase, trimmed, nameValue)) {
      setFormError(t('config_management.visual.api_keys.name_save_error'));
      return;
    }
    setNames(readApiKeyNames(apiBase));
    // Retain old fingerprints: configuration edits can still be discarded or fail to save.
    if (editingApiKeyId === null) {
      setApiKeyIds([...renderApiKeyIds, makeClientId()]);
    }

    // Editing the key itself moves its pool scope; the old entry must not linger.
    let nextPools =
      editingApiKeyId === null
        ? pools
        : renameApiKeyPools(pools, apiKeys[editingIndex] ?? '', trimmed);
    nextPools = withApiKeyPools(nextPools, trimmed, draftPools);

    const keysChanged = nextKeys.join('\n') !== apiKeys.join('\n');
    if (keysChanged || !areApiKeyPoolsEqual(nextPools, pools)) {
      onChange({ apiKeysText: nextKeys.join('\n'), apiKeyPools: nextPools });
    }
    closeModal();
  };

  const handleCopy = async (apiKey: string) => {
    const copied = await copyToClipboard(apiKey);
    showNotification(
      t(copied ? 'notification.link_copied' : 'notification.copy_failed'),
      copied ? 'success' : 'error'
    );
  };

  const handleGenerate = () => {
    setInputValue(generateSecureApiKey());
    setFormError('');
  };

  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <div className={styles.blockHeaderRow}>
        <label style={{ margin: 0 }}>{t('config_management.visual.api_keys.label')}</label>
        <Button size="sm" onClick={openAddModal} disabled={disabled}>
          {t('config_management.visual.api_keys.add')}
        </Button>
      </div>

      {apiKeys.length === 0 ? (
        <div className={styles.emptyState}>{t('config_management.visual.api_keys.empty')}</div>
      ) : (
        <div className="item-list" style={{ marginTop: 4 }}>
          {apiKeys.map((key, index) => {
            const keyPools = pools[key] ?? [];
            return (
              <div key={renderApiKeyIds[index] ?? `${key}-${index}`} className="item-row">
                <div className="item-meta">
                  <div className="pill">#{index + 1}</div>
                  <div className="item-title">
                    {names[nameFingerprints[index]] ??
                      t('config_management.visual.api_keys.input_label')}
                  </div>
                  <div className="item-subtitle">{maskApiKey(String(key || ''))}</div>
                  <div className={styles.poolBadges}>
                    {keyPools.length > 0 ? (
                      keyPools.map((pool) => (
                        <span key={pool} className="pill">
                          {poolLabel(pool)}
                        </span>
                      ))
                    ) : (
                      <span className={styles.poolBadgesNone}>
                        {t('config_management.visual.api_keys.pools_empty')}
                      </span>
                    )}
                  </div>
                </div>
                <div className="item-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleCopy(key)}
                    disabled={disabled}
                  >
                    {t('common.copy')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => openEditModal(renderApiKeyIds[index] ?? '')}
                    disabled={disabled}
                  >
                    {t('config_management.visual.common.edit')}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleDelete(renderApiKeyIds[index] ?? '')}
                    disabled={disabled}
                  >
                    {t('config_management.visual.common.delete')}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="hint">{t('config_management.visual.api_keys.hint')}</div>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={
          editingApiKeyId !== null
            ? t('config_management.visual.api_keys.edit_title')
            : t('config_management.visual.api_keys.add_title')
        }
        footer={
          <>
            <Button variant="secondary" onClick={closeModal} disabled={disabled}>
              {t('config_management.visual.common.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={disabled}>
              {editingApiKeyId !== null
                ? t('config_management.visual.common.update')
                : t('config_management.visual.common.add')}
            </Button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor={nameInputId}>{t('config_management.visual.api_keys.name_label')}</label>
          <input
            id={nameInputId}
            className="input"
            value={nameValue}
            onChange={(event) => setNameValue(event.target.value)}
            placeholder={t('config_management.visual.api_keys.name_placeholder')}
            aria-describedby={nameHintId}
            disabled={disabled}
          />
          <div id={nameHintId} className="hint">
            {t('config_management.visual.api_keys.name_hint')}
          </div>
        </div>
        <div className="form-group">
          <label htmlFor={apiKeyInputId}>
            {t('config_management.visual.api_keys.input_label')}
          </label>
          <div className={styles.apiKeyModalInputRow}>
            <input
              id={apiKeyInputId}
              className="input"
              placeholder={t('config_management.visual.api_keys.input_placeholder')}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              disabled={disabled}
              aria-describedby={formError ? `${apiKeyErrorId} ${apiKeyHintId}` : apiKeyHintId}
              aria-invalid={Boolean(formError)}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleGenerate}
              disabled={disabled}
            >
              {t('config_management.visual.api_keys.generate')}
            </Button>
          </div>
          <ApiKeyStrengthMeter value={inputValue} />
          <div id={apiKeyHintId} className="hint">
            {t('config_management.visual.api_keys.input_hint')}
          </div>
          {formError && (
            <div id={apiKeyErrorId} className="error-box">
              {formError}
            </div>
          )}
        </div>
        <div
          className="form-group"
          role="group"
          aria-labelledby={poolsLabelId}
          aria-describedby={poolsHintId}
        >
          <span id={poolsLabelId} className={styles.poolGroupLabel}>
            {t('config_management.visual.api_keys.pools_label')}
          </span>
          <div className={styles.poolOptions}>
            {candidateKeyPoolValues(draftPools).map((pool) => {
              const option = KEY_POOL_OPTIONS.find((candidate) => candidate.value === pool);
              return (
                <label key={pool} className={styles.poolOption}>
                  <input
                    type="checkbox"
                    checked={draftPools.includes(pool)}
                    disabled={disabled}
                    onChange={() => toggleDraftPool(pool)}
                  />
                  <span>{option ? t(option.labelKey) : pool}</span>
                  {option ? <code className={styles.poolOptionValue}>{pool}</code> : null}
                </label>
              );
            })}
          </div>
          <div className={styles.poolCustomRow}>
            <input
              className="input"
              value={poolValue}
              placeholder={t('config_management.visual.api_keys.pools_custom_placeholder')}
              aria-label={t('config_management.visual.api_keys.pools_custom_placeholder')}
              onChange={(event) => setPoolValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addCustomPool();
                }
              }}
              disabled={disabled}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={addCustomPool}
              disabled={disabled || !poolValue.trim()}
            >
              {t('config_management.visual.api_keys.pools_add')}
            </Button>
          </div>
          <div id={poolsHintId} className="hint">
            {t('config_management.visual.api_keys.pools_hint')}
          </div>
        </div>
      </Modal>
    </div>
  );
}
