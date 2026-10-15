import { describe, expect, test } from 'bun:test';
import { buildQuotaPluginIndex, findQuotaPluginId } from '../src/services/api/accountQuota';
import type { PluginListEntry } from '../src/types';

const plugin = (overrides: Partial<PluginListEntry> = {}): PluginListEntry => ({
  id: 'zcode',
  path: 'plugins/zcode',
  configured: true,
  registered: true,
  enabled: true,
  effectiveEnabled: true,
  supportsOAuth: false,
  supportsQuota: true,
  quotaProvider: 'zcode',
  logo: '',
  configFields: [],
  menus: [],
  metadata: null,
  ...overrides,
});

describe('buildQuotaPluginIndex', () => {
  test('indexes a quota-capable plugin by its provider key', () => {
    const index = buildQuotaPluginIndex([plugin()]);

    expect(index.get('zcode')).toBe('zcode');
    expect(index.size).toBe(1);
  });

  test('normalizes the provider key to lower case and trims it', () => {
    const index = buildQuotaPluginIndex([plugin({ id: 'p1', quotaProvider: '  ZCode  ' })]);

    expect(index.get('zcode')).toBe('p1');
  });

  test('skips plugins that do not declare quota support', () => {
    const index = buildQuotaPluginIndex([
      plugin({ id: 'p1', supportsQuota: false }),
      plugin({ id: 'p2', supportsQuota: false, quotaProvider: 'other' }),
    ]);

    expect(index.size).toBe(0);
  });

  test('skips plugins without a provider key', () => {
    const index = buildQuotaPluginIndex([
      plugin({ id: 'p1', quotaProvider: undefined }),
      plugin({ id: 'p2', quotaProvider: '   ' }),
    ]);

    expect(index.size).toBe(0);
  });

  test('lets the last plugin win when two claim the same provider key', () => {
    const index = buildQuotaPluginIndex([plugin({ id: 'first' }), plugin({ id: 'second' })]);

    expect(index.get('zcode')).toBe('second');
  });
});

describe('findQuotaPluginId', () => {
  const index = buildQuotaPluginIndex([plugin({ id: 'p1', quotaProvider: 'zcode' })]);

  test('returns the first candidate that hits', () => {
    expect(findQuotaPluginId(index, ['claude', 'zcode'])).toBe('p1');
  });

  test('matches regardless of case and surrounding whitespace', () => {
    expect(findQuotaPluginId(index, ['  ZCODE '])).toBe('p1');
  });

  test('ignores blank candidates', () => {
    expect(findQuotaPluginId(index, ['', '   ', 'zcode'])).toBe('p1');
  });

  test('returns undefined when no candidate matches', () => {
    expect(findQuotaPluginId(index, ['claude', 'codex'])).toBeUndefined();
  });

  test('returns undefined for an empty index', () => {
    expect(findQuotaPluginId(new Map(), ['zcode'])).toBeUndefined();
  });
});
