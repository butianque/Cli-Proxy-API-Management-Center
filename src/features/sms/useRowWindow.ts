/**
 * 长表的「分批加载 + 只渲染看得见的那几行」。
 *
 * 供应池上千条时，一屏之外的行有两个代价：DOM 节点（每条身份两行，还带一条状态带），
 * 以及页面长度 —— 整页跟着长，页头的「收件箱」「导入邮箱」和底部的翻页条全被推到视野外，
 * 复制一个地址就要来回滚两趟。
 *
 * 这里只做两件事：
 *
 * 1. **分批加载**：先给 10 条，滚到底再要下一批。没加载的条目根本不进 React。
 * 2. **窗口渲染**：已加载的条目也只渲染可视范围上下各一屏（`OVERSCAN`）之内的，
 *    其余用一个空行撑住高度 —— 滚动条长度不变，DOM 里始终只有几十条。
 *
 * 行高不是常数：每条身份下面挂着一条状态带，展开与收起都会改高度。所以高度是
 * **量出来的**：渲染后量一次，之后交给 `ResizeObserver`。没量到过的条目按已量到的
 * 中位数估一个，等它进了视口再修正 —— 估值只影响滚动条长度，不影响看到的内容。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/** 一次加载多少条：一屏放得下的量，滚到底再要下一批。 */
export const ROW_BATCH = 10;

/** 可视区上下各多渲染多少像素。留一屏，滚动时不至于看见空白。 */
const OVERSCAN = 480;

/** 一条都还没量到时的估计高度：一条身份行加一条状态带。 */
const FALLBACK_ROW_HEIGHT = 96;

/** 内容比容器矮多少像素以内就再要一批：滚动条还没出来，滚到底就无从谈起。 */
const FILL_SLACK = 8;

/** 离底还差多少像素就追加下一批。留一屏，滚到底时下一批已经在渲染了。 */
const END_GAP = 240;

/**
 * 滚到快底了没有。
 *
 * 有滚动条才有「滚到底」；内容还没填满一屏时这里一律返回 false —— 那种情况由
 * 「填满一屏」那条路负责，两边都管会让同一次挂载连要两批。
 */
export function reachesEnd(
  scrollTop: number,
  viewport: number,
  contentHeight: number,
  gap: number = END_GAP
): boolean {
  if (contentHeight <= viewport) return false;
  return scrollTop + viewport >= contentHeight - gap;
}

export interface RowWindowSlice {
  /** 要渲染的区间 `[start, end)`。 */
  start: number;
  end: number;
  /** 区间上下各要留多高的占位。 */
  topPad: number;
  bottomPad: number;
}

/**
 * 滚动位置 → 该渲染哪一段。
 *
 * `offsets` 是前缀和：`offsets[i]` 是第 i 条的上沿，`offsets[count]` 是总高度。
 * 抽成纯函数是因为「上下各留多少占位」一旦算错，表现是滚动条长度忽长忽短、滚到底
 * 看见一片空白，而界面上不会报任何错。
 */
export function resolveRowWindow(
  scrollTop: number,
  viewport: number,
  offsets: readonly number[],
  overscan: number = OVERSCAN
): RowWindowSlice {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0, topPad: 0, bottomPad: 0 };
  const top = Math.max(0, scrollTop - overscan);
  const bottom = scrollTop + Math.max(0, viewport) + overscan;
  const start = Math.min(count - 1, Math.max(0, upperBound(offsets, top) - 1));
  const end = Math.min(count, Math.max(start + 1, upperBound(offsets, bottom)));
  return {
    start,
    end,
    // 顶到两端时不留占位：占位是估出来的，留着它反而会在滚到边界时跳一下。
    topPad: start === 0 ? 0 : offsets[start],
    bottomPad: end >= count ? 0 : offsets[count] - offsets[end],
  };
}

