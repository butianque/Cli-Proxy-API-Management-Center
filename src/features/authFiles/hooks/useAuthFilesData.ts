import { useCallback, useEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient, authFilesApi } from '@/services/api';
import { accountsApi } from '@/services/api/accounts';
import { findQuotaPluginId, loadQuotaPluginIndex } from '@/services/api/accountQuota';
import { pluginsApi } from '@/services/api/plugins';
import type { AuthFileRefreshResult } from '@/services/api/authFiles';
import { getAuthFileRefreshKey } from '@/features/authFiles/manualRefresh';
import { notifyAuthFilesChanged } from '@/features/authFiles/authFilesEvents';
import { buildAccountIndex } from '@/features/authFiles/accountPool';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import type { ModelConcurrencyEntry } from '@/types/authFile';
import type { AccountPolicy, AccountsResponse, AccountView } from '@/types/accounts';
import { formatFileSize } from '@/utils/format';
import { MAX_AUTH_FILE_SIZE } from '@/utils/constants';
import { downloadBlob } from '@/utils/download';
import {
  getTypeLabel,
  isProblemAuthFile,
  isRuntimeOnlyAuthFile,
  normalizeProviderKey,
  supportsAuthFileManualRefresh,
} from '@/features/authFiles/constants';

type DeleteAllOptions = {
  filter: string;
  problemOnly: boolean;
  disabledOnly: boolean;
  enabledOnly: boolean;
  onResetFilterToAll: () => void;
  onResetProblemOnly: () => void;
  onResetDisabledOnly: () => void;
  onResetEnabledOnly: () => void;
};

export type LoadFilesOptions = {
  /** 后台刷新：不置 loading（网格保持内容），改用 refreshing 标志。 */
  background?: boolean;
};

export type UseAuthFilesDataOptions = {
  /** 文件集发生变更（上传/删除/手动刷新）后触发，供缓存失效等联动。 */
  onFilesMutated?: (names?: string[]) => void;
};

export type UseAuthFilesDataResult = {
  files: AuthFileItem[];
  /** 账号池视图，键 = `AuthFileItem.name`；`/accounts` 不可用时为空 Map。 */
  accountIndex: Map<string, AccountView>;
  /** provider 键（小写）→ 提供额度的插件 id；空 Map = 宿主没有额度通道。 */
  quotaPluginIndex: Map<string, string>;
  selectedFiles: Set<string>;
  selectionCount: number;
  loading: boolean;
  refreshing: boolean;
  error: string;
  uploading: boolean;
  deleting: string | null;
  deletingAll: boolean;
  statusUpdating: Record<string, boolean>;
  manualRefreshing: Record<string, boolean>;
  refreshingAllCredentials: boolean;
  refreshResults: AuthFileRefreshResult[] | null;
  closeRefreshResults: () => void;
  handleRefreshAllCredentials: () => void;
  cooldownResetting: Record<string, boolean>;
  batchStatusUpdating: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  loadFiles: (options?: LoadFilesOptions) => Promise<void>;
  handleUploadClick: () => void;
  handleFileChange: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleDelete: (name: string) => void;
  handleDeleteAll: (options: DeleteAllOptions) => void;
  handleDownload: (name: string) => Promise<void>;
  handleManualRefresh: (item: AuthFileItem) => Promise<void>;
  handleCooldownReset: (item: AuthFileItem) => void;
  handleStatusToggle: (item: AuthFileItem, enabled: boolean) => Promise<void>;
  /**
   * 写账号路由策略与逐模型并发上限；`policy = null` 清除策略，空数组清除逐模型上限。
   * 两个字段一起提交：分开写会让后一个响应覆盖前一个还没读到的值。失败时 reject，由调用方提示。
   */
  updateAccountPolicy: (
    name: string,
    policy: AccountPolicy | null,
    modelMaxConcurrency: ModelConcurrencyEntry[]
  ) => Promise<void>;
  /**
   * 该凭证可用的模型名，用于「路由策略 → 按模型并发上限」的候选。
   * 取不到时返回空数组（手填仍然可用），不抛错。
   */
  loadModelCandidates: (file: AuthFileItem) => Promise<string[]>;
  /**
   * 把一份按模型并发上限写进同一账号池分类下的其它凭证。
   * 只改 `model_max_concurrency`，各凭证自己的路由策略保持原样。
   * 返回实际成功/失败条数，由调用方决定怎么提示。
   */
  syncModelMaxConcurrency: (
    categoryKey: string,
    excludeName: string,
    entries: ModelConcurrencyEntry[]
  ) => Promise<{ ok: number; failed: number }>;
  /**
   * 触发宿主探测这些凭据的额度（宿主快照只能由插件额度通道写入），随后重读 `/accounts`。
   * `total` 只计入选的凭据——取不到额度插件或没有 `authIndex` 的跳过。不弹通知。
   */
  refreshQuotas: (targets: readonly AuthFileItem[]) => Promise<{ ok: number; total: number }>;
  toggleSelect: (name: string) => void;
  selectAllVisible: (visibleFiles: AuthFileItem[]) => void;
  invertVisibleSelection: (visibleFiles: AuthFileItem[]) => void;
  deselectAll: () => void;
  batchDownload: (names: string[]) => Promise<void>;
  batchSetStatus: (names: string[], enabled: boolean) => Promise<void>;
  batchDelete: (names: string[]) => void;
};

