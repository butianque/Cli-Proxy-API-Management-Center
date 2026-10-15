/**
 * 账号聚合视图 API —— 宿主 `GET /v8/management/accounts`
 *
 * 这是「一个账号一行」的读取面：凭证身份、账号池状态、路由策略、额度快照与请求热力
 * 各有一个来源，面板不再需要拼 4 个接口并猜哪个字段属于哪一层。
 *
 * 字段契约与可空性以 `../CLIProxyAPI/internal/api/handlers/management/account_view.go`
 * 为准，失败归类值域见 `account_failure.go`。归一化把后端 snake_case 转成
 * `@/types/accounts` 的 camelCase，组件只消费后者。
 *
 * 归一化沿用后端的两条不可协商语义（`account_view.go:28-31`）：
 * 1. 后端无法确定的值一律省略或 null，前端不得回落成 0 / false；
 * 2. 读取永不探测上游，额度只来自宿主快照缓存，缺快照即 `unknown`。
 */

import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';
import type {
  AccountAuthState,
  AccountFailureClass,
  AccountHeatBucket,
  AccountPolicy,
  AccountQuotaBucket,
  AccountQuotaState,
  AccountSourceKind,
  AccountView,
  AccountsCounts,
  AccountsListParams,
  AccountsResponse,
} from '@/types/accounts';

/** `auth_state` 的完整词表（`sdk/cliproxy/auth/status.go:6-19`）。 */
const AUTH_STATES: readonly AccountAuthState[] = [
  'unknown',
  'active',
  'pending',
  'refreshing',
  'error',
  'disabled',
];

/** 本接口实际产出的 `quota_state`（`sdk/pluginapi/types.go:2004-2011` 的子集）。 */
const QUOTA_STATES: readonly AccountQuotaState[] = [
  'unknown',
  'query-error',
  'exhausted',
  'entitled',
];

/** 失败归类词表（`account_failure.go:12-20`）。 */
const FAILURE_CLASSES: readonly AccountFailureClass[] = [
  'auth',
  'quota',
  'risk',
  'rate',
  'network',
  'request',
  'upstream',
];

/** 账号路由策略词表（`sdk/pluginapi/types.go:1975-1980`）。 */
const ACCOUNT_POLICIES: readonly AccountPolicy[] = [
  'start-plan-only',
  'api-key-only',
  'start-plan-first',
  'disabled',
];

/** 供应池身份类别词表（`internal/supply/supply.go:30-35`）。 */
const SOURCE_KINDS: readonly AccountSourceKind[] = ['phone', 'email'];

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** 省略语义：空串与缺失同义，都不造值。 */
const optionalString = (value: unknown): string | undefined => trimString(value) || undefined;

/** 契约里无 omitempty 的布尔字段：缺失只可能来自非本契约的响应。 */
const readBoolean = (value: unknown): boolean => value === true;

/** 可空布尔：`null` 与缺失同义，都表示「后端未给出」。 */
const optionalBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/** 契约里无 omitempty 的计数字段：缺失只可能来自非本契约的响应。 */
const readCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** 可空数值：`null` 与缺失同义，绝不回落成 0。 */
const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const readEnum = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T | undefined
): T | undefined => {
  const raw = trimString(value);
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
};

const normalizeQuotaBucket = (value: unknown): AccountQuotaBucket | undefined => {
  if (!isRecord(value)) return undefined;
  const remainingFraction = optionalNumber(value.remaining_fraction);
  // remaining_fraction 在契约里无 omitempty（0 是真实值，不是「未知」）。
  // 缺省只可能来自违约响应；此时丢弃该桶，绝不臆造 0。
  if (remainingFraction === undefined) return undefined;
  const bucket: AccountQuotaBucket = { remainingFraction };
  const group = optionalString(value.group);
  const model = optionalString(value.model);
  const window = optionalString(value.window);
  const remaining = optionalNumber(value.remaining);
  const total = optionalNumber(value.total);
  const resetAt = optionalString(value.reset_at);
  const description = optionalString(value.description);
  if (group !== undefined) bucket.group = group;
  if (model !== undefined) bucket.model = model;
  if (window !== undefined) bucket.window = window;
  if (remaining !== undefined) bucket.remaining = remaining;
  if (total !== undefined) bucket.total = total;
  if (resetAt !== undefined) bucket.resetAt = resetAt;
  if (description !== undefined) bucket.description = description;
  return bucket;
};

const normalizeHeatBucket = (value: unknown): AccountHeatBucket | undefined => {
  if (!isRecord(value)) return undefined;
  const bucket: AccountHeatBucket = {
    bucket: trimString(value.bucket),
    success: readCount(value.success),
    failed: readCount(value.failed),
  };
  const successRate = optionalNumber(value.success_rate);
  if (successRate !== undefined) bucket.successRate = successRate;
  return bucket;
};

const normalizeCountMap = (value: unknown): Record<string, number> => {
  if (!isRecord(value)) return {};
  const counts: Record<string, number> = {};
  Object.entries(value).forEach(([key, raw]) => {
    if (typeof raw === 'number' && Number.isFinite(raw)) counts[key] = raw;
  });
  return counts;
};

