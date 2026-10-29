import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  pageWindow,
  resolvePageSlice,
} from '../src/hooks/usePagination';

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

describe('resolvePageSlice', () => {
  test('the first page covers the first pageSize entries', () => {
    expect(resolvePageSlice(1, 137, 20)).toEqual({
      page: 1,
      totalPages: 7,
      start: 0,
      from: 1,
      to: 20,
    });
  });

  test('the last page stops at the entry count instead of the page boundary', () => {
    expect(resolvePageSlice(7, 137, 20)).toEqual({
      page: 7,
      totalPages: 7,
      start: 120,
      from: 121,
      to: 137,
    });
  });

  test('a page past the end is clamped back to the last page', () => {
    // 删掉最后一页的唯一一条之后，页码还停在原来那个数字上。
    expect(resolvePageSlice(9, 137, 20).page).toBe(7);
  });

  test('a page below the first is clamped to one', () => {
    expect(resolvePageSlice(0, 137, 20).page).toBe(1);
    expect(resolvePageSlice(-3, 137, 20).page).toBe(1);
  });

  test('an empty list still has one page, and covers nothing', () => {
    expect(resolvePageSlice(1, 0, 20)).toEqual({
      page: 1,
      totalPages: 1,
      start: 0,
      from: 0,
      to: 0,
    });
  });

  test('the page count follows the page size', () => {
    expect(resolvePageSlice(1, 137, 50).totalPages).toBe(3);
    expect(resolvePageSlice(1, 137, 100).totalPages).toBe(2);
  });
});

describe('pageWindow', () => {
  test('a short list shows every page number', () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  test('a long list keeps the first and last page and collapses the middle', () => {
    expect(pageWindow(10, 40)).toEqual([1, 'gap', 9, 10, 11, 'gap', 40]);
  });

  test('near the start there is no leading gap', () => {
    expect(pageWindow(1, 40)).toEqual([1, 2, 'gap', 40]);
  });

  test('near the end there is no trailing gap', () => {
    expect(pageWindow(40, 40)).toEqual([1, 'gap', 39, 40]);
  });

  test('never repeats a page number', () => {
    const window = pageWindow(2, 40);
    const numbers = window.filter((item): item is number => item !== 'gap');
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe('the pools load in batches, and only probe what is on screen', () => {
  test('page size choices start at a screenful', () => {
    expect(PAGE_SIZE_OPTIONS).toEqual([20, 50, 100]);
    expect(DEFAULT_PAGE_SIZE).toBe(20);
  });

  test('the supply ledger renders a window and probes only what it shows', () => {
    // 台账不再整页铺开：表格自己滚，一次只加载一批，屏外的行不进 DOM。
    const card = source('features/sms/SupplyPoolCard.tsx');
    expect(card).toContain('useRowWindow(entries.length)');
    expect(card).toContain('rows.topPad');
    expect(card).toContain('rows.bottomPad');
    expect(card).toContain('onBodyScroll={rows.onScroll}');
    expect(card).toContain('<PoolLoadMore');
    expect(card).not.toContain('<Pagination');
    // 探活取的是看得见的那几条，不是整本台账。
    expect(card).toContain('for (const entry of visible)');
    expect(card).toContain('}, [loaded, visible, resolveChannel, kinds]);');
  });

  test('the channel table renders a window and probes only what it shows', () => {
    const table = source('features/sms/SupplyPoolTable.tsx');
    expect(table).toContain('useRowWindow(channels.length)');
    expect(table).toContain('rows.topPad');
    expect(table).toContain('void probe(pending)');
    expect(table).toContain('useChannelStatus(kind, channels, reloadKey)');
    expect(table).not.toContain('<Pagination');
  });

  test('the egress pool renders the current page only', () => {
    const egress = source('features/config/components/blocks/EgressPoolCard.tsx');
    expect(egress).toContain('usePagination(entries)');
    expect(egress).toContain('paged.items.map');
  });

  test('the account pool keeps one pager, not two', () => {
    const page = source('features/authFiles/AuthFilesPage.tsx');
    expect(page).toContain('<Pagination');
    expect(page).not.toContain("t('auth_files.pagination_prev')");
  });
});