/** 最小的 i（`offsets` 的下标），使 `offsets[i] > value`。 */
function upperBound(offsets: readonly number[], value: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

export interface RowWindow extends RowWindowSlice {
  /** 已加载的条数（从 0 数起的前 N 条）。 */
  loaded: number;
  total: number;
  hasMore: boolean;
  /** 挂到表格的滚动容器上。 */
  containerRef: (node: HTMLDivElement | null) => void;
  onScroll: () => void;
  loadMore: () => void;
}

/**
 * 行上要挂的属性：告诉 `useRowWindow` 这一行是第几条。
 *
 * 行高是量出来的，而「量哪一行」必须有个标记 —— 用 `data-row-index` 而不是 ref
 * 回调，是因为 ref 回调要稳定就得缓存，缓存一旦落在渲染期就会碰 lint 与并发渲染的
 * 红线（见下面量行高那段）。
 */
export function rowIndexProps(index: number): { 'data-row-index': number } {
  return { 'data-row-index': index };
}

export function useRowWindow(total: number): RowWindow {
  const [rawLoaded, setRawLoaded] = useState(ROW_BATCH);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  // 量到的高度。键是条目下标；条目被移出窗口后仍然留着，滚回来不用重量。
  //
  // 它是 state 而不是 ref：占位高度要在渲染期算，而渲染期读 ref 会让「高度变了」
  // 这件事绕开 React 的更新 —— 量到新高度后不重算占位，滚动条长度就停在估值上。
  const [heights, setHeights] = useState<ReadonlyMap<number, number>>(() => new Map());
  const observersRef = useRef(new Map<number, ResizeObserver>());
  const frameRef = useRef(0);

  const loaded = Math.min(rawLoaded, total);

  // 条目变少（删了一条、换了类别）时回到第一批：留着一个比总数还大的「已加载」
  // 没有意义，而下一次读回来的更多条目会一次性铺开。
  useEffect(() => {
    setRawLoaded((value) => (value > total ? ROW_BATCH : value));
  }, [total]);

  const estimate = useMemo(() => {
    const values = Array.from(heights.values()).sort((left, right) => left - right);
    if (values.length === 0) return FALLBACK_ROW_HEIGHT;
    return values[Math.floor(values.length / 2)];
  }, [heights]);

  const offsets = useMemo(() => {
    const next = new Array<number>(loaded + 1);
    next[0] = 0;
    for (let index = 0; index < loaded; index += 1) {
      next[index + 1] = next[index] + (heights.get(index) ?? estimate);
    }
    return next;
  }, [loaded, heights, estimate]);

  const slice = useMemo(
    () => resolveRowWindow(scrollTop, viewport, offsets),
    [scrollTop, viewport, offsets]
  );

  useLayoutEffect(() => {
    if (!container) return;
    const sync = () => {
      setViewport(container.clientHeight);
      setScrollTop(container.scrollTop);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);

  const loadMore = useCallback(() => {
    setRawLoaded((value) => Math.min(value + ROW_BATCH, total));
  }, [total]);

  const hasMore = loaded < total;

  const onScroll = useCallback(() => {
    if (frameRef.current !== 0) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      if (!container) return;
      setScrollTop(container.scrollTop);
      setViewport(container.clientHeight);
      // 滚到还差一屏时就追加下一批：等到真的贴底才要，用户会先看见一片空白。
      if (reachesEnd(container.scrollTop, container.clientHeight, container.scrollHeight)) {
        loadMore();
      }
    });
  }, [container, loadMore]);

  useEffect(
    () => () => {
      if (frameRef.current !== 0) window.cancelAnimationFrame(frameRef.current);
    },
    []
  );

  useEffect(
    () => () => {
      for (const observer of observersRef.current.values()) observer.disconnect();
      observersRef.current.clear();
    },
    []
  );

  // 一屏还没填满：没有滚动条就没有「滚到底」，再等也等不来下一批。
  // 每批都是真实行高，所以这个循环一定会在一屏被填满时停下来。
  useEffect(() => {
    if (!container || !hasMore) return;
    if (container.scrollHeight > container.clientHeight + FILL_SLACK) return;
    loadMore();
  }, [container, hasMore, loaded, offsets, loadMore]);

  /** 记一条的行高。只在高度的确变了的时候换新表，免得 ResizeObserver 抖动时白渲染。 */
  const measure = useCallback((index: number, node: HTMLElement) => {
    const height = node.getBoundingClientRect().height;
    setHeights((current) => {
      const previous = current.get(index);
      if (previous !== undefined && Math.abs(previous - height) < 0.5) return current;
      const next = new Map(current);
      next.set(index, height);
      return next;
    });
  }, []);

  /**
   * 量行高：每渲染一次就看看这一屏的行有没有还没量过的。
   *
   * 走「容器里按 `data-row-index` 找行」而不是给每行挂一个 ref 回调 —— 回调要稳定，
   * 就得在下标上缓存函数；而每次渲染换一个新函数，React 会先把旧的按 `null` 解绑、
   * 再把新的接上，于是每渲染一次就断一次 `ResizeObserver`、重量一次高度，正好制造出
   * 一串假的「高度变了」。
   *
   * 已经量过的行不重量：之后的高度变化由 `ResizeObserver` 通知（窗口变窄把状态带
   * 折成两行，也走这条路）。行离开窗口时断开，回来再量一次。
   */
  useLayoutEffect(() => {
    if (!container) return;
    const observers = observersRef.current;
    const seen = new Set<number>();
    for (const node of container.querySelectorAll<HTMLElement>('[data-row-index]')) {
      const index = Number(node.dataset.rowIndex);
      if (!Number.isInteger(index)) continue;
      seen.add(index);
      if (observers.has(index)) continue;
      measure(index, node);
      const observer = new ResizeObserver(() => measure(index, node));
      observer.observe(node);
      observers.set(index, observer);
    }
    for (const [index, observer] of observers) {
      if (seen.has(index)) continue;
      observer.disconnect();
      observers.delete(index);
    }
  });

  const containerRef = useCallback((node: HTMLDivElement | null) => setContainer(node), []);

  return {
    ...slice,
    loaded,
    total,
    hasMore,
    containerRef,
    onScroll,
    loadMore,
  };
}