const normalizeCounts = (value: unknown): AccountsCounts => {
  const counts: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    total: readCount(counts.total),
    // 早退分支（account_view.go:101）只给 total，两个 map 缺失即空对象。
    byProvider: normalizeCountMap(counts.by_provider),
    byState: normalizeCountMap(counts.by_state),
  };
};

/**
 * 归一化一个账号。`authId` 原样保留：它就是 `/credentials` 的 `name`，
 * 是既有按文件操作的键（见 `@/types/accounts` 的说明）。
 */
export const normalizeAccountView = (value: unknown): AccountView => {
  const entry: Record<string, unknown> = isRecord(value) ? value : {};
  const account: AccountView = {
    provider: trimString(entry.provider),
    authIndex: trimString(entry.auth_index),
    authId: trimString(entry.auth_id),
    displayName: trimString(entry.display_name),
    parsed: readBoolean(entry.parsed),
    enabled: readBoolean(entry.enabled),
    authState: readEnum(entry.auth_state, AUTH_STATES, 'unknown') ?? 'unknown',
    eligible: readBoolean(entry.eligible),
    manuallyDisabled: readBoolean(entry.manually_disabled),
    quotaState: readEnum(entry.quota_state, QUOTA_STATES, 'unknown') ?? 'unknown',
    quota: Array.isArray(entry.quota)
      ? entry.quota
          .map(normalizeQuotaBucket)
          .filter((bucket): bucket is AccountQuotaBucket => bucket !== undefined)
      : [],
    requestCount: readCount(entry.request_count),
    successCount: readCount(entry.success_count),
    failureCount: readCount(entry.failure_count),
    // 后端无历史时下发 null（不是 []），两者语义相同：没有历史。
    heatmap: Array.isArray(entry.heatmap)
      ? entry.heatmap
          .map(normalizeHeatBucket)
          .filter((bucket): bucket is AccountHeatBucket => bucket !== undefined)
      : [],
  };

  const accountId = optionalString(entry.account_id);
  const site = optionalString(entry.site);
  const sourceKind = readEnum(entry.source_kind, SOURCE_KINDS, undefined);
  const supportsRefresh = optionalBoolean(entry.supports_refresh);
  const cooldownUntil = optionalString(entry.cooldown_until);
  const failureClass = readEnum(entry.failure_class, FAILURE_CLASSES, undefined);
  const failureReason = optionalString(entry.failure_reason);
  const failureRetryable = optionalBoolean(entry.failure_retryable);
  const planId = optionalString(entry.plan_id);
  const channel = optionalString(entry.channel);
  const policy = readEnum(entry.policy, ACCOUNT_POLICIES, undefined);
  const entitlement = optionalString(entry.entitlement);
  const fetchedAt = optionalString(entry.fetched_at);

  if (accountId !== undefined) account.accountId = accountId;
  if (site !== undefined) account.site = site;
  if (sourceKind !== undefined) account.sourceKind = sourceKind;
  if (supportsRefresh !== undefined) account.supportsRefresh = supportsRefresh;
  if (cooldownUntil !== undefined) account.cooldownUntil = cooldownUntil;
  if (failureClass !== undefined) account.failureClass = failureClass;
  if (failureReason !== undefined) account.failureReason = failureReason;
  if (failureRetryable !== undefined) account.failureRetryable = failureRetryable;
  if (planId !== undefined) account.planId = planId;
  if (channel !== undefined) account.channel = channel;
  if (policy !== undefined) account.policy = policy;
  if (entitlement !== undefined) account.entitlement = entitlement;
  if (fetchedAt !== undefined) account.fetchedAt = fetchedAt;

  return account;
};

/** 契约边界归一化：把 `{ status, accounts, counts }` 的生响应转成 UI 类型。 */
export const normalizeAccountsResponse = (payload: unknown): AccountsResponse => {
  const source: Record<string, unknown> = isRecord(payload) ? payload : {};
  const entries = Array.isArray(source.accounts) ? source.accounts : [];
  return {
    status: trimString(source.status),
    accounts: entries.filter(isRecord).map(normalizeAccountView),
    counts: normalizeCounts(source.counts),
  };
};

/**
 * 构造查询串。两个过滤条件都是可选的；都为空时不带 params，
 * 避免把空串当成过滤条件传给后端（`account_view.go:98-99` 会 trim 后比较）。
 */
const buildListConfig = (
  params?: AccountsListParams
): { params: Record<string, string> } | undefined => {
  const provider = trimString(params?.provider);
  const kind = params?.kind;
  if (!provider && !kind) return undefined;
  const query: Record<string, string> = {};
  if (provider) query.provider = provider;
  if (kind) query.kind = kind;
  return { params: query };
};

export const accountsApi = {
  /**
   * `apiClient` 的 baseURL 已含 `/v8/management` 前缀（`client.ts:132` 写入
   * `computeApiUrl` 的结果，前缀常量在 `utils/constants.ts:17`），此处只写 `/accounts`。
   */
  list: async (params?: AccountsListParams): Promise<AccountsResponse> =>
    normalizeAccountsResponse(await apiClient.get<unknown>('/accounts', buildListConfig(params))),
};
