import { readFileSync } from 'node:fs';
import { describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { apiClient } from '../src/services/api/client';
import { supplyApi } from '../src/services/api/supply';
import {
  EntryStatus,
  EntryStatusFact,
  EntryStatusFacts,
  EntryStatusGroup,
} from '../src/features/sms/EntryStatus';
import { latestPoolActivity } from '../src/features/sms/smsMapping';
import type { PoolEntry, PoolRegistration } from '../src/features/sms/types';

/**
 * The block under a ledger row answers two questions: has this identity registered
 * anything, and when did the record last change. Both come from real backend fields,
 * so both are checked here as behaviour rather than as layout.
 */

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

const entry = (patch: Partial<PoolEntry> = {}): PoolEntry => ({
  kind: 'email',
  identity: 'box@example.com',
  channelId: '',
  source: '',
  sourceDetail: '',
  account: '',
  platform: '',
  state: 'pending',
  lastUsedAt: null,
  projects: [],
  mailbox: null,
  ...patch,
});

const registration = (registeredAt: string | null): PoolRegistration => ({
  target: 'loomy',
  account: 'loomy-1',
  state: 'registered',
  registeredAt,
});

describe('the last time a ledger record changed', () => {
  test('a record nobody touched has no update time at all', () => {
    // A freshly imported address was never used and never registered anywhere.
    // Inventing "now" would claim it had been updated.
    expect(latestPoolActivity(entry())).toBeNull();
  });

  test('the later of "last used" and "last registered" wins', () => {
    const used = latestPoolActivity(
      entry({
        lastUsedAt: '2026-10-20T08:00:00.000Z',
        projects: [registration('2026-10-18T08:00:00.000Z')],
      })
    );
    expect(used).toBe('2026-10-20T08:00:00.000Z');

    const registered = latestPoolActivity(
      entry({
        lastUsedAt: '2026-10-18T08:00:00.000Z',
        projects: [registration('2026-10-21T08:00:00.000Z')],
      })
    );
    expect(registered).toBe('2026-10-21T08:00:00.000Z');
  });

  test('several registrations compare by instant, not by list order', () => {
    const latest = latestPoolActivity(
      entry({
        projects: [
          registration('2026-10-21T08:00:00.000Z'),
          registration('2026-10-19T08:00:00.000Z'),
        ],
      })
    );
    expect(latest).toBe('2026-10-21T08:00:00.000Z');
  });

  test('a timestamp the backend did not record does not count as one', () => {
    // `null` means "not recorded". Reading it as epoch zero would print 1970.
    expect(latestPoolActivity(entry({ projects: [registration(null)] }))).toBeNull();
    expect(latestPoolActivity(entry({ lastUsedAt: 'not a date' }))).toBeNull();
  });
});

describe('the status block renders a label with every value', () => {
  test('a value never appears without the word that makes it mean something', () => {
    const markup = renderToStaticMarkup(
      createElement(
        EntryStatus,
        null,
        createElement(
          EntryStatusFacts,
          null,
          createElement(EntryStatusFact, { label: '注册情况' }, '未注册任何平台'),
          createElement(EntryStatusFact, { label: '更新时间' }, '2026/10/23 02:41')
        )
      )
    );
    expect(markup).toContain('注册情况');
    expect(markup).toContain('未注册任何平台');
    expect(markup).toContain('更新时间');
    expect(markup).toContain('2026/10/23 02:41');
  });

  test('a group is separated by a divider and can carry its own heading', () => {
    const markup = renderToStaticMarkup(
      createElement(
        EntryStatus,
        null,
        createElement(EntryStatusGroup, { label: '注册记录' }, 'loomy · 已注册')
      )
    );
    expect(markup).toContain('注册记录');
    expect(markup).toContain('loomy · 已注册');
  });
});

describe('the ledger row uses the block, not a bare sentence', () => {
  const card = read('features/sms/SupplyPoolCard.tsx');

  test('the update time comes from the record, through the mapping module', () => {
    expect(card).toContain('latestPoolActivity');
    expect(card).toContain('ledger_fact_updated');
    // The wire field stays in the mapping module.
    expect(card).not.toContain('last_used');
  });

  test('registrations are listed under a divider instead of strung with dots', () => {
    expect(card).toContain('<EntryStatusGroup>');
    expect(card).toContain('ledger_fact_registrations');
    expect(card).toContain('ledger_registered_count');
  });

  test('the account a registration produced is a hover title, not a column', () => {
    // 一串 UUID 铺在行里，比「成没成」还长还亮，读的人第一眼看到的是 ID。它只在
    // 「这条注册产出了哪份凭证」时才用得上，所以挂在结果本身的悬浮提示上。
    expect(card).toContain('title={accountTitle');
    // 也不作为任何元素的文本子节点出现（`key` 里那份是 React 的标识，不上屏）。
    expect(card).not.toContain('>{project.account}<');
  });

  test('a registration that produced an account leads to that credential', () => {
    // 有账号就意味着台账能指到那张凭证，而想看「注册出来的是哪个号」的人下一步
    // 一定是去看它，所以状态本身就是入口。
    expect(card).toContain('/auth-files?focus=');
    expect(card).toContain('encodeURIComponent(accountTitle)');
    expect(card).toContain('ledger_open_credential');
    // 没有账号的注册不给假入口：那个分支必须还是纯文本。
    expect(card).toContain("{accountTitle === '' ? (");
  });
});

/**
 * 台账点到凭证页那一下必须真的落到那一张卡上。后端不参与：`project.account` 就是
 * 凭证文件名去掉 `.json`，所以凭证页按文件名匹配就够，不需要再加一个字段。
 */
describe('the ledger lands on the credential it points at', () => {
  const page = readFileSync(
    new URL('../src/features/authFiles/AuthFilesPage.tsx', import.meta.url),
    'utf8'
  );

  test('reads the target from the URL and clears the filters that could hide it', () => {
    expect(page).toContain("searchParams.get('focus')");
    // 不清筛选的话，用户在凭证页留下的过滤会把刚点的那条藏起来。
    expect(page).toContain("setFilter('all')");
    expect(page).toContain("setStatusFilterMode('all')");
    expect(page).toContain("setSearch('')");
  });

  test('turns the target into the page that actually holds it', () => {
    expect(page).toContain('stripJsonExtension');
    expect(page).toContain('setPage(Math.floor(index / pageSize) + 1)');
    // 找不到就不动：不摆空壳，也不假装跳成功。
    expect(page).toContain('if (index < 0) return;');
  });

  test('focus is one-shot, so a refresh does not reset the view again', () => {
    expect(page).toContain('setSearchParams({}, { replace: true })');
    expect(page).toContain("setFocusedName('')");
  });
});

/**
 * 一个条目是两行（主数据 + 状态带），但它是**一个**条目：悬停要整条一起变暗，
 * 否则下半截看起来不属于上面那一行。两行放在同一个 `<tbody>` 里才做得到 ——
 * 分成两个 `<tbody>` 或只用一个外层 `<tbody>` 都会退回「只有一半亮」。
 */
describe('a two-row entry hovers as one entry', () => {
  for (const path of ['features/sms/SupplyPoolCard.tsx', 'features/sms/SupplyPoolTable.tsx']) {
    const source = read(path);

    test(`${path} groups the lead row and its status strip`, () => {
      expect(source).toContain('<TableRowGroup key=');
      // 两行在同一个组里：`stripLead` 与 `stripRow` 之间没有闭合标签。
      expect(source).toMatch(
        /<TableRowGroup key=\{[^}]+\}>\s*<TableRow className=\{styles\.stripLead\}/
      );
      expect(source).toMatch(/<\/TableRow>\s*<TableRow className=\{styles\.stripRow\}>/);
      // 组已经取代了原先的单个 tbody：再套一层就是两行各归各的。
      expect(source).not.toContain('<TableBody>');
    });
  }
});

