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

describe('buildQuotaPluginIndex — oauthProviders keys', () => {
  /** 宿主对多键插件只暴露第一个键，国际站的 `zcode-zai` 只能由清单补齐。 */
  const zcode = (overrides: Partial<PluginListEntry> = {}) =>
    plugin({
      id: 'zcode',
      quotaProvider: 'zcode-bigmodel',
      oauthProviders: ['zcode-bigmodel', 'zcode-zai'],
      ...overrides,
    });

  test('indexes every key declared in oauthProviders', () => {
    const index = buildQuotaPluginIndex([zcode()]);

    expect(index.get('zcode-bigmodel')).toBe('zcode');
    expect(index.get('zcode-zai')).toBe('zcode');
    expect(index.size).toBe(2);
  });

  test('keeps indexing the single quotaProvider key', () => {
    const index = buildQuotaPluginIndex([zcode({ oauthProviders: undefined })]);

    expect(index.get('zcode-bigmodel')).toBe('zcode');
    expect(index.size).toBe(1);
  });

  test('normalizes oauthProviders keys to lower case and trims them', () => {
    const index = buildQuotaPluginIndex([
      zcode({ quotaProvider: undefined, oauthProviders: ['  ZCode-ZAI  ', ' zcode-bigmodel '] }),
    ]);

    expect(index.get('zcode-zai')).toBe('zcode');
    expect(index.get('zcode-bigmodel')).toBe('zcode');
    expect(index.size).toBe(2);
  });

  test('produces no key for blank or missing entries', () => {
    const index = buildQuotaPluginIndex([
      zcode({ quotaProvider: undefined, oauthProviders: ['', '   '] }),
      plugin({ id: 'p2', quotaProvider: undefined, oauthProviders: undefined }),
    ]);

    expect(index.size).toBe(0);
  });

  test('ignores oauthProviders of plugins without quota support', () => {
    const index = buildQuotaPluginIndex([zcode({ supportsQuota: false })]);

    expect(index.size).toBe(0);
  });

  test('lets a later plugin win over an oauthProviders key of an earlier one', () => {
    const index = buildQuotaPluginIndex([
      zcode(),
      plugin({ id: 'second', quotaProvider: 'zcode-zai', oauthProviders: undefined }),
    ]);

    expect(index.get('zcode-zai')).toBe('second');
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

  test('resolves the international provider key that the host never exposes', () => {
    const zcodeIndex = buildQuotaPluginIndex([
      plugin({
        id: 'zcode',
        quotaProvider: 'zcode-bigmodel',
        oauthProviders: ['zcode-bigmodel', 'zcode-zai'],
      }),
    ]);

    expect(findQuotaPluginId(zcodeIndex, ['zcode-zai', 'zcode-bigmodel'])).toBe('zcode');
    expect(findQuotaPluginId(zcodeIndex, ['  ZCode-ZAI '])).toBe('zcode');
  });
});
