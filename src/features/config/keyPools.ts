// Client API key → account category scoping (v8 `access.key-pools`).
// A key with no entries is unrestricted; the backend drops unknown keys and empty
// lists, so this module keeps the visual editor on the same contract.

import type { VisualConfigValues } from '@/types/visualConfig';

export type ApiKeyPools = VisualConfigValues['apiKeyPools'];

/**
 * Set equality, not sequence equality. A scope is a **set** of categories — the
 * backend reads it as one, and the order is whatever the user happened to tick —
 * so reordering the same entries is not a change. Comparing by index instead made
 * "untick a category, tick it again" flag the field dirty and rewrite the YAML order.
 */
export const areStringArraysEqual = (
  left: readonly string[],
  right: readonly string[]
): boolean => {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  const remaining = new Set(right);
  for (const item of left) {
    // delete() doubles as the membership test: a member may only be consumed once,
    // so a duplicate on the left fails against a non-duplicated right.
    if (!remaining.delete(item)) return false;
  }
  return true;
};

const normalizePoolList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
};

/** Read `access.key-pools` from parsed YAML into the flat visual form value. */
export function parseApiKeyPools(raw: unknown): ApiKeyPools {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: ApiKeyPools = {};
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const apiKey = rawKey.trim();
    if (!apiKey) continue;
    const pools = normalizePoolList(rawValue);
    if (pools.length > 0) result[apiKey] = pools;
  }
  return result;
}

/**
 * Serialize back to YAML. Entries for keys no longer in `access.api-keys` are
 * dropped (the backend ignores them) and empty pool lists are removed.
 */
export function serializeApiKeyPoolsForYaml(
  pools: ApiKeyPools,
  apiKeys: readonly string[]
): ApiKeyPools {
  const allowed = new Set(apiKeys.map((key) => key.trim()).filter(Boolean));
  const result: ApiKeyPools = {};
  for (const [apiKey, values] of Object.entries(pools)) {
    if (!allowed.has(apiKey)) continue;
    const cleaned = normalizePoolList(values);
    if (cleaned.length > 0) result[apiKey] = cleaned;
  }
  return result;
}

export function areApiKeyPoolsEqual(
  left: ApiKeyPools | undefined,
  right: ApiKeyPools | undefined
): boolean {
  const a = left ?? {};
  const b = right ?? {};
  if (a === b) return true;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!areStringArraysEqual(a[key], b[key])) return false;
  }
  return true;
}

/** Set (or clear, when empty) the pool list for one API key. */
export function withApiKeyPools(
  pools: ApiKeyPools,
  apiKey: string,
  next: readonly string[]
): ApiKeyPools {
  const cleaned = normalizePoolList(next);
  const result: ApiKeyPools = { ...pools };
  if (cleaned.length === 0) {
    delete result[apiKey];
  } else {
    result[apiKey] = cleaned;
  }
  return result;
}

export function removeApiKeyPools(pools: ApiKeyPools, apiKey: string): ApiKeyPools {
  if (!Object.prototype.hasOwnProperty.call(pools, apiKey)) return pools;
  const result: ApiKeyPools = { ...pools };
  delete result[apiKey];
  return result;
}

/** Move a pool list when an API key itself is edited. */
export function renameApiKeyPools(pools: ApiKeyPools, from: string, to: string): ApiKeyPools {
  if (from === to || !Object.prototype.hasOwnProperty.call(pools, from)) return pools;
  const result: ApiKeyPools = { ...pools };
  result[to] = result[from];
  delete result[from];
  return result;
}

/**
 * Whether `candidate` is already used by another entry. Scoping is keyed by the
 * API key value, so a duplicate would give two rows one shared scope (editing one
 * edits both, deleting one drops the other's scope), and renaming a key onto an
 * existing value would overwrite that key's scope.
 */
export function isDuplicateApiKey(
  apiKeys: readonly string[],
  candidate: string,
  ignoreIndex: number
): boolean {
  return apiKeys.some((key, index) => index !== ignoreIndex && key === candidate);
}