export function useAuthFilesData(options?: UseAuthFilesDataOptions): UseAuthFilesDataResult {
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();
  const onFilesMutated = options?.onFilesMutated;

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState<Record<string, boolean>>({});
  const [manualRefreshing, setManualRefreshing] = useState<Record<string, boolean>>({});
  const [refreshingAllCredentials, setRefreshingAllCredentials] = useState(false);
  const [refreshResults, setRefreshResults] = useState<AuthFileRefreshResult[] | null>(null);
  const refreshAllPendingRef = useRef(false);
  const closeRefreshResults = useCallback(() => setRefreshResults(null), []);
  const [cooldownResetting, setCooldownResetting] = useState<Record<string, boolean>>({});
  const [batchStatusUpdating, setBatchStatusUpdating] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [accountIndex, setAccountIndex] = useState<Map<string, AccountView>>(new Map());
  const [quotaPluginIndex, setQuotaPluginIndex] = useState<Map<string, string>>(new Map());

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadPendingRef = useRef(false);
  const manualRefreshPendingRef = useRef<Set<string>>(new Set());
  const cooldownResetPendingRef = useRef<Set<string>>(new Set());
  const batchStatusPendingRef = useRef(false);
  const statusPendingRef = useRef({ revision: -1, keys: new Set<string>() });
  /** 列表请求代号：变更操作会使在途响应过期，防止旧轮询复活已删/已改文件。 */
  const loadRequestIdRef = useRef(0);
  const invalidateInFlightLoads = useCallback(() => {
    loadRequestIdRef.current += 1;
    setLoading(false);
    setRefreshing(false);
  }, []);
  /**
   * 写入账号索引。**只在 `/accounts` 成功时写入**——失败保留上次结果，
   * 与 `files` 同一约定：一次瞬时故障不得让整页卡片的池区块一起消失。
   */
  const applyAccounts = useCallback(
    (nextFiles: AuthFileItem[], result: PromiseSettledResult<AccountsResponse>) => {
      if (result.status === 'fulfilled') {
        setAccountIndex(buildAccountIndex(nextFiles, result.value.accounts));
      }
    },
    []
  );
  const onFilesMutatedRef = useRef(onFilesMutated);
  useEffect(() => {
    onFilesMutatedRef.current = onFilesMutated;
  }, [onFilesMutated]);
  const selectionCount = selectedFiles.size;
  const toggleSelect = useCallback((name: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const selectAllVisible = useCallback((visibleFiles: AuthFileItem[]) => {
    const nextSelected = visibleFiles
      .filter((file) => !isRuntimeOnlyAuthFile(file))
      .map((file) => file.name);
    if (nextSelected.length === 0) return;
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      nextSelected.forEach((name) => next.add(name));
      return next;
    });
  }, []);

  const invertVisibleSelection = useCallback((visibleFiles: AuthFileItem[]) => {
    const visibleNames = visibleFiles
      .filter((file) => !isRuntimeOnlyAuthFile(file))
      .map((file) => file.name);
    if (visibleNames.length === 0) return;

    setSelectedFiles((prev) => {
      const next = new Set(prev);
      visibleNames.forEach((name) => {
        if (next.has(name)) {
          next.delete(name);
        } else {
          next.add(name);
        }
      });
      return next;
    });
  }, []);

  const deselectAll = useCallback(() => {
    setSelectedFiles(new Set());
  }, []);

  const applyDeletedFiles = useCallback(
    (names: string[]) => {
      const deletedNames = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
      if (deletedNames.length === 0) return;

      invalidateInFlightLoads();
      onFilesMutatedRef.current?.(deletedNames);
      const deletedSet = new Set(deletedNames);
      setFiles((prev) => prev.filter((file) => !deletedSet.has(file.name)));
      setSelectedFiles((prev) => {
        if (prev.size === 0) return prev;
        let changed = false;
        const next = new Set<string>();
        prev.forEach((name) => {
          if (deletedSet.has(name)) {
            changed = true;
          } else {
            next.add(name);
          }
        });
        return changed ? next : prev;
      });
    },
    [invalidateInFlightLoads]
  );

  useEffect(() => {
    if (selectedFiles.size === 0) return;
    const existingNames = new Set(files.map((file) => file.name));
    setSelectedFiles((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((name) => {
        if (existingNames.has(name)) {
          next.add(name);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [files, selectedFiles.size]);

  const loadFiles = useCallback(
    async (options?: LoadFilesOptions) => {
      const background = options?.background === true;
      const requestId = ++loadRequestIdRef.current;
      const connectionRevision = apiClient.getConnectionRevision();
      const isCurrentRequest = () =>
        requestId === loadRequestIdRef.current &&
        connectionRevision === apiClient.getConnectionRevision();

      if (background) {
        setRefreshing(true);
      } else {
        setLoading(true);
        setError('');
      }

      try {
        // 账号池视图与额度通道都是增强信息：`/accounts` 或插件清单失败
        // （旧宿主未挂载）不得连带把凭证列表判成错误。
        const [filesResult, accountsResult, quotaPluginsResult] = await Promise.allSettled([
          authFilesApi.list(),
          accountsApi.list(),
          loadQuotaPluginIndex(),
        ]);
        if (!isCurrentRequest()) return; // 已被更新的请求/连接/变更取代
        if (filesResult.status !== 'fulfilled') throw filesResult.reason;
        const nextFiles = filesResult.value?.files || [];
        setFiles(nextFiles);
        // `/accounts` 失败时保留上次成功索引（与 `files` 一致），否则一次瞬时故障
        // 会让整页卡片的池区块一起消失。
        applyAccounts(nextFiles, accountsResult);
        // 额度通道索引同理：宿主不可用/插件清单取不到时保留上次索引，绝不退回空 Map。
        if (quotaPluginsResult.status === 'fulfilled') {
          setQuotaPluginIndex(quotaPluginsResult.value);
        }
        setError('');
      } catch (err: unknown) {
        if (!isCurrentRequest()) return;
        const errorMessage = err instanceof Error ? err.message : t('notification.refresh_failed');
        setError(errorMessage);
      } finally {
        if (isCurrentRequest()) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [applyAccounts, t]
  );

  const updateAccountPolicy = useCallback(
    async (
      name: string,
      policy: AccountPolicy | null,
      modelMaxConcurrency: ModelConcurrencyEntry[]
    ) => {
      const connectionRevision = apiClient.getConnectionRevision();
      await authFilesApi.patchFields(name, {
        policy,
        model_max_concurrency: modelMaxConcurrency,
      });
      if (connectionRevision !== apiClient.getConnectionRevision()) return;
      invalidateInFlightLoads();
      await loadFiles({ background: true });
    },
    [invalidateInFlightLoads, loadFiles]
  );

  const loadModelCandidates = useCallback(async (file: AuthFileItem): Promise<string[]> => {
    const names: string[] = [];
    const seen = new Set<string>();
    const add = (model: unknown) => {
      const name = typeof model === 'string' ? model.trim() : '';
      if (!name || seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());
      names.push(name);
    };

    // 两条来源各自尽力：某个端点不可用时另一些仍然给出候选，全失败就只剩手填。
    const channels = [String(file.type ?? ''), String(file.provider ?? '')].filter(
      (channel, index, list) => channel.trim() !== '' && list.indexOf(channel) === index
    );
    const [perCredential, ...byChannel] = await Promise.allSettled([
      authFilesApi.getModelsForAuthFile(file.name),
      ...channels.map((channel) => authFilesApi.getModelDefinitions(channel)),
    ]);
    if (perCredential.status === 'fulfilled') {
      perCredential.value.forEach((model) => add(model.id));
    }
    for (const result of byChannel) {
      if (result.status !== 'fulfilled') continue;
      result.value.forEach((model) => add(model.id));
    }
    return names;
  }, []);

  /**
   * 勾了「同分类一起改」之后，把同一份按模型并发上限写进分类下的其它凭证。
   * 只带 `model_max_concurrency`：不带 `policy` 就不会碰别人的路由策略。
   * 小批量并发，避免十几个凭证同时改文件与列表轮询抢锁；失败只计数，不中断。
   */
  const syncModelMaxConcurrency = useCallback(
    async (
      categoryKey: string,
      excludeName: string,
      entries: ModelConcurrencyEntry[]
    ): Promise<{ ok: number; failed: number }> => {
      const revision = apiClient.getConnectionRevision();
      const names = new Set<string>();
      for (const file of files) {
        if (isRuntimeOnlyAuthFile(file) || file.name === excludeName) continue;
        if (normalizeProviderKey(String(file.type ?? file.provider ?? '')) !== categoryKey) continue;
        names.add(file.name);
      }
      const targets = [...names];
      if (targets.length === 0) return { ok: 0, failed: 0 };

      const chunkSize = 4;
      let ok = 0;
      let failed = 0;
      for (let index = 0; index < targets.length; index += chunkSize) {
        const chunk = targets.slice(index, index + chunkSize);
        const results = await Promise.allSettled(
          chunk.map((name) => authFilesApi.patchFields(name, { model_max_concurrency: entries }))
        );
        if (revision !== apiClient.getConnectionRevision()) return { ok, failed };
        for (const result of results) {
          if (result.status === 'fulfilled') ok++;
          else failed++;
        }
      }

      invalidateInFlightLoads();
      await loadFiles({ background: true });
      return { ok, failed };
    },
    [files, invalidateInFlightLoads, loadFiles]
  );

  /**
   * 触发宿主探测这些凭据的额度，再重读 `/accounts`。
   *
   * 宿主的额度快照**只能**由插件额度通道写入（`POST /plugins/{id}/quota`），面板不直接
   * 探测上游也不另存一份额度——所以逐个触发后必须重读，额度才在池区块里可见。
   * 通知归调用方（与 `updateAccountPolicy` 同一约定）；本函数不弹任何通知，
   * 因此可被页面自动探测**静默**复用。
   */
  const refreshQuotas = useCallback(
    async (targets: readonly AuthFileItem[]) => {
      const connectionRevision = apiClient.getConnectionRevision();
      const requests: Array<Promise<unknown>> = [];
      for (const file of targets) {
        // 候选键的先后即优先级；取不到插件 id 或宿主没给 authIndex 的凭据不参与，
        // 不计入 total——宿主无处落快照，算进分母只会让结果看起来更差。
        const pluginId = findQuotaPluginId(quotaPluginIndex, [
          String(file.provider ?? ''),
          String(file.type ?? ''),
        ]);
        const authIndex = String(file.authIndex ?? '').trim();
        if (!pluginId || !authIndex) continue;
        requests.push(pluginsApi.fetchQuota(pluginId, authIndex));
      }

      // 一个目标都没命中就什么都不发：宿主快照不会变，重读也读不出新东西。
      // 自动探测因此不会在「没有可探测目标」时产生任何请求。
      if (requests.length === 0) return { ok: 0, total: 0 };

      const results = await Promise.allSettled(requests);
      const ok = results.filter((result) => result.status === 'fulfilled').length;

      // 无论成败都重读一次：成功的那部分已经把额度写进宿主快照，只有重读才看得见。
      const [accountsResult] = await Promise.allSettled([accountsApi.list()]);
      if (connectionRevision === apiClient.getConnectionRevision()) {
        applyAccounts(files, accountsResult);
      }

      return { ok, total: requests.length };
    },
    [applyAccounts, files, quotaPluginIndex]
  );

  const handleUploadClick = useCallback(() => {
    if (uploadPendingRef.current) return;
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const fileList = event.target.files;
      if (!fileList || fileList.length === 0) return;

      const filesToUpload = Array.from(fileList);
      const validFiles: File[] = [];
      const invalidFiles: string[] = [];
      const oversizedFiles: string[] = [];

      filesToUpload.forEach((file) => {
        if (!file.name.endsWith('.json')) {
          invalidFiles.push(file.name);
          return;
        }
        if (file.size > MAX_AUTH_FILE_SIZE) {
          oversizedFiles.push(file.name);
          return;
        }
        validFiles.push(file);
      });

      if (invalidFiles.length > 0) {
        showNotification(t('auth_files.upload_error_json'), 'error');
      }
      if (oversizedFiles.length > 0) {
        showNotification(
          t('auth_files.upload_error_size', { maxSize: formatFileSize(MAX_AUTH_FILE_SIZE) }),
          'error'
        );
      }

      if (validFiles.length === 0) {
        event.target.value = '';
        return;
      }
      if (uploadPendingRef.current) {
        event.target.value = '';
        return;
      }

      uploadPendingRef.current = true;
      setUploading(true);
      try {
        const result = await authFilesApi.uploadFiles(validFiles);
        const successCount = result.uploaded;

        if (successCount > 0) {
          const suffix = validFiles.length > 1 ? ` (${successCount}/${validFiles.length})` : '';
          showNotification(
            `${t('auth_files.upload_success')}${suffix}`,
            result.failed.length ? 'warning' : 'success'
          );
          notifyAuthFilesChanged();
          onFilesMutatedRef.current?.(result.files.length > 0 ? result.files : undefined);
          await loadFiles({ background: true });
        }

        if (result.failed.length > 0) {
          const details = result.failed.map((item) => `${item.name}: ${item.error}`).join('; ');
          showNotification(`${t('notification.upload_failed')}: ${details}`, 'error');
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        showNotification(`${t('notification.upload_failed')}: ${errorMessage}`, 'error');
      } finally {
        uploadPendingRef.current = false;
        setUploading(false);
        event.target.value = '';
      }
    },
    [loadFiles, showNotification, t]
  );

  const handleDelete = useCallback(
    (name: string) => {
      showConfirmation({
        title: t('auth_files.delete_title', { defaultValue: 'Delete File' }),
        message: `${t('auth_files.delete_confirm')} "${name}" ?`,
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          setDeleting(name);
          try {
            const result = await authFilesApi.deleteFile(name);
            showNotification(t('auth_files.delete_success'), 'success');
            applyDeletedFiles(result.files.length > 0 ? result.files : [name]);
            if (result.deleted > 0) notifyAuthFilesChanged();
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : '';
            showNotification(`${t('notification.delete_failed')}: ${errorMessage}`, 'error');
          } finally {
            setDeleting(null);
          }
        },
      });
    },
    [applyDeletedFiles, showConfirmation, showNotification, t]
  );

  const handleDeleteAll = useCallback(
    (deleteAllOptions: DeleteAllOptions) => {
      const {
        filter,
        problemOnly,
        disabledOnly,
        enabledOnly,
        onResetFilterToAll,
        onResetProblemOnly,
        onResetDisabledOnly,
        onResetEnabledOnly,
      } = deleteAllOptions;
      const isFiltered = filter !== 'all';
      const isProblemOnly = problemOnly === true;
      const isDisabledOnly = disabledOnly === true;
      const isEnabledOnly = enabledOnly === true;
      const typeLabel = isFiltered ? getTypeLabel(t, filter) : t('auth_files.filter_all');
      let confirmMessage = t('auth_files.delete_all_confirm');
      if (isDisabledOnly || isEnabledOnly) {
        confirmMessage = t('auth_files.delete_filtered_result_confirm');
      } else if (isProblemOnly) {
        confirmMessage = isFiltered
          ? t('auth_files.delete_problem_filtered_confirm', { type: typeLabel })
          : t('auth_files.delete_problem_confirm');
      } else if (isFiltered) {
        confirmMessage = t('auth_files.delete_filtered_confirm', { type: typeLabel });
      }

      showConfirmation({
        title: t('auth_files.delete_all_title', { defaultValue: 'Delete All Files' }),
        message: confirmMessage,
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          setDeletingAll(true);
          try {
            if (!isFiltered && !isProblemOnly && !isDisabledOnly && !isEnabledOnly) {
              await authFilesApi.deleteAll();
              showNotification(t('auth_files.delete_all_success'), 'success');
              invalidateInFlightLoads();
              onFilesMutatedRef.current?.();
              setFiles((prev) => prev.filter((file) => isRuntimeOnlyAuthFile(file)));
              deselectAll();
              notifyAuthFilesChanged();
            } else {
              const filesToDelete = files.filter((file) => {
                if (isRuntimeOnlyAuthFile(file)) return false;
                if (
                  isFiltered &&
                  normalizeProviderKey(String(file.type ?? file.provider ?? '')) !== filter
                ) {
                  return false;
                }
                if (isProblemOnly && !isProblemAuthFile(file)) return false;
                if (isDisabledOnly && file.disabled !== true) return false;
                if (isEnabledOnly && file.disabled === true) return false;
                return true;
              });

              if (filesToDelete.length === 0) {
                let emptyMessage = t('auth_files.delete_filtered_none', { type: typeLabel });
                if (isDisabledOnly || isEnabledOnly) {
                  emptyMessage = t('auth_files.delete_filtered_result_none');
                } else if (isProblemOnly) {
                  emptyMessage = isFiltered
                    ? t('auth_files.delete_problem_filtered_none', { type: typeLabel })
                    : t('auth_files.delete_problem_none');
                }
                showNotification(emptyMessage, 'info');
                setDeletingAll(false);
                return;
              }

              const result = await authFilesApi.deleteFiles(filesToDelete.map((file) => file.name));
              const success = result.deleted;
              const failed = result.failed.length;

              applyDeletedFiles(result.files);
              if (result.deleted > 0) notifyAuthFilesChanged();

              if (failed === 0 && (isDisabledOnly || isEnabledOnly)) {
                showNotification(
                  t('auth_files.delete_filtered_result_success', { count: success }),
                  'success'
                );
              } else if (failed === 0 && isProblemOnly) {
                showNotification(
                  isFiltered
                    ? t('auth_files.delete_problem_filtered_success', {
                        count: success,
                        type: typeLabel,
                      })
                    : t('auth_files.delete_problem_success', { count: success }),
                  'success'
                );
              } else if (failed === 0) {
                showNotification(
                  t('auth_files.delete_filtered_success', { count: success, type: typeLabel }),
                  'success'
                );
              } else if (isDisabledOnly || isEnabledOnly) {
                showNotification(
                  t('auth_files.delete_filtered_result_partial', { success, failed }),
                  'warning'
                );
              } else if (isProblemOnly) {
                showNotification(
                  isFiltered
                    ? t('auth_files.delete_problem_filtered_partial', {
                        success,
                        failed,
                        type: typeLabel,
                      })
                    : t('auth_files.delete_problem_partial', { success, failed }),
                  'warning'
                );
              } else {
                showNotification(
                  t('auth_files.delete_filtered_partial', { success, failed, type: typeLabel }),
                  'warning'
                );
              }

              if (isFiltered) {
                onResetFilterToAll();
              }
              if (isProblemOnly) {
                onResetProblemOnly();
              }
              if (isDisabledOnly) {
                onResetDisabledOnly();
              }
              if (isEnabledOnly) {
                onResetEnabledOnly();
              }
            }
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : '';
            showNotification(`${t('notification.delete_failed')}: ${errorMessage}`, 'error');
          } finally {
            setDeletingAll(false);
          }
        },
      });
    },
    [
      applyDeletedFiles,
      deselectAll,
      files,
      invalidateInFlightLoads,
      showConfirmation,
      showNotification,
      t,
    ]
  );

  const handleDownload = useCallback(
    async (name: string) => {
      try {
        const blob = await authFilesApi.download(name);
        downloadBlob({ filename: name, blob });
        showNotification(t('auth_files.download_success'), 'success');
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : '';
        showNotification(`${t('notification.download_failed')}: ${errorMessage}`, 'error');
      }
    },
    [showNotification, t]
  );

  const handleManualRefresh = useCallback(
    async (item: AuthFileItem) => {
      const name = item.name.trim();
      const provider = item.type ?? item.provider;
      const key = getAuthFileRefreshKey(item);
      const connectionRevision = apiClient.getConnectionRevision();
      if (
        !name ||
        item.disabled === true ||
        isRuntimeOnlyAuthFile(item) ||
        !supportsAuthFileManualRefresh(provider) ||
        refreshAllPendingRef.current ||
        manualRefreshPendingRef.current.has(key)
      ) {
        return;
      }

      manualRefreshPendingRef.current.add(key);
      setManualRefreshing((prev) => ({ ...prev, [key]: true }));

      try {
        await authFilesApi.requestManualRefresh(
          name,
          String(item.authIndex ?? '').trim() || undefined
        );
        if (connectionRevision !== apiClient.getConnectionRevision()) return;
        invalidateInFlightLoads();
        showNotification(t('auth_files.manual_refresh_requested', { name }), 'info');
        notifyAuthFilesChanged();
        onFilesMutatedRef.current?.([name]);
        await loadFiles({ background: true });
      } catch (err: unknown) {
        if (connectionRevision !== apiClient.getConnectionRevision()) return;
        const message = err instanceof Error ? err.message : t('notification.update_failed');
        showNotification(t('auth_files.manual_refresh_failed', { name, message }), 'error');
      } finally {
        manualRefreshPendingRef.current.delete(key);
        setManualRefreshing((prev) => {
          if (connectionRevision !== apiClient.getConnectionRevision() || !prev[key]) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    [invalidateInFlightLoads, loadFiles, showNotification, t]
  );

  const handleRefreshAllCredentials = useCallback(() => {
    if (refreshAllPendingRef.current || manualRefreshPendingRef.current.size > 0) return;
    const connectionRevision = apiClient.getConnectionRevision();
    showConfirmation({
      title: t('auth_files.refresh_all_button'),
      message: t('auth_files.refresh_all_confirm'),
      confirmText: t('auth_files.refresh_all_button'),
      onConfirm: async () => {
        if (
          connectionRevision !== apiClient.getConnectionRevision() ||
          refreshAllPendingRef.current ||
          manualRefreshPendingRef.current.size > 0
        )
          return;
        refreshAllPendingRef.current = true;
        setRefreshingAllCredentials(true);
        setRefreshResults(null);
        try {
          const results = await authFilesApi.requestAllManualRefresh();
          if (connectionRevision !== apiClient.getConnectionRevision()) return;
          setRefreshResults(results);
        } catch (err: unknown) {
          if (connectionRevision !== apiClient.getConnectionRevision()) return;
          const message = err instanceof Error ? err.message : t('notification.update_failed');
          showNotification(t('auth_files.refresh_all_failed', { message }), 'error');
        } finally {
          refreshAllPendingRef.current = false;
          if (connectionRevision === apiClient.getConnectionRevision()) {
            setRefreshingAllCredentials(false);
            // Even a timeout can follow partial backend mutations.
            invalidateInFlightLoads();
            onFilesMutatedRef.current?.();
            notifyAuthFilesChanged();
            await loadFiles({ background: true });
          }
        }
      },
    });
  }, [invalidateInFlightLoads, loadFiles, showConfirmation, showNotification, t]);

  const handleCooldownReset = useCallback(
    (item: AuthFileItem) => {
      const authIndex = String(item.authIndex ?? '').trim();
      if (
        !authIndex ||
        !item.cooldownSnapshot?.records?.length ||
        cooldownResetPendingRef.current.has(authIndex)
      ) {
        return;
      }

      const connectionRevision = apiClient.getConnectionRevision();
      showConfirmation({
        title: t('auth_files.cooldown_reset_title'),
        message: t('auth_files.cooldown_reset_confirm', { name: item.name }),
        confirmText: t('auth_files.cooldown_reset_button'),
        variant: 'primary',
        onConfirm: async () => {
          if (
            connectionRevision !== apiClient.getConnectionRevision() ||
            cooldownResetPendingRef.current.has(authIndex)
          ) {
            return;
          }
          cooldownResetPendingRef.current.add(authIndex);
          setCooldownResetting((prev) => ({ ...prev, [authIndex]: true }));

          try {
            await authFilesApi.resetCooldown(authIndex);
            if (connectionRevision !== apiClient.getConnectionRevision()) return;
            invalidateInFlightLoads();
            setFiles((prev) =>
              prev.map((file) =>
                String(file.authIndex ?? '').trim() === authIndex && file.cooldownSnapshot
                  ? {
                      ...file,
                      cooldownSnapshot: {
                        ...file.cooldownSnapshot,
                        receivedAtMs: Date.now(),
                        records: [],
                      },
                    }
                  : file
              )
            );
            showNotification(
              t('auth_files.cooldown_reset_success', { name: item.name }),
              'success'
            );
            await loadFiles({ background: true });
          } catch (err: unknown) {
            if (connectionRevision !== apiClient.getConnectionRevision()) return;
            const message = err instanceof Error ? err.message : t('notification.update_failed');
            showNotification(
              t('auth_files.cooldown_reset_failed', { name: item.name, message }),
              'error'
            );
          } finally {
            cooldownResetPendingRef.current.delete(authIndex);
            setCooldownResetting((prev) => {
              if (!prev[authIndex]) return prev;
              const next = { ...prev };
              delete next[authIndex];
              return next;
            });
          }
        },
      });
    },
    [invalidateInFlightLoads, loadFiles, showConfirmation, showNotification, t]
  );

  const handleStatusToggle = useCallback(
    async (item: AuthFileItem, enabled: boolean) => {
      const revision = apiClient.getConnectionRevision();
      if (statusPendingRef.current.revision !== revision) {
        statusPendingRef.current = { revision, keys: new Set() };
        batchStatusPendingRef.current = false;
        setBatchStatusUpdating(false);
        setStatusUpdating({});
      }
      const key = getAuthFileRefreshKey(item);
      if (statusPendingRef.current.keys.has(key)) return;
      statusPendingRef.current.keys.add(key);
      const name = item.name;
      const nextDisabled = !enabled;
      const previousDisabled = item.disabled === true;

      setStatusUpdating((prev) => ({ ...prev, [key]: true }));
      invalidateInFlightLoads();
      setFiles((prev) =>
        prev.map((f) => (getAuthFileRefreshKey(f) === key ? { ...f, disabled: nextDisabled } : f))
      );

      try {
        const res = await authFilesApi.setStatus(
          name,
          nextDisabled,
          String(item.authIndex ?? '').trim() || undefined
        );
        if (revision !== apiClient.getConnectionRevision()) return;
        invalidateInFlightLoads();
        setFiles((prev) =>
          revision !== apiClient.getConnectionRevision()
            ? prev
            : prev.map((f) =>
                getAuthFileRefreshKey(f) === key ? { ...f, disabled: res.disabled } : f
              )
        );
        showNotification(
          enabled
            ? t('auth_files.status_enabled_success', { name })
            : t('auth_files.status_disabled_success', { name }),
          'success'
        );
      } catch (err: unknown) {
        if (revision !== apiClient.getConnectionRevision()) return;
        const errorMessage = err instanceof Error ? err.message : '';
        setFiles((prev) =>
          revision !== apiClient.getConnectionRevision()
            ? prev
            : prev.map((f) =>
                getAuthFileRefreshKey(f) === key ? { ...f, disabled: previousDisabled } : f
              )
        );
        showNotification(`${t('notification.update_failed')}: ${errorMessage}`, 'error');
      } finally {
        if (revision === apiClient.getConnectionRevision()) {
          statusPendingRef.current.keys.delete(key);
          setStatusUpdating((prev) => {
            if (revision !== apiClient.getConnectionRevision()) return prev;
            const next = { ...prev };
            delete next[key];
            return next;
          });
        }
      }
    },
    [invalidateInFlightLoads, showNotification, t]
  );

  const batchSetStatus = useCallback(
    async (names: string[], enabled: boolean) => {
      const revision = apiClient.getConnectionRevision();
      if (statusPendingRef.current.revision !== revision) {
        statusPendingRef.current = { revision, keys: new Set() };
        batchStatusPendingRef.current = false;
        setBatchStatusUpdating(false);
        setStatusUpdating({});
      }
      if (batchStatusPendingRef.current) return;

      const uniqueNames = new Set(names);
      const targets = new Map(
        files
          .filter((file) => uniqueNames.has(file.name))
          .map((file) => [getAuthFileRefreshKey(file), file])
      );
      if ([...targets.keys()].some((key) => statusPendingRef.current.keys.has(key))) return;
      const originalDisabled = new Map(
        [...targets].map(([key, file]) => [key, file.disabled === true])
      );
      const targetNames = new Set(originalDisabled.keys());
      const targetNameList = Array.from(targetNames);
      if (targetNameList.length === 0) return;

      const nextDisabled = !enabled;

      batchStatusPendingRef.current = true;
      targetNameList.forEach((key) => statusPendingRef.current.keys.add(key));
      setBatchStatusUpdating(true);
      invalidateInFlightLoads();
      setStatusUpdating((prev) => {
        const next = { ...prev };
        targetNameList.forEach((name) => {
          next[name] = true;
        });
        return next;
      });
      setFiles((prev) =>
        prev.map((file) =>
          targetNames.has(getAuthFileRefreshKey(file)) ? { ...file, disabled: nextDisabled } : file
        )
      );

      try {
        const results = await Promise.allSettled(
          targetNameList.map((key) => {
            const file = targets.get(key)!;
            return authFilesApi.setStatus(
              file.name,
              nextDisabled,
              String(file.authIndex ?? '').trim() || undefined
            );
          })
        );
        if (revision !== apiClient.getConnectionRevision()) return;
        invalidateInFlightLoads();

        let successCount = 0;
        let failCount = 0;
        const failedNames = new Set<string>();
        const confirmedDisabled = new Map<string, boolean>();

        results.forEach((result, index) => {
          const name = targetNameList[index];
          if (result.status === 'fulfilled') {
            successCount++;
            confirmedDisabled.set(name, result.value.disabled);
          } else {
            failCount++;
            failedNames.add(name);
          }
        });

        setFiles((prev) =>
          revision !== apiClient.getConnectionRevision()
            ? prev
            : prev.map((file) => {
                const key = getAuthFileRefreshKey(file);
                if (failedNames.has(key)) {
                  return { ...file, disabled: originalDisabled.get(key) === true };
                }
                if (confirmedDisabled.has(key)) {
                  return { ...file, disabled: confirmedDisabled.get(key) };
                }
                return file;
              })
        );

        if (failCount === 0) {
          showNotification(
            t('auth_files.batch_status_success', { count: successCount }),
            'success'
          );
        } else {
          showNotification(
            t('auth_files.batch_status_partial', { success: successCount, failed: failCount }),
            'warning'
          );
        }

        deselectAll();
      } finally {
        if (revision === apiClient.getConnectionRevision()) {
          batchStatusPendingRef.current = false;
          targetNameList.forEach((key) => statusPendingRef.current.keys.delete(key));
          setBatchStatusUpdating(false);
          setStatusUpdating((prev) => {
            if (revision !== apiClient.getConnectionRevision()) return prev;
            const next = { ...prev };
            targetNameList.forEach((key) => {
              delete next[key];
            });
            return next;
          });
        }
      }
    },
    [deselectAll, files, invalidateInFlightLoads, showNotification, t]
  );

  const batchDownload = useCallback(
    async (names: string[]) => {
      const uniqueNames = Array.from(new Set(names));
      if (uniqueNames.length === 0) return;

      let successCount = 0;
      let failCount = 0;

      for (const name of uniqueNames) {
        try {
          const blob = await authFilesApi.download(name);
          downloadBlob({ filename: name, blob });
          successCount++;
        } catch {
          failCount++;
        }
      }

      if (failCount === 0) {
        showNotification(
          t('auth_files.batch_download_success', { count: successCount }),
          'success'
        );
      } else {
        showNotification(
          t('auth_files.batch_download_partial', { success: successCount, failed: failCount }),
          'warning'
        );
      }

      // 与 batchSetStatus 保持一致：批量动作完成后清空选择
      deselectAll();
    },
    [deselectAll, showNotification, t]
  );

  const batchDelete = useCallback(
    (names: string[]) => {
      const uniqueNames = Array.from(new Set(names));
      if (uniqueNames.length === 0) return;

      showConfirmation({
        title: t('auth_files.batch_delete_title'),
        message: t('auth_files.batch_delete_confirm', { count: uniqueNames.length }),
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          try {
            const result = await authFilesApi.deleteFiles(uniqueNames);
            applyDeletedFiles(result.files);
            if (result.deleted > 0) notifyAuthFilesChanged();

            if (result.failed.length === 0) {
              showNotification(
                `${t('auth_files.delete_all_success')} (${result.deleted})`,
                'success'
              );
            } else {
              showNotification(
                t('auth_files.delete_filtered_partial', {
                  success: result.deleted,
                  failed: result.failed.length,
                  type: t('auth_files.filter_all'),
                }),
                'warning'
              );
            }
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : '';
            showNotification(`${t('notification.delete_failed')}: ${errorMessage}`, 'error');
          }
        },
      });
    },
    [applyDeletedFiles, showConfirmation, showNotification, t]
  );

  return {
    files,
    accountIndex,
    quotaPluginIndex,
    selectedFiles,
    selectionCount,
    loading,
    refreshing,
    error,
    uploading,
    deleting,
    deletingAll,
    statusUpdating,
    manualRefreshing,
    refreshingAllCredentials,
    refreshResults,
    closeRefreshResults,
    handleRefreshAllCredentials,
    cooldownResetting,
    batchStatusUpdating,
    fileInputRef,
    loadFiles,
    handleUploadClick,
    handleFileChange,
    handleDelete,
    handleDeleteAll,
    handleDownload,
    handleManualRefresh,
    handleCooldownReset,
    handleStatusToggle,
    updateAccountPolicy,
    loadModelCandidates,
    syncModelMaxConcurrency,
    refreshQuotas,
    toggleSelect,
    selectAllVisible,
    invertVisibleSelection,
    deselectAll,
    batchDownload,
    batchSetStatus,
    batchDelete,
  };
}
