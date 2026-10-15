import { describe, expect, test } from 'bun:test';
import { buildAccountIndex, policyI18nSuffix } from '../src/features/authFiles/accountPool';
import type { AccountView } from '../src/types/accounts';
import type { AuthFileItem } from '../src/types';
import { getQuotaCacheKey } from '../src/utils/quota/identity';

const account = (overrides: Partial<AccountView> = {}): AccountView => ({
  provider: 'codex',
  authIndex: 'idx-1',
  authId: 'x.json',
  displayName: 'user@example.com',
  parsed: true,
  enabled: true,
  authState: 'active',
  eligible: true,
  manuallyDisabled: false,
  quotaState: 'unknown',
  quota: [],
  requestCount: 0,
  successCount: 0,
  failureCount: 0,
  heatmap: [],
  ...overrides,
});

const authFile = (overrides: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name: 'x.json',
  ...overrides,
});

describe('buildAccountIndex', () => {
  test('matches when authId equals the credential name', () => {
    const view = account({ authId: 'x.json' });
    const index = buildAccountIndex([authFile()], [view]);

    expect(index.get('x.json')).toBe(view);
    expect(index.size).toBe(1);
  });

  test('matches a subdirectory authId through its basename', () => {
    const view = account({ authId: 'sub/x.json' });
    const index = buildAccountIndex([authFile()], [view]);

    expect(index.get('x.json')).toBe(view);
  });

  test('matches a Windows backslash subdirectory authId', () => {
    const view = account({ authId: 'sub\\nested\\x.json' });
    const index = buildAccountIndex([authFile()], [view]);

    expect(index.get('x.json')).toBe(view);
  });

  test('matches case-insensitively (Windows lowercases the watcher path)', () => {
    const view = account({ authId: 'SUB\\X.JSON' });
    const index = buildAccountIndex([authFile()], [view]);

    expect(index.get('x.json')).toBe(view);
  });

  test('falls back to authIndex when the identifiers differ', () => {
    const view = account({ authId: 'elsewhere.json', authIndex: '42' });
    const index = buildAccountIndex(
      [authFile({ name: 'y.json', authIndex: 42 })],
      [view]
    );

    expect(index.get('y.json')).toBe(view);
  });

  test('never matches on an empty authIndex on either side', () => {
    const view = account({ authId: 'elsewhere.json', authIndex: '' });
    const index = buildAccountIndex([authFile({ name: 'y.json', authIndex: '' })], [view]);

    expect(index.has('y.json')).toBe(false);
    expect(index.size).toBe(0);
  });

  test('keeps unmatched files out of the index instead of fabricating a value', () => {
    const view = account({ authId: 'x.json', authIndex: 'idx-1' });
    const index = buildAccountIndex(
      [authFile({ name: 'x.json' }), authFile({ name: 'orphan.json', authIndex: 'nope' })],
      [view]
    );

    expect(index.size).toBe(1);
    expect(index.has('x.json')).toBe(true);
    expect(index.has('orphan.json')).toBe(false);
  });

  test('prefers the exact authId match over an authIndex fallback', () => {
    const exact = account({ authId: 'x.json', authIndex: 'exact' });
    const fallback = account({ authId: 'other.json', authIndex: 'shared' });
    const index = buildAccountIndex([authFile({ authIndex: 'shared' })], [fallback, exact]);

    expect(index.get('x.json')).toBe(exact);
  });

  test('returns an empty map when either side is empty', () => {
    expect(buildAccountIndex([], [account()]).size).toBe(0);
    expect(buildAccountIndex([authFile()], []).size).toBe(0);
  });

  test('keys the index by the credential name and keeps rows independent', () => {
    const first = account({ authId: 'a.json', authIndex: '1' });
    const second = account({ authId: 'b.json', authIndex: '2' });
    const index = buildAccountIndex(
      [authFile({ name: 'a.json', authIndex: '1' }), authFile({ name: 'b.json', authIndex: '2' })],
      [first, second]
    );

    expect(index.get('a.json')).toBe(first);
    expect(index.get('b.json')).toBe(second);
    expect(index.size).toBe(2);
  });

  test('gives each identity of one multi-identity file its own account', () => {
    const first = account({ authId: 'devin.json', authIndex: '1' });
    const second = account({ authId: 'devin.json', authIndex: '2' });
    const rows = [
      authFile({ name: 'devin.json', provider: 'devin', authIndex: '1' }),
      authFile({ name: 'devin.json', provider: 'devin', authIndex: '2' }),
    ];
    const index = buildAccountIndex(rows, [first, second]);

    expect(index.get(getQuotaCacheKey(rows[0]))).toBe(first);
    expect(index.get(getQuotaCacheKey(rows[1]))).toBe(second);
    expect(index.size).toBe(2);
  });

  test('resolves a name shared by several accounts through authIndex', () => {
    const first = account({ authId: 'sub/x.json', authIndex: '1' });
    const second = account({ authId: 'other/x.json', authIndex: '2' });
    const index = buildAccountIndex([authFile({ authIndex: '2' })], [first, second]);

    expect(index.get('x.json')).toBe(second);
  });

  test('never hands a shared name to one of several accounts', () => {
    const first = account({ authId: 'sub/x.json', authIndex: '1' });
    const second = account({ authId: 'other/x.json', authIndex: '2' });
    const index = buildAccountIndex([authFile()], [first, second]);

    expect(index.has('x.json')).toBe(false);
    expect(index.size).toBe(0);
  });
});

describe('policyI18nSuffix', () => {
  test('converts the start-plan-only policy to its key suffix', () => {
    expect(policyI18nSuffix('start-plan-only')).toBe('start_plan_only');
  });

  test('converts every policy value', () => {
    expect(policyI18nSuffix('api-key-only')).toBe('api_key_only');
    expect(policyI18nSuffix('start-plan-first')).toBe('start_plan_first');
    expect(policyI18nSuffix('disabled')).toBe('disabled');
  });
});
