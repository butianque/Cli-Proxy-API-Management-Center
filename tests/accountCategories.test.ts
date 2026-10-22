import { describe, expect, test } from 'bun:test';
import {
  accountCategories,
  accountCategoryOf,
  accountCategoryOptions,
} from '../src/features/config/accountCategories';

describe('accountCategoryOf', () => {
  test('reads the credential type, which is the category the host matches', () => {
    expect(accountCategoryOf({ type: 'loomy' })).toBe('loomy');
    expect(accountCategoryOf({ type: 'workbuddy-global', provider: 'workbuddy' })).toBe(
      'workbuddy-global'
    );
  });

  test('falls back to the provider when no type is recorded', () => {
    expect(accountCategoryOf({ provider: 'zcode-cn' })).toBe('zcode-cn');
    expect(accountCategoryOf({})).toBe('');
    expect(accountCategoryOf({ type: '  Loomy  ' })).toBe('loomy');
  });
});

describe('accountCategories', () => {
  test('counts credentials per category in first-seen order', () => {
    expect(
      accountCategories([
        { type: 'loomy' },
        { type: 'workbuddy-global' },
        { type: 'loomy' },
        { type: 'loomy' },
      ])
    ).toEqual([
      { name: 'loomy', count: 3 },
      { name: 'workbuddy-global', count: 1 },
    ]);
  });

  test('ignores files that carry no usable category', () => {
    expect(
      accountCategories([
        { type: 'empty' },
        { type: 'unknown' },
        {},
        { type: 'loomy' },
      ])
    ).toEqual([{ name: 'loomy', count: 1 }]);
  });

  test('no credentials means no categories', () => {
    expect(accountCategories([])).toEqual([]);
  });
});

describe('accountCategoryOptions', () => {
  const categories = [
    { name: 'loomy', count: 4 },
    { name: 'workbuddy-global', count: 1 },
  ];

  test('offers every live category, ticked state tracked by the caller', () => {
    expect(accountCategoryOptions(categories, [])).toEqual([
      { name: 'loomy', count: 4, missing: false },
      { name: 'workbuddy-global', count: 1, missing: false },
    ]);
  });

  test('keeps a scoped category that no longer has credentials', () => {
    // A scope the operator cannot see is one they cannot clear, so a stale entry
    // stays visible and is flagged instead of disappearing.
    expect(accountCategoryOptions(categories, ['zcode-bigmodel'])).toEqual([
      { name: 'loomy', count: 4, missing: false },
      { name: 'workbuddy-global', count: 1, missing: false },
      { name: 'zcode-bigmodel', count: 0, missing: true },
    ]);
  });

  test('matches selected entries case-insensitively and skips blanks', () => {
    expect(accountCategoryOptions(categories, [' Loomy ', '', '  '])).toEqual([
      { name: 'loomy', count: 4, missing: false },
      { name: 'workbuddy-global', count: 1, missing: false },
    ]);
  });
});
