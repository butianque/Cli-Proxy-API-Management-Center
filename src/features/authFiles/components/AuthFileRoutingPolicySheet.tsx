import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sheet } from '@/components/ui/Sheet';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { AutocompleteInput } from '@/components/ui/AutocompleteInput';
import { Button } from '@/components/ui/Button';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { IconPlus, IconTrash2 } from '@/components/ui/icons';
import type { AccountChannel, AccountPolicy } from '@/types/accounts';
import type { ModelConcurrencyEntry } from '@/types/authFile';
import { ACCOUNT_POLICY_AUTO, routingPolicyOptions } from '@/features/authFiles/accountPool';
import {
  buildModelConcurrency,
  mergeModelCandidates,
  toModelConcurrencyRows,
  validateModelConcurrencyRows,
  type ModelConcurrencyRow,
} from '@/features/authFiles/modelConcurrency';
import styles from './AuthFileRoutingPolicySheet.module.scss';

/** 抽屉一次提交的完整改动：策略与逐模型并发上限必须同时落盘。 */
export type AuthFileRoutingPolicySave = {
  policy: AccountPolicy | null;
  modelMaxConcurrency: ModelConcurrencyEntry[];
  /** 勾选后，同一账号池分类下的其它凭证也写入这份按模型并发上限。 */
  syncToCategory: boolean;
};

/** 同一账号池分类里可以一起改的凭证数量与分类名。 */
export type AuthFileRoutingPolicySyncScope = {
  categoryLabel: string;
  /** 除当前凭证以外的同分类凭证数；0 = 没有可同步的对象。 */
  peerCount: number;
};

export type AuthFileRoutingPolicySheetProps = {
  open: boolean;
  /** 供标题使用：本次改的是哪个凭证。 */
  fileName: string;
  /** 当前允许的调用通道；缺省 = 全部通道。 */
  policy?: AccountPolicy;
  /**
   * 这个凭证实际能走哪几条调用通道（插件按账号实时上报）。
   * 少于两条时没有可选项，通道区整块不出现。
   */
  channels?: readonly AccountChannel[];
  /** 已保存的逐模型并发上限。 */
  modelMaxConcurrency?: readonly ModelConcurrencyEntry[];
  /** 未单列的模型沿用凭证级上限（`maxConcurrency`），再退回渠道默认值。 */
  maxConcurrency?: number;
  /** 渠道默认并发上限；旧服务端不下发时为 undefined。 */
  maxConcurrencyDefault?: number;
  /** 保存中；关键按钮关闭动画与用途的开关。 */
  saving: boolean;
  disabled: boolean;
  onClose: () => void;
  /** 底部保存：取消也走同一条路径，由调用方负责刷新列表。 */
  onSave: (next: AuthFileRoutingPolicySave) => void | Promise<void>;
  /** 打开时拉取候选模型名；失败则只剩手填，不影响保存。 */
  onLoadModels?: () => Promise<string[]>;
  /** 同分类可同步的凭证；缺省或 peerCount 为 0 时不出现同步开关。 */
  syncScope?: AuthFileRoutingPolicySyncScope;
};

/**
 * 凭证设置抽屉。调用通道决定这个凭证允许走哪一条（只有真能选时才出现），
 * 逐模型并发上限决定同一凭证上各模型各自能同时跑几个请求。
 *
 * 抽屉里的改动先落草稿，底部一次保存，避免两个字段分批提交时互相覆盖。
 */
