/**
 * 模型工具函数
 * 迁移自基线 utils/models.js
 */

import { isRecord } from './helpers';

export interface ModelInfo {
  name: string;
  alias?: string;
  description?: string;
}

const MODEL_CATEGORIES = [
  { id: 'devin', label: 'Devin', patterns: [] },
  { id: 'meta', label: 'Muse', patterns: [/\bmuse(?:[-/\s]|$)/i] },
  { id: 'gpt', label: 'GPT', patterns: [/gpt/i, /\bo\d\b/i, /\bo\d+\.?/i, /\bchatgpt/i] },
  { id: 'claude', label: 'Claude', patterns: [/claude/i] },
  { id: 'gemini', label: 'Gemini', patterns: [/gemini/i, /\bgai\b/i] },
  { id: 'kimi', label: 'Kimi', patterns: [/kimi/i] },
  { id: 'qwen', label: 'Qwen', patterns: [/qwen/i] },
  { id: 'glm', label: 'GLM', patterns: [/glm/i, /chatglm/i] },
  { id: 'grok', label: 'Grok', patterns: [/grok/i] },
  { id: 'deepseek', label: 'DeepSeek', patterns: [/deepseek/i] },
  { id: 'minimax', label: 'MiniMax', patterns: [/minimax/i, /abab/i] },
];

const matchCategory = (text: string) => {
  for (const category of MODEL_CATEGORIES) {
    if (category.patterns.some((pattern) => pattern.test(text))) {
      return category.id;
    }
  }
  return null;
};

export function normalizeModelList(payload: unknown, { dedupe = false } = {}): ModelInfo[] {
  const toModel = (entry: unknown): ModelInfo | null => {
    if (typeof entry === 'string') {
      return { name: entry };
    }
    if (!isRecord(entry)) {
      return null;
    }
    const name = entry.id || entry.name || entry.model || entry.value;
    if (!name) return null;

    const alias = entry.alias || entry.display_name || entry.displayName;
    const description = entry.description || entry.note || entry.comment;
    const model: ModelInfo = { name: String(name) };
    if (alias && alias !== name) {
      model.alias = String(alias);
    }
    if (description) {
      model.description = String(description);
    }
    return model;
  };

  let models: (ModelInfo | null)[] = [];

  if (Array.isArray(payload)) {
    models = payload.map(toModel);
  } else if (isRecord(payload)) {
    if (Array.isArray(payload.data)) {
      models = payload.data.map(toModel);
    } else if (Array.isArray(payload.models)) {
      models = payload.models.map(toModel);
    }
  }

  const normalized = models.filter(Boolean) as ModelInfo[];
  if (!dedupe) {
    return normalized;
  }

  const seen = new Set<string>();
  return normalized.filter((model) => {
    const key = (model?.name || '').toLowerCase();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** 非负整数（数字或数字字符串）→ number；其余一律 null。 */
export function parseNonNegativeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * 逐模型并发上限（列表接口的 `model_max_concurrency`）→ 干净条目。
 * 读不懂的行直接丢掉：界面宁可不显示，也不显示一个后端不会执行的上限。
 */
export function readModelConcurrencyEntries(
  raw: unknown
): { model: string; max_concurrency: number }[] {
  if (!Array.isArray(raw)) return [];
  const entries: { model: string; max_concurrency: number }[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const model = typeof item.model === 'string' ? item.model.trim() : '';
    const limit = parseNonNegativeInteger(item.max_concurrency);
    if (!model || limit === null) continue;
    entries.push({ model, max_concurrency: limit });
  }
  return entries;
}

export interface ModelGroup {
  id: string;
  label: string;
  items: ModelInfo[];
}

export function classifyModels(
  models: ModelInfo[] = [],
  { otherLabel = 'Other' } = {}
): ModelGroup[] {
  const groups: ModelGroup[] = MODEL_CATEGORIES.map((category) => ({
    id: category.id,
    label: category.label,
    items: [],
  }));

  const otherGroup: ModelGroup = { id: 'other', label: otherLabel, items: [] };

  models.forEach((model) => {
    const name = (model?.name || '').toString();
    const alias = (model?.alias || '').toString();
    const haystack = `${name} ${alias}`.toLowerCase();
    const matchedId = /^devin\//i.test(name) ? 'devin' : matchCategory(haystack);
    const target = matchedId ? groups.find((group) => group.id === matchedId) : null;

    if (target) {
      target.items.push(model);
    } else {
      otherGroup.items.push(model);
    }
  });

  const populatedGroups = groups.filter((group) => group.items.length > 0);
  if (otherGroup.items.length) {
    populatedGroups.push(otherGroup);
  }

  return populatedGroups;
}
