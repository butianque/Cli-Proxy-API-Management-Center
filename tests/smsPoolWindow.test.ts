import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ROW_BATCH, reachesEnd, resolveRowWindow } from '../src/features/sms/useRowWindow';

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

/** 100 条等高（100px）的前缀和：`offsets[i]` 是第 i 条的上沿。 */
const even = Array.from({ length: 101 }, (_, index) => index * 100);

describe('a long list loads in batches instead of growing the page', () => {
  test('one batch is a screenful', () => {
    expect(ROW_BATCH).toBe(10);
  });
});

describe('scrolling to the end asks for the next batch', () => {
  test('the next batch is asked for a screen before the very bottom', () => {
    // 视口 400、内容 1000：滚到 500 时还差 100，落在提前量里，就该追加了。
    expect(reachesEnd(500, 400, 1000, 240)).toBe(true);
    // 滚到 300 时还差 300，再滚一会儿才到。
    expect(reachesEnd(300, 400, 1000, 240)).toBe(false);
  });

  test('being at the very bottom always counts', () => {
    expect(reachesEnd(600, 400, 1000)).toBe(true);
  });

  test('content that still fits in the viewport is not a scroll position', () => {
    // 没有滚动条就没有「滚到底」：这一段由「填满一屏」负责，否则挂载时要两批。
    expect(reachesEnd(0, 400, 380)).toBe(false);
  });

  test('the ledger and the channel table both feed their scroll position to it', () => {
    for (const path of ['features/sms/SupplyPoolCard.tsx', 'features/sms/SupplyPoolTable.tsx']) {
      expect(read(path)).toContain('onBodyScroll={rows.onScroll}');
    }
    expect(read('features/sms/useRowWindow.ts')).toContain(
      'reachesEnd(container.scrollTop, container.clientHeight, container.scrollHeight)'
    );
  });
});

describe('only the rows around the viewport are rendered', () => {
  test('at the top there is nothing above to hold open', () => {
    expect(resolveRowWindow(0, 400, even, 0)).toEqual({
      start: 0,
      end: 5,
      topPad: 0,
      bottomPad: 9500,
    });
  });

  test('in the middle both sides hold open the rows they are not rendering', () => {
    // 滚到第 10 条（上沿 1000px），视口 400px：渲染 10..14，上面留 1000，下面留 8500。
    expect(resolveRowWindow(1000, 400, even, 0)).toEqual({
      start: 10,
      end: 15,
      topPad: 1000,
      bottomPad: 8500,
    });
  });

  test('at the bottom there is nothing below to hold open', () => {
    const slice = resolveRowWindow(9600, 400, even, 0);
    expect(slice.start).toBe(96);
    expect(slice.end).toBe(100);
    expect(slice.bottomPad).toBe(0);
    expect(slice.topPad).toBe(9600);
  });

  test('the overscan renders a screenful beyond each edge, so scrolling shows no gap', () => {
    // 默认多渲染 480px：视口 400 + 480 = 880，所以渲染 0..8（9 条）。
    expect(resolveRowWindow(0, 400, even).end).toBe(9);
    // 上下各一屏：滚到 1000 时，上面从 520 起，下面到 1880 止。
    expect(resolveRowWindow(1000, 400, even)).toEqual({
      start: 5,
      end: 19,
      topPad: 500,
      bottomPad: 8100,
    });
  });

  test('an unmeasured row is taken at whatever height it reports', () => {
    // 第 2 条是展开过状态带的，300px 高：窗口按真实高度切，不按平均高度切。
    const offsets = [0, 50, 100, 400, 450];
    expect(resolveRowWindow(150, 100, offsets, 0)).toEqual({
      start: 2,
      end: 3,
      topPad: 100,
      bottomPad: 50,
    });
  });

  test('an empty list renders nothing and holds nothing open', () => {
    expect(resolveRowWindow(0, 400, [0])).toEqual({ start: 0, end: 0, topPad: 0, bottomPad: 0 });
  });

  test('a container that has not been measured yet still renders one row to measure', () => {
    // 第一次渲染时容器高度还是 0；一条都不渲染就永远量不到高度。
    expect(resolveRowWindow(0, 0, even, 0)).toEqual({
      start: 0,
      end: 1,
      topPad: 0,
      bottomPad: 9900,
    });
  });
});

describe('the pools own their scrolling, so the page header stays put', () => {
  test('both tables scroll inside a bounded box with a pinned header', () => {
    const card = read('features/sms/SupplyPoolCard.tsx');
    const table = read('features/sms/SupplyPoolTable.tsx');
    for (const source of [card, table]) {
      expect(source).toContain('maxHeight="var(--sms-pool-max-height)"');
      expect(source).toContain('scrollRef={rows.containerRef}');
      expect(source).toContain('TableSpacer');
    }
    const styles = read('features/sms/SmsServicePage.module.scss');
    expect(styles).toContain('--sms-pool-max-height');
    // 表头必须自己带底色，否则滚过去的行会从它下面透出来。
    const tableStyles = read('components/ui/Table/Table.module.scss');
    expect(tableStyles).toContain('position: sticky');
  });

  test('the footer says how much is shown and offers the next batch', () => {
    const footer = read('features/sms/PoolLoadMore.tsx');
    expect(footer).toContain("t('sms_service.pool_shown'");
    expect(footer).toContain("t('sms_service.pool_load_more'");
    expect(footer).toContain("t('sms_service.pool_all_shown'");
    // 全部显示完之后不再留一个按下去什么都不会变的按钮。
    expect(footer).toContain('hasMore ?');
  });

  test('every locale can say it', async () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'ko', 'vi']) {
      const messages = await Bun.file(`src/i18n/locales/${locale}.json`).json();
      for (const key of ['pool_shown', 'pool_load_more', 'pool_all_shown']) {
        expect(messages.sms_service[key]).toBeString();
        expect(messages.sms_service[key].trim()).not.toBe('');
      }
    }
  });
});
