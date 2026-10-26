import { useCallback, useState, type CSSProperties } from 'react';
import { getAuthFileRefreshKey } from '@/features/authFiles/manualRefresh';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconDownload,
  IconInfo,
  IconModelCluster,
  IconRefreshCw,
  IconSettings,
  IconSlidersHorizontal,
  IconTrash2,
} from '@/components/ui/icons';
import { ProviderStatusBar } from '@/components/providers/ProviderStatusBar';
import type { AuthFileItem } from '@/types';
import type { AccountPolicy, AccountView } from '@/types/accounts';
import { statusBarDataFromRecentRequests } from '@/utils/recentRequests';
import { formatFileSize } from '@/utils/format';
import {
  formatModified,
  getAuthFileStatusMessage,
  hasAuthFileStatusWarning,
  getTypeColor,
  getTypeLabel,
  isRuntimeOnlyAuthFile,
  normalizeProviderKey,
  supportsAuthFileManualRefresh,
  type AuthFileQuotaFilter,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import { authFileCardElementId, deriveAuthFileIdentity } from '@/features/authFiles/identity';
import { resolveAuthFileQuotaType } from '@/features/authFiles/logic';
import type { AuthFileStatusBarData } from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
import { AuthFileQuotaSection } from '@/features/authFiles/components/AuthFileQuotaSection';
import { AuthFileCooldownSection } from './AuthFileCooldownSection';
import { AuthFilePoolSection } from './AuthFilePoolSection';
import { AuthFileRoutingPolicySheet } from './AuthFileRoutingPolicySheet';
import styles from './AuthFileCard.module.scss';

export type AuthFileCardProps = {
  file: AuthFileItem;
  /** `GET /accounts` 的账号视图；三级匹配未命中时缺省，卡片不显示账号池区块。 */
  account?: AccountView;
  compact: boolean;
  selected: boolean;
  /** 从台账跳过来时高亮这一张；`false` = 正常卡片。 */
  focused?: boolean;
  resolvedTheme: ResolvedTheme;
  disableControls: boolean;
  deleting: string | null;
  statusUpdating: Record<string, boolean>;
  manualRefreshing: Record<string, boolean>;
  cooldownResetting: Record<string, boolean>;
  quotaFilterType: AuthFileQuotaFilter;
  statusBarCache: Map<string, AuthFileStatusBarData>;
  /** 首屏一次性级联入场的延迟；null/undefined 表示不做入场动画。 */
  entranceDelayMs?: number | null;
  onShowModels: (file: AuthFileItem) => void;
  onDownload: (name: string) => void;
  onManualRefresh: (file: AuthFileItem) => void;
  onCooldownReset: (file: AuthFileItem) => void;
  /** 路由策略改动的回传；`null` = 清除策略（回到默认）。 */
  onPolicyChange?: (policy: AccountPolicy | null) => void | Promise<void>;
  /**
   * 让宿主重新探测这张凭证的渠道。
   * 缺省时路由策略抽屉的空态只讲现状、不给动作（没有回读的地方）。
   */
  onRefreshChannels?: (file: AuthFileItem) => void | Promise<void>;
  /**
   * 出口改完之后重新读一次账号视图。
   * 缺省时卡片不显示出口下拉框（没有回读的地方，改完行上还是旧值）。
   */
  onEgressChanged?: () => void | Promise<void>;
  /** 该账号是否有宿主额度通道；透传给账号池区块，false/缺省时不渲染额度区块。 */
  quotaCapable?: boolean;
  onOpenPrefixProxyEditor: (file: AuthFileItem) => void;
  onDelete: (name: string) => void;
  onToggleStatus: (file: AuthFileItem, enabled: boolean) => void;
  onToggleSelect: (name: string) => void;
};

export function AuthFileCard(props: AuthFileCardProps) {
  const { t } = useTranslation();
  const {
    file,
    account,
    compact,
    selected,
    focused,
    resolvedTheme,
    disableControls,
    deleting,
    statusUpdating,
    manualRefreshing,
    cooldownResetting,
    quotaFilterType,
    statusBarCache,
    entranceDelayMs,
    onShowModels,
    onDownload,
    onManualRefresh,
    onCooldownReset,
    onPolicyChange,
    onEgressChanged,
    onRefreshChannels,
    quotaCapable,
    onOpenPrefixProxyEditor,
    onDelete,
    onToggleStatus,
    onToggleSelect,
  } = props;

  const isRuntimeOnly = isRuntimeOnlyAuthFile(file);
  const providerKey = normalizeProviderKey(String(file.type ?? file.provider ?? 'unknown'));
  const isAistudio = providerKey === 'aistudio';
  const showModelsButton = !isRuntimeOnly || isAistudio;
  const showManualRefreshButton = !isRuntimeOnly && supportsAuthFileManualRefresh(providerKey);
  const isManualRefreshing = manualRefreshing[getAuthFileRefreshKey(file)] === true;
  const typeLabel = getTypeLabel(t, providerKey);
  const typeColor = getTypeColor(providerKey, resolvedTheme);

  const quotaType = resolveAuthFileQuotaType(file, quotaFilterType);
  const showQuotaLayout = Boolean(quotaType) && !isRuntimeOnly && !compact;

  const successCount = file.successCount ?? 0;
  const failureCount = file.failureCount ?? 0;
  const authIndexKey = typeof file.authIndex === 'string' ? file.authIndex : null;
  const isCooldownResetting = Boolean(authIndexKey && cooldownResetting[authIndexKey]);
  const statusData =
    (authIndexKey && statusBarCache.get(authIndexKey)) ||
    statusBarDataFromRecentRequests(file.recentRequests ?? []);

  const rawStatusMessage = getAuthFileStatusMessage(file);
  const hasStatusWarning = hasAuthFileStatusWarning(file);

  const priorityValue = Number.isSafeInteger(file.priority) ? file.priority : undefined;
  const weightValue = Number.isSafeInteger(file.weight) ? file.weight : undefined;
  // 主行显示账号（email/项目 ID），文件名降为满卡宽的 mono 副行
  const identity = deriveAuthFileIdentity(file);

  // 挂载时捕获一次入场延迟：父级随后传 null 也不会中断已开始的动画
  const [mountEntranceDelayMs] = useState<number | null>(entranceDelayMs ?? null);
  const cardClasses = [
    styles.card,
    compact ? styles.cardCompact : '',
    selected ? styles.cardSelected : '',
    focused ? styles.cardFocused : '',
    file.disabled === true ? styles.cardDisabled : '',
    mountEntranceDelayMs != null ? styles.cardEnter : '',
  ]
    .filter(Boolean)
    .join(' ');
  const cardStyle =
    mountEntranceDelayMs != null
      ? ({ '--card-delay': `${mountEntranceDelayMs}ms` } as CSSProperties)
      : undefined;

  // 路由策略是账号池层面的开关，正文只留状态与额度，所以收进动作行的抽屉里。
  const [policySheetOpen, setPolicySheetOpen] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const showPolicyButton = Boolean(account) && Boolean(onPolicyChange);

  const handlePolicyChange = useCallback(
    async (nextPolicy: AccountPolicy | null) => {
      if (!onPolicyChange) return;
      setPolicySaving(true);
      try {
        await onPolicyChange(nextPolicy);
      } finally {
        setPolicySaving(false);
      }
    },
    [onPolicyChange]
  );

  return (
    <article
      id={authFileCardElementId(file.name)}
      className={cardClasses}
      style={cardStyle}
    >
      <header className={styles.head}>
        {!isRuntimeOnly && (
          <SelectionCheckbox
            checked={selected}
            onChange={() => onToggleSelect(file.name)}
            className={styles.selection}
            ariaLabel={t('auth_files.card_select', { name: file.name })}
            title={t('auth_files.card_select', { name: file.name })}
          />
        )}
        <h3 className={styles.identity}>
          <span
            className={styles.providerBadge}
            style={{
              backgroundColor: typeColor.bg,
              color: typeColor.text,
              ...(typeColor.border ? { border: typeColor.border } : {}),
            }}
          >
            {typeLabel}
          </span>
          <span
            className={`${styles.account} ${identity.kind === 'fileName' ? styles.accountMono : ''}`}
            title={identity.primary}
          >
            {identity.primary}
          </span>
        </h3>
        {isRuntimeOnly && (
          <span className={styles.runtimeLabel}>{t('auth_files.type_virtual')}</span>
        )}
      </header>

      {identity.secondary && (
        <p className={styles.fileName} title={identity.fullName}>
          {identity.secondary}
        </p>
      )}

      {rawStatusMessage && hasStatusWarning && (
        <div className={styles.warning} title={rawStatusMessage}>
          <IconInfo className={styles.warningIcon} size={14} />
          <span>{rawStatusMessage}</span>
        </div>
      )}

      <AuthFileCooldownSection
        snapshot={file.cooldownSnapshot}
        resetting={isCooldownResetting}
        resetDisabled={
          disableControls ||
          statusUpdating[getAuthFileRefreshKey(file)] === true ||
          isManualRefreshing
        }
        onReset={authIndexKey ? () => onCooldownReset(file) : undefined}
      />

      <div className={styles.health}>
        <div className={styles.healthHead}>
          <span className={styles.healthLabel}>{t('auth_files.card_requests')}</span>
          <span className={styles.healthCounts}>
            <span
              className={`${styles.countOk} ${successCount > 0 ? styles.countLive : ''}`}
              title={t('stats.success')}
            >
              {t('stats.success')} {successCount}
            </span>
            <span
              className={`${styles.countFail} ${failureCount > 0 ? styles.countLive : ''}`}
              title={t('stats.failure')}
            >
              {t('stats.failure')} {failureCount}
            </span>
          </span>
        </div>
        <ProviderStatusBar statusData={statusData} styles={styles} />
      </div>

      <div className={styles.metaRow}>
        <span title={t('auth_files.file_size')}>{file.size ? formatFileSize(file.size) : '-'}</span>
        <span className={styles.metaDivider} aria-hidden="true">
          ·
        </span>
        <span title={t('auth_files.file_modified')}>{formatModified(file)}</span>
        {priorityValue !== undefined && (
          <>
            <span className={styles.metaDivider} aria-hidden="true">
              ·
            </span>
            <span className={styles.metaPriority} title={t('auth_files.priority_hint')}>
              <span className={styles.metaMetricLabel}>{t('auth_files.priority_display')}</span>
              <span>{priorityValue}</span>
            </span>
          </>
        )}
        {weightValue !== undefined && (
          <>
            <span className={styles.metaDivider} aria-hidden="true">
              ·
            </span>
            <span className={styles.metaWeight} title={t('auth_files.weight_tooltip')}>
              <span className={styles.metaMetricLabel}>{t('auth_files.weight_display')}</span>
              <span>{weightValue}</span>
            </span>
          </>
        )}
      </div>

      {showQuotaLayout && quotaType && (
        <AuthFileQuotaSection file={file} quotaType={quotaType} disableControls={disableControls} />
      )}

      <AuthFilePoolSection
        account={account}
        providerKey={providerKey}
        quotaCapable={quotaCapable}
        onEgressChanged={onEgressChanged}
      />

      <footer className={styles.actions}>
        <div className={styles.actionsMain}>
          {showModelsButton && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onShowModels(file)}
              title={t('auth_files.models_button')}
              disabled={disableControls}
            >
              <IconModelCluster size={14} />
              {t('auth_files.models_button')}
            </Button>
          )}
          {!isRuntimeOnly && (
            <div className={styles.utilityActions}>
              {showManualRefreshButton && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onManualRefresh(file)}
                  className={styles.iconButton}
                  title={t('auth_files.manual_refresh_button')}
                  disabled={
                    disableControls ||
                    file.disabled ||
                    statusUpdating[getAuthFileRefreshKey(file)] === true ||
                    isManualRefreshing
                  }
                >
                  {isManualRefreshing ? <LoadingSpinner size={14} /> : <IconRefreshCw size={15} />}
                </Button>
              )}
              {showPolicyButton && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPolicySheetOpen(true)}
                  className={styles.iconButton}
                  title={t('auth_files.routing_policy_button')}
                  disabled={disableControls || isManualRefreshing}
                >
                  <IconSlidersHorizontal size={15} />
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onDownload(file.name)}
                className={styles.iconButton}
                title={t('auth_files.download_button')}
                disabled={disableControls}
              >
                <IconDownload size={15} />
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onOpenPrefixProxyEditor(file)}
                className={styles.iconButton}
                title={t('auth_files.prefix_proxy_button')}
                disabled={disableControls || isManualRefreshing}
              >
                <IconSettings size={15} />
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => onDelete(file.name)}
                className={styles.iconButton}
                title={t('auth_files.delete_button')}
                disabled={disableControls || deleting === file.name || isManualRefreshing}
              >
                {deleting === file.name ? <LoadingSpinner size={14} /> : <IconTrash2 size={15} />}
              </Button>
            </div>
          )}
        </div>
        {!isRuntimeOnly && (
          <div className={styles.toggleWrap}>
            <span className={styles.toggleLabel}>{t('auth_files.status_toggle_label')}</span>
            <ToggleSwitch
              ariaLabel={t('auth_files.card_toggle', { name: file.name })}
              checked={!file.disabled}
              disabled={
                disableControls ||
                statusUpdating[getAuthFileRefreshKey(file)] === true ||
                isManualRefreshing
              }
              onChange={(value) => onToggleStatus(file, value)}
            />
          </div>
        )}
      </footer>

      {showPolicyButton && (
        <AuthFileRoutingPolicySheet
          open={policySheetOpen}
          fileName={file.name}
          policy={account?.policy}
          channels={account?.channels}
          saving={policySaving}
          disabled={disableControls}
          onClose={() => setPolicySheetOpen(false)}
          onChange={(nextPolicy) => void handlePolicyChange(nextPolicy)}
          onRefreshChannels={
            onRefreshChannels ? () => onRefreshChannels(file) : undefined
          }
        />
      )}
    </article>
  );
}