export function AuthFileRoutingPolicySheet(props: AuthFileRoutingPolicySheetProps) {
  const { t } = useTranslation();
  const labelId = useId();
  const [policyDraft, setPolicyDraft] = useState<AccountPolicy>(
    props.policy ?? ACCOUNT_POLICY_AUTO
  );
  const [rows, setRows] = useState<ModelConcurrencyRow[]>(() =>
    toModelConcurrencyRows(props.modelMaxConcurrency ?? [])
  );
  const [syncToCategory, setSyncToCategory] = useState(false);
  const [loadedModels, setLoadedModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const rowSeed = useRef(0);
  const loadModelsRef = useRef(props.onLoadModels);

  // Keep the latest loader without making the "fetch on open" effect depend on
  // the parent's inline callback identity.
  useEffect(() => {
    loadModelsRef.current = props.onLoadModels;
  }, [props.onLoadModels]);

  // 只在抽屉打开的那一刻把服务端状态拷进草稿。列表会周期性刷新，
  // 若跟着 props 重置，用户正在填的行会被静默清空。
  useEffect(() => {
    if (!props.open) return;
    setPolicyDraft(props.policy ?? ACCOUNT_POLICY_AUTO);
    setRows(toModelConcurrencyRows(props.modelMaxConcurrency ?? []));
    setSyncToCategory(false);
    setLoadedModels([]);
    rowSeed.current = 0;
    // 只在打开时拷一次草稿：列表刷新带来的新 props 不该覆盖正在填的行。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const load = loadModelsRef.current;
    if (!load) return;
    let cancelled = false;
    setLoadingModels(true);
    void load()
      .then((models) => {
        if (!cancelled) setLoadedModels(models);
      })
      .catch(() => {
        if (!cancelled) setLoadedModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.open]);

  const channels = props.channels ?? [];
  const options = routingPolicyOptions(channels, props.policy).map((option) => ({
    value: option.value,
    label:
      option.channelLabel === null
        ? t('account_pool.policy_default')
        : t('account_pool.policy_only', { name: option.channelLabel }),
  }));
  // 一个凭证能走哪几条调用通道，由插件按账号实时上报，面板不内置通道清单。
  // 两条以上才需要选：只有一条时选也改变不了任何东西，一条都没有更没得选。
  // 这两种情况下通道区整块不出现——不摆一个改不动任何东西的控件，也不拿
  // 说明文字占位。
  const hasChoice = channels.length > 1;
  const syncScope = props.syncScope;
  const showSync = syncScope !== undefined && syncScope.peerCount > 0;

  const rowErrors = validateModelConcurrencyRows(rows);
  const modelOptions = mergeModelCandidates(
    loadedModels,
    rows.map((row) => row.model)
  );
  const fallbackLimit =
    typeof props.maxConcurrency === 'number' ? props.maxConcurrency : props.maxConcurrencyDefault;
  const fallbackLabel =
    typeof fallbackLimit === 'number'
      ? fallbackLimit === 0
        ? t('auth_files.routing_policy_concurrency_default_unlimited')
        : t('auth_files.routing_policy_concurrency_default', { limit: fallbackLimit })
      : null;

  const updateRow = (id: string, patch: Partial<Omit<ModelConcurrencyRow, 'id'>>) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const addRow = () => {
    rowSeed.current += 1;
    setRows((prev) => [...prev, { id: `new-${rowSeed.current}`, model: '', limit: '' }]);
  };

  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((row) => row.id !== id));
  };

  const handleSave = () => {
    if (rowErrors.length > 0) return;
    void props.onSave({
      // 草稿与已存策略一致时原样带回，避免「只改并发上限」把策略改掉。
      policy: policyDraft === ACCOUNT_POLICY_AUTO ? null : policyDraft,
      modelMaxConcurrency: buildModelConcurrency(rows),
      syncToCategory: showSync && syncToCategory,
    });
  };

  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      size="md"
      closeDisabled={props.saving}
      eyebrow={t('auth_files.routing_policy_button')}
      title={props.fileName}
      footer={
        <div className={styles.footer}>
          <Button variant="secondary" onClick={props.onClose} disabled={props.saving}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleSave}
            loading={props.saving}
            disabled={props.disabled || rowErrors.length > 0}
          >
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        {hasChoice && (
          <div className="form-group">
            <label id={labelId}>{t('account_pool.policy_label')}</label>
            <Select
              value={policyDraft}
              options={options}
              ariaLabelledBy={labelId}
              disabled={props.disabled || props.saving}
              onChange={(value) => setPolicyDraft(value as AccountPolicy)}
            />
            <div className="hint">{t('account_pool.policy_hint')}</div>
          </div>
        )}

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>
              {t('auth_files.routing_policy_concurrency_title')}
            </span>
            {fallbackLabel && <span className={styles.sectionNote}>{fallbackLabel}</span>}
          </div>
          <div className="hint">{t('auth_files.routing_policy_concurrency_hint')}</div>

          {rows.map((row) => {
            const error = rowErrors.find((entry) => entry.id === row.id);
            const modelError =
              error && error.key !== 'auth_files.routing_policy_concurrency_invalid'
                ? t(error.key)
                : undefined;
            const limitError =
              error?.key === 'auth_files.routing_policy_concurrency_invalid'
                ? t(error.key)
                : undefined;
            return (
              <div key={row.id} className={styles.row}>
                <AutocompleteInput
                  ariaLabel={t('auth_files.routing_policy_concurrency_model')}
                  placeholder={t('auth_files.routing_policy_concurrency_model')}
                  value={row.model}
                  options={modelOptions}
                  disabled={props.disabled || props.saving}
                  error={modelError}
                  onChange={(value) => updateRow(row.id, { model: value })}
                />
                <Input
                  aria-label={t('auth_files.routing_policy_concurrency_limit')}
                  placeholder={t('auth_files.routing_policy_concurrency_limit')}
                  inputMode="numeric"
                  min={0}
                  step={1}
                  type="number"
                  value={row.limit}
                  disabled={props.disabled || props.saving}
                  error={limitError}
                  onChange={(event) => updateRow(row.id, { limit: event.target.value })}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.removeButton}
                  aria-label={t('auth_files.routing_policy_concurrency_remove', {
                    model: row.model || t('auth_files.routing_policy_concurrency_model'),
                  })}
                  disabled={props.disabled || props.saving}
                  onClick={() => removeRow(row.id)}
                >
                  <IconTrash2 size={16} />
                </Button>
              </div>
            );
          })}

          <div className={styles.rowActions}>
            <Button
              variant="secondary"
              size="sm"
              disabled={props.disabled || props.saving}
              onClick={addRow}
            >
              <IconPlus size={14} />
              <span>{t('auth_files.routing_policy_concurrency_add')}</span>
            </Button>
            <span className="hint">{t('auth_files.routing_policy_concurrency_zero_hint')}</span>
            {loadingModels && (
              <span className={styles.saving} role="status">
                <LoadingSpinner size={12} />
                <span>{t('common.loading')}</span>
              </span>
            )}
          </div>

          {showSync && (
            <div className={styles.sync}>
              <SelectionCheckbox
                checked={syncToCategory}
                onChange={setSyncToCategory}
                disabled={props.disabled || props.saving}
                label={t('auth_files.routing_policy_sync_label')}
              />
              <div className="hint">
                {t('auth_files.routing_policy_sync_hint', {
                  category: syncScope?.categoryLabel ?? '',
                  count: syncScope?.peerCount ?? 0,
                })}
              </div>
              {syncToCategory && rows.length === 0 && (
                <div className="hint">{t('auth_files.routing_policy_sync_clear_hint')}</div>
              )}
            </div>
          )}
        </section>

        {props.saving && (
          <div className={styles.saving} role="status">
            <LoadingSpinner size={14} />
            <span>{t('auth_files.routing_policy_saving')}</span>
          </div>
        )}
      </div>
    </Sheet>
  );
}