/**
 * 台账行上的移除：删的是这一行对应的那个身份。
 *
 * 表头多一列、状态带多跨一列，两处必须一起变 —— 少一处，状态带会缩到表格外面，
 * 或者最右边留下一个没有表头的空列。
 */
describe('a ledger row can be removed', () => {
  const card = read('features/sms/SupplyPoolCard.tsx');
  // 移除那一整段回调：它的边界就是「先问、再删、删成了重读」这三件事。
  const handler = card.slice(
    card.indexOf('const remove = useCallback'),
    card.indexOf('/** 只有真的溢出两行才记下')
  );

  test('the header names the remove column, to the right of the expand column', () => {
    const header = card.slice(card.indexOf('<TableHeader>'), card.indexOf('</TableHeader>'));
    expect(header).toContain('ledger_col_remove');
    // 动作列都在右侧：展开在前，移除在后，状态列不被它们挤走。
    expect(header.indexOf('ledger_expand')).toBeLessThan(header.indexOf('ledger_col_remove'));
  });

  test('the status strip spans every column, the new one included', () => {
    expect(card).toContain('colSpan={8}');
    expect(card).not.toContain('colSpan={7}');
  });

  test('the button is the same pill the channel table already uses', () => {
    expect(card).toContain('styles.actionPill');
    expect(card).toContain('<IconTrash2 size={14} />');
    expect(card).toContain('ledger_remove_aria');
  });

  test('it asks before deleting and re-reads the pool afterwards', () => {
    expect(card).toContain('showConfirmation({');
    expect(card).toContain("variant: 'danger'");
    expect(card).toContain('supplyApi.removePoolAccount');
    // 删成了重新读一遍，而不是在本地把行抹掉：后端才是事实。
    expect(handler).toContain('await load();');
    expect(handler).not.toContain('setEntries');
  });

  test('a failed removal is reported and the row stays', () => {
    expect(handler).toContain('showNotification(result.message,');
    // 失败分支没有本地删除：行留在原处，等操作者再决定。
    expect(handler.slice(handler.indexOf('if (!result.ok)'))).not.toContain('setEntries');
  });

  test('every locale carries the remove copy', () => {
    const keys = [
      'ledger_col_remove',
      'ledger_remove_aria',
      'ledger_remove_confirm_title',
      'ledger_remove_confirm',
    ];
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko']) {
      const file = JSON.parse(read(`i18n/locales/${locale}.json`)) as {
        sms_service?: Record<string, string>;
      };
      for (const key of keys) {
        expect(file.sms_service?.[key]).toBeTruthy();
      }
    }
  });
});

