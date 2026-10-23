/**
 * 一张长表的当前页。
 *
 * 分页只解决一件事：**这一屏要显示哪些行**。它不改后端接口 —— 列表本来就是一次
 * 全量回来的，条目再多也只是一次 JSON；真正贵的是「为每一行发一次请求」（探活、
 * 读信箱、测出口），所以分页之后那些动作只对当前页做。
 *
 * 页码在条目变少时会被夹回最后一页：删掉最后一页的唯一一条之后停在一个不存在的
 * 页码上，会显示一张空表，而空表看起来就像「全都没了」。
 */

import { useCallback, useMemo, useState } from 'react';

/** 一页多少条。20 是一屏的舒适上限，再往上就要滚很久才看到底。 */
export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

export const DEFAULT_PAGE_SIZE = PAGE_SIZE_OPTIONS[0];

/** 页码窗口最多露几个数字；再多就该用省略号了。 */
const MAX_PAGE_BUTTONS = 7;

export interface PageSlice {
  /** 已夹在 [1, totalPages] 内的当前页。 */
  page: number;
  totalPages: number;
  /** 这一页第一条在全集里的下标（0 起算）。 */
  start: number;
  /** 这一页覆盖第几条到第几条（1 起算）；空表时都是 0。 */
  from: number;
  to: number;
}

/**
 * 条目数与页码 → 这一页的边界。
 *
 * 抽成纯函数是因为它有三个容易写错的地方（页数下限是 1、页码要夹回来、空表的
 * 「第 0 到 0 条」），而这些错都不会在界面上报错，只会显示一张空表。
 */
export function resolvePageSlice(rawPage: number, total: number, pageSize: number): PageSlice {
  const size = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(total / size));
  const wanted = Number.isFinite(rawPage) ? Math.floor(rawPage) : 1;
  const page = Math.min(Math.max(1, wanted), totalPages);
  const start = (page - 1) * size;
  return {
    page,
    totalPages,
    start,
    from: total === 0 ? 0 : start + 1,
    to: Math.min(start + size, total),
  };
}

/**
 * 页码窗口：首页、末页、当前页及其左右各一页，中间跳过的用 `'gap'` 代替。
 *
 * 上千条时有几十页，全铺开会把一行撑到换行，反而找不到当前页。
 */
export function pageWindow(page: number, totalPages: number): (number | 'gap')[] {
  if (totalPages <= MAX_PAGE_BUTTONS) {
    return Array.from({ length: Math.max(1, totalPages) }, (_, index) => index + 1);
  }
  const wanted = Array.from(
    new Set(
      [1, totalPages, page - 1, page, page + 1].filter((item) => item >= 1 && item <= totalPages)
    )
  ).sort((left, right) => left - right);
  const result: (number | 'gap')[] = [];
  let previous = 0;
  for (const item of wanted) {
    if (previous !== 0 && item - previous > 1) result.push('gap');
    result.push(item);
    previous = item;
  }
  return result;
}

export interface PagedList<T> extends PageSlice {
  pageSize: number;
  /** 全部条目数（不是这一页的条数）。 */
  total: number;
  /** 这一页要渲染的条目。 */
  items: T[];
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
}

export function usePagination<T>(
  items: T[],
  initialPageSize: number = DEFAULT_PAGE_SIZE
): PagedList<T> {
  const [rawPage, setRawPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(initialPageSize);

  const total = items.length;
  const slice = resolvePageSlice(rawPage, total, pageSize);
  const pageItems = useMemo(
    () => items.slice(slice.start, slice.start + pageSize),
    [items, slice.start, pageSize]
  );

  const setPage = useCallback(
    (next: number) => setRawPage(Math.min(Math.max(1, next), slice.totalPages)),
    [slice.totalPages]
  );

  // 换每页条数就回到第一页：停在原来的页码上，人看到的是完全不同的一段，
  // 而页码还写着同一个数字，会以为列表跳了。
  const setPageSize = useCallback((next: number) => {
    setPageSizeState(next);
    setRawPage(1);
  }, []);

  return {
    ...slice,
    pageSize,
    total,
    items: pageItems,
    setPage,
    setPageSize,
  };
}
