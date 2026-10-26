import type { AuthFileFieldsPatch } from '@/services/api/authFiles';
import {
  applyCredentialPolicyValues,
  buildCredentialAliases,
  buildCredentialRules,
  readCredentialAliases,
  readCredentialPolicyValue,
  readCredentialRules,
  type CredentialAliasDraft,
} from '@/services/api/authFilePolicyAdapter';
import {
  buildErrorRules,
  readErrorRules,
  validateErrorRule,
  type ErrorRuleDraft,
} from '@/features/providers/errorRules';

export type PolicyMode = 'inherit' | 'custom';
export interface CredentialPolicyValues {
  requestRetry: { mode: PolicyMode; value: string };
  maxConcurrency: { mode: PolicyMode; value: string };
  modelAliases: { mode: PolicyMode; rows: CredentialAliasDraft[] | null };
  errorRules: { mode: PolicyMode; rows: ErrorRuleDraft[] | null };
}
export type CredentialPolicyField = keyof CredentialPolicyValues;
export type CredentialPolicyValue = CredentialPolicyValues[CredentialPolicyField];
export type CredentialPolicyDraft = CredentialPolicyValues & {
  touched: Partial<Record<CredentialPolicyField, boolean>>;
};
export type CredentialPolicyError =
  | 'auth_files.policy_retry_invalid'
  | 'auth_files.policy_concurrency_invalid'
  | 'auth_files.policy_aliases_invalid'
  | 'auth_files.policy_rules_invalid';
const keys = {
  requestRetry: 'request_retry',
  maxConcurrency: 'max_concurrency',
  modelAliases: 'model_aliases',
  errorRules: 'request_scoped_errors',
} as const;
/** 用 `null` 表示「清除该键、回到继承」的字段（其余字段的继承值是一个空列表）。 */
const scalarFields: readonly CredentialPolicyField[] = ['requestRetry', 'maxConcurrency'];
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 读一个整数型策略字段：非负整数才算「自定义」，其余（缺失、null、负数、
 * 小数、非数字）一律按「继承」处理。
 *
 * 负数是宿主的「未设置」哨兵（与 `request_retry` 一致），读出来不能当成一个
 * 自定义上限，否则面板会把一个后端会忽略的值显示成生效值。
 */
function readNonNegativeInt(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? String(parsed) : null;
}

export function readCredentialPolicy(json: Record<string, unknown>): CredentialPolicyDraft {
  const retry = readCredentialPolicyValue(json, keys.requestRetry);
  const retryNumber =
    typeof retry === 'number' || (typeof retry === 'string' && /^[+-]?\d+$/.test(retry.trim()))
      ? Number(retry)
      : null;
  const inheritsRetry = retry == null || (retryNumber !== null && retryNumber < 0);
  const concurrency = readNonNegativeInt(
    readCredentialPolicyValue(json, keys.maxConcurrency)
  );
  const aliases = readCredentialAliases(readCredentialPolicyValue(json, keys.modelAliases));
  const rules = readCredentialRules(readCredentialPolicyValue(json, keys.errorRules));
  return {
    requestRetry: {
      mode: inheritsRetry ? 'inherit' : 'custom',
      value: inheritsRetry ? '0' : String(retryNumber ?? retry),
    },
    maxConcurrency: {
      mode: concurrency === null ? 'inherit' : 'custom',
      value: concurrency ?? '0',
    },
    modelAliases: { mode: aliases?.length === 0 ? 'inherit' : 'custom', rows: aliases },
    errorRules: {
      mode: rules?.length === 0 ? 'inherit' : 'custom',
      rows: rules === null ? null : readErrorRules(rules),
    },
    touched: {},
  };
}
export function credentialPolicyError(draft?: CredentialPolicyDraft): CredentialPolicyError | null {
  if (!draft) return null;
  const retry = draft.requestRetry;
  if (
    draft.touched.requestRetry &&
    retry.mode === 'custom' &&
    (!/^\d+$/.test(retry.value.trim()) || !Number.isSafeInteger(Number(retry.value)))
  )
    return 'auth_files.policy_retry_invalid';
  const concurrency = draft.maxConcurrency;
  if (
    draft.touched.maxConcurrency &&
    concurrency.mode === 'custom' &&
    readNonNegativeInt(concurrency.value.trim()) === null
  )
    return 'auth_files.policy_concurrency_invalid';
  if (
    draft.touched.modelAliases &&
    draft.modelAliases.mode === 'custom' &&
    draft.modelAliases.rows?.some((row) => {
      if (row.original && equal(buildCredentialAliases([row])[0], row.original)) return false;
      return !row.name.trim() || !row.alias?.trim();
    })
  )
    return 'auth_files.policy_aliases_invalid';
  if (
    draft.touched.errorRules &&
    draft.errorRules.mode === 'custom' &&
    draft.errorRules.rows?.some(validateErrorRule)
  )
    return 'auth_files.policy_rules_invalid';
  return null;
}
export function buildCredentialPolicyPatch(
  original: Record<string, unknown>,
  draft?: CredentialPolicyDraft
): AuthFileFieldsPatch {
  const patch: Record<string, unknown> = {};
  if (!draft) return patch;
  const initial = readCredentialPolicy(original);
  const error = credentialPolicyError(draft);
  if (error) throw new Error(error);
  for (const field of Object.keys(keys) as CredentialPolicyField[]) {
    if (!draft.touched[field] || equal(draft[field], initial[field])) continue;
    let value: unknown;
    if (field === 'requestRetry')
      value = draft.requestRetry.mode === 'inherit' ? null : Number(draft.requestRetry.value);
    else if (field === 'maxConcurrency')
      value =
        draft.maxConcurrency.mode === 'inherit'
          ? null
          : Number(draft.maxConcurrency.value.trim());
    else if (draft[field].mode === 'inherit') value = [];
    else if (field === 'modelAliases') {
      if (draft.modelAliases.rows === null) continue;
      value = buildCredentialAliases(draft.modelAliases.rows);
    } else {
      if (draft.errorRules.rows === null) continue;
      value = buildCredentialRules(
        buildErrorRules(draft.errorRules.rows),
        draft.errorRules.rows.map((row) => row.original)
      );
    }
    if (
      !equal(
        value,
        readCredentialPolicyValue(original, keys[field]) ??
          (scalarFields.includes(field) ? null : [])
      )
    )
      patch[keys[field]] = value;
  }
  return patch as AuthFileFieldsPatch;
}
export function applyCredentialPolicyPatch(
  json: Record<string, unknown>,
  patch: AuthFileFieldsPatch
) {
  applyCredentialPolicyValues(json, patch);
}