/**
 * 移除请求把身份写在 URL 里，所以两段都必须整段编码：`+` 在查询串里是空格，
 * 不编码就等于让服务端去删一个不存在的地址。
 */
describe('the remove call names the identity in the URL', () => {
  test('kind and address are encoded on the pool accounts route', async () => {
    const urls: string[] = [];
    const spy = spyOn(apiClient, 'delete').mockImplementation(async (url: string) => {
      urls.push(url);
      return { status: 'ok' } as never;
    });
    try {
      const result = await supplyApi.removePoolAccount('email', 'box+tag@example.com');
      expect(result).toEqual({ ok: true });
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain('/supply/pool/accounts?kind=');
      expect(urls[0]).toContain('&address=');
      expect(urls[0]).toContain('address=box%2Btag%40example.com');
      expect(urls[0]).not.toContain('box+tag@example.com');
    } finally {
      spy.mockRestore();
    }
  });

  test('an unknown identity reports the backend reason instead of pretending it worked', async () => {
    const spy = spyOn(apiClient, 'delete').mockImplementation(async () => {
      throw { data: { status: 'error', error: 'no such identity', code: 'unknown_identity' } };
    });
    try {
      expect(await supplyApi.removePoolAccount('phone', '15500000000')).toEqual({
        ok: false,
        message: 'no such identity',
      });
    } finally {
      spy.mockRestore();
    }
  });
});
