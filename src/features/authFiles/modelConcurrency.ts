import type { ModelConcurrencyEntry } from '@/types/authFile';
import { parseNonNegativeInteger } from '@/utils/models';

/** 抽屉里正在编辑的一行：模型名与并发上限都以字符串形式保存，便于中间态输入。 */
export interface ModelConcurrencyRow {
  id: string;
  model: string;
  limit: string;
}

export type ModelConcurrencyErrorKey =
  | 'auth_files.routing_policy_concurrency_model_required'
  | 'auth_files.routing_policy_concurrency_duplicate'
  | 'auth_files.routing_policy_concurrency_invalid';

export interface ModelConcurrencyRowError {
  id: string;
  key: ModelConcurrencyErrorKey;
}

/** 已保存的条目 → 可编辑行。id 只在本次抽屉会话内唯一即可。 */
export function toModelConcurrencyRows(
  entries: readonly ModelConcurrencyEntry[]
): ModelConcurrencyRow[] {
  return entries.map((entry, index) => ({
    id: `saved-${index}`,
    model: entry.model,
    limit: String(entry.max_concurrency),
  }));
}

/**
 * 逐行校验：模型名必填、大小写不敏感去重、上限必须是 0 或正整数。
 * 返回全部出错的行，而不是只报第一个，界面才能把错误标在对应行上。
 */
export function validateModelConcurrencyRows(
  rows: readonly ModelConcurrencyRow[]
): ModelConcurrencyRowError[] {
  const errors: ModelConcurrencyRowError[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const model = row.model.trim();
    if (!model) {
      errors.push({ id: row.id, key: 'auth_files.routing_policy_concurrency_model_required' });
      continue;
    }
    const key = model.toLowerCase();
    if (seen.has(key)) {
      errors.push({ id: row.id, key: 'auth_files.routing_policy_concurrency_duplicate' });
      continue;
    }
    seen.add(key);
    if (parseNonNegativeInteger(row.limit) === null) {
      errors.push({ id: row.id, key: 'auth_files.routing_policy_concurrency_invalid' });
    }
  }
  return errors;
}

/** 行 → 提交给后端的数组。有错时抛错：宁可让保存失败，也不静默丢行。 */
export function buildModelConcurrency(
  rows: readonly ModelConcurrencyRow[]
): ModelConcurrencyEntry[] {
  const errors = validateModelConcurrencyRows(rows);
  if (errors.length > 0) throw new Error(errors[0].key);
  return rows.map((row) => ({
    model: row.model.trim(),
    max_concurrency: parseNonNegativeInteger(row.limit) ?? 0,
  }));
}

/** 合并候选模型名：大小写不敏感去重，保留先出现的写法。 */
export function mergeModelCandidates(...lists: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const raw of list) {
      const model = raw.trim();
      if (!model) continue;
      const key = model.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(model);
    }
  }
  return out;
}