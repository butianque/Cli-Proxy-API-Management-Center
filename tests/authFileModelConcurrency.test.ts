import { describe, expect, test } from 'bun:test';
import {
  buildModelConcurrency,
  mergeModelCandidates,
  toModelConcurrencyRows,
  validateModelConcurrencyRows,
  type ModelConcurrencyRow,
} from '../src/features/authFiles/modelConcurrency';

const row = (id: string, model: string, limit: string): ModelConcurrencyRow => ({
  id,
  model,
  limit,
});

describe('per-model concurrency rows', () => {
  test('round-trips saved entries into editable rows', () => {
    expect(
      toModelConcurrencyRows([
        { model: 'glm-5.3-flash', max_concurrency: 20 },
        { model: 'glm-5.3', max_concurrency: 0 },
      ])
    ).toEqual([
      { id: 'saved-0', model: 'glm-5.3-flash', limit: '20' },
      { id: 'saved-1', model: 'glm-5.3', limit: '0' },
    ]);
  });

  test('accepts 0 as unlimited and positive whole numbers as limits', () => {
    const rows = [row('a', 'glm-5.3-flash', '20'), row('b', 'glm-5.3', '0')];
    expect(validateModelConcurrencyRows(rows)).toEqual([]);
    expect(buildModelConcurrency(rows)).toEqual([
      { model: 'glm-5.3-flash', max_concurrency: 20 },
      { model: 'glm-5.3', max_concurrency: 0 },
    ]);
  });

  test('reports every broken row instead of only the first one', () => {
    // 逐行标错才能让用户看见是哪一行有问题；只抛第一个错会把后面的行留在
    // 界面上却没法保存。
    const errors = validateModelConcurrencyRows([
      row('empty', '  ', '3'),
      row('negative', 'glm-5.3', '-1'),
      row('fraction', 'glm-5.3-flash', '1.5'),
      row('missing', 'glm-4.6', ''),
    ]);
    expect(errors.map((entry) => entry.id)).toEqual(['empty', 'negative', 'fraction', 'missing']);
    expect(errors[0].key).toBe('auth_files.routing_policy_concurrency_model_required');
    expect(errors[1].key).toBe('auth_files.routing_policy_concurrency_invalid');
    expect(errors[3].key).toBe('auth_files.routing_policy_concurrency_invalid');
  });

  test('treats model names case-insensitively when de-duplicating', () => {
    const errors = validateModelConcurrencyRows([
      row('a', 'GLM-5.3', '1'),
      row('b', 'glm-5.3', '2'),
    ]);
    expect(errors).toEqual([{ id: 'b', key: 'auth_files.routing_policy_concurrency_duplicate' }]);
    expect(() => buildModelConcurrency([row('a', 'GLM-5.3', '1'), row('b', 'glm-5.3', '2')])).toThrow();
  });

  test('rejects limits that are not whole non-negative numbers', () => {
    for (const limit of ['', '-1', '1.5', '1e2', 'NaN', '9007199254740992']) {
      expect(
        validateModelConcurrencyRows([row('a', 'glm-5.3', limit)]).map((entry) => entry.key)
      ).toEqual(['auth_files.routing_policy_concurrency_invalid']);
    }
  });

  test('trims the model name before submitting it', () => {
    expect(buildModelConcurrency([row('a', ' glm-5.3 ', '2')])).toEqual([
      { model: 'glm-5.3', max_concurrency: 2 },
    ]);
  });

  test('submits nothing when there are no rows', () => {
    expect(buildModelConcurrency([])).toEqual([]);
  });
});

describe('model candidates', () => {
  test('merges every source without duplicating a model', () => {
    expect(
      mergeModelCandidates(['glm-5.3'], ['GLM-5.3', 'glm-5.3-flash'], [' glm-4.6 ', ''])
    ).toEqual(['glm-5.3', 'glm-5.3-flash', 'glm-4.6']);
  });

  test('returns no candidates when nothing is known', () => {
    expect(mergeModelCandidates([], [])).toEqual([]);
  });
});