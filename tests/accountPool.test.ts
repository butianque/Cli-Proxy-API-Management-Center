import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import { AuthFilePoolSection } from '../src/features/authFiles/components/AuthFilePoolSection';
import {
  ACCOUNT_POLICY_AUTO,
  accountPolicyChannelKey,
  accountPolicyOnly,
  buildAccountIndex,
  remainingMinutes,
  resolveResetInstant,
  routingPolicyOptions,
  sharedResetAt,
  sharedWindow,
} from '../src/features/authFiles/accountPool';
import { normalizeAccountView } from '../src/services/api/accounts';
import type { AccountQuotaBucket, AccountView } from '../src/types/accounts';
import type { AuthFileItem } from '../src/types';
import { getQuotaCacheKey } from '../src/utils/quota/identity';

const poolSource = readFileSync(
  new URL('../src/features/authFiles/components/AuthFilePoolSection.tsx', import.meta.url),
  'utf8'
);

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

/** 该凭证实际携带的两条渠道，来自宿主契约里的 `channels`。 */
const channels = [
  { key: 'start-plan', label: 'ZCode Start Plan' },
  { key: 'api-key', label: 'API Key' },
] as const;

describe('sharedResetAt', () => {
  const bucket = (resetAt?: string): AccountQuotaBucket => ({
    group: 'ZCode Start Plan',
    model: 'GLM-5.3',
    remainingFraction: 1,
    resetAt,
  });

  test('reports the single instant every model in the group shares', () => {
    expect(
      sharedResetAt([bucket('2026-10-17T15:59:00Z'), bucket('2026-10-17T15:59:00Z')])
    ).toBe('2026-10-17T15:59:00Z');
  });

  test('compares after trimming, so stray padding cannot split one instant in two', () => {
    expect(
      sharedResetAt([bucket(' 2026-10-17T15:59:00Z '), bucket('2026-10-17T15:59:00Z')])
    ).toBe('2026-10-17T15:59:00Z');
  });

  test('reports the instant when only some models carry it', () => {
    // 套餐的到期时间经其中一个模型下发也是这份套餐的期限，不该因此降级成逐行。
    expect(sharedResetAt([bucket('2026-10-17T15:59:00Z'), bucket()])).toBe(
      '2026-10-17T15:59:00Z'
    );
  });

  test('returns null when the models carry different instants', () => {
    // 各模型期限不同时组头的一个值代表不了全部，交给逐行显示。
    expect(
      sharedResetAt([bucket('2026-10-17T15:59:00Z'), bucket('2026-10-18T15:59:00Z')])
    ).toBeNull();
  });

  test('returns null when no model reports an instant', () => {
    expect(sharedResetAt([bucket(), bucket(''), bucket('  ')])).toBeNull();
  });
});

describe('sharedWindow', () => {
  const bucket = (window?: string): AccountQuotaBucket => ({
    group: 'ZCode Start Plan',
    model: 'GLM-5.3',
    remainingFraction: 1,
    window,
  });

  test('reports the single window every model in the plan shares', () => {
    expect(sharedWindow([bucket('daily'), bucket('daily')])).toBe('daily');
  });

  test('ignores models that report no window', () => {
    expect(sharedWindow([bucket('daily'), bucket()])).toBe('daily');
  });

  test('returns null when the models disagree, so the header stays neutral', () => {
    expect(sharedWindow([bucket('daily'), bucket('weekly')])).toBeNull();
  });

  test('returns null when no model reports a window', () => {
    expect(sharedWindow([bucket(), bucket('  ')])).toBeNull();
  });
});

describe('resolveResetInstant', () => {  const NOW = Date.parse('2026-10-17T16:00:00Z');

  test('passes a future instant through untouched', () => {
    const at = Date.parse('2026-10-18T00:00:00Z');
    expect(resolveResetInstant('2026-10-18T00:00:00Z', 'daily', NOW)).toBe(at);
    expect(resolveResetInstant('2026-10-18T00:00:00Z', 'monthly', NOW)).toBe(at);
  });

  test('rolls a stale daily boundary forward to the next occurrence', () => {
    // 快照停在 10-17 的日切上，面板已跨过它 ⇒ 「下一次」必须落在未来，否则是句自相矛盾的话。
    // 往前滚得到的值与重新探测一次完全一致：日窗口就是「同一钟点、每 24 小时一次」。
    expect(resolveResetInstant('2026-10-17T00:00:00Z', 'daily', NOW)).toBe(
      Date.parse('2026-10-18T00:00:00Z')
    );
    // 落后好几天时滚到最近的一次，而不是只加一天。
    expect(resolveResetInstant('2026-10-10T00:00:00Z', 'daily', NOW)).toBe(
      Date.parse('2026-10-18T00:00:00Z')
    );
  });

  test('never rolls a boundary that is not daily', () => {
    // 周/月/一次性窗口过期就是真的过期；滚一下会把「已到期」说成「还没到期」。
    const stale = '2026-10-17T00:00:00Z';
    expect(resolveResetInstant(stale, 'monthly', NOW)).toBe(Date.parse(stale));
    expect(resolveResetInstant(stale, undefined, NOW)).toBe(Date.parse(stale));
    expect(resolveResetInstant(stale, '', NOW)).toBe(Date.parse(stale));
  });

  test('reports nothing when the instant cannot be read', () => {
    expect(resolveResetInstant(undefined, 'daily', NOW)).toBeNull();
    expect(resolveResetInstant(null, 'daily', NOW)).toBeNull();
    expect(resolveResetInstant('', 'daily', NOW)).toBeNull();
    expect(resolveResetInstant('not a date', 'daily', NOW)).toBeNull();
  });
});

describe('remainingMinutes', () => {
  const NOW = Date.parse('2026-10-17T16:00:00Z');

  test('counts the minutes until the instant', () => {
    expect(remainingMinutes(Date.parse('2026-10-18T00:00:00Z'), NOW)).toBe(480);
  });

  test('rounds up, so a partly elapsed minute still counts as one', () => {
    // 剩 30 秒时显示「剩余 1 分钟」而不是 0 —— 宁可少说，不能多说。
    expect(remainingMinutes(Date.parse('2026-10-17T16:00:30Z'), NOW)).toBe(1);
    expect(remainingMinutes(Date.parse('2026-10-17T16:00:01Z'), NOW)).toBe(1);
  });

  test('says nothing once the instant has passed', () => {
    // 「剩余 -3 分钟」不是一句人话，交回给调用方只报时刻。
    expect(remainingMinutes(Date.parse('2026-10-17T15:57:00Z'), NOW)).toBeNull();
    expect(remainingMinutes(Date.parse('2026-10-17T16:00:00Z'), NOW)).toBeNull();
  });

  test('says nothing when there is no instant', () => {
    expect(remainingMinutes(null, NOW)).toBeNull();
    expect(remainingMinutes(Number.NaN, NOW)).toBeNull();
  });
});

describe('routingPolicyOptions', () => {
  test('always starts with the default option', () => {
    expect(routingPolicyOptions(channels)[0]).toEqual({
      value: ACCOUNT_POLICY_AUTO,
      channelLabel: null,
    });
    expect(routingPolicyOptions([])[0]).toEqual({
      value: ACCOUNT_POLICY_AUTO,
      channelLabel: null,
    });
  });

  test('offers one option per channel the account actually carries', () => {
    expect(routingPolicyOptions(channels)).toEqual([
      { value: 'auto', channelLabel: null },
      { value: 'only:start-plan', channelLabel: 'ZCode Start Plan' },
      { value: 'only:api-key', channelLabel: 'API Key' },
    ]);
  });

  test('offers nothing but the default when the account carries no channel', () => {
    expect(routingPolicyOptions([])).toEqual([{ value: 'auto', channelLabel: null }]);
  });

  test('never offers a channel the account does not carry', () => {
    const values = routingPolicyOptions(channels).map((option) => option.value);

    expect(values).not.toContain('only:legacy');
    expect(values).not.toContain('disabled');
    expect(
      values.every(
        (value) => value === 'auto' || channels.some((channel) => value === `only:${channel.key}`)
      )
    ).toBe(true);
  });

  test('appends a stale pinned channel so the trigger never shows a blank', () => {
    const options = routingPolicyOptions(channels, 'only:retired');

    expect(options).toHaveLength(channels.length + 2);
    expect(options[options.length - 1]).toEqual({
      value: 'only:retired',
      channelLabel: 'retired',
    });
  });

  test('does not duplicate a pinned channel that is still carried', () => {
    const options = routingPolicyOptions(channels, 'only:start-plan');

    expect(options).toHaveLength(channels.length + 1);
    expect(options.filter((option) => option.value === 'only:start-plan')).toHaveLength(1);
  });

  test('treats auto, the retired enum and malformed values as the default policy', () => {
    expect(routingPolicyOptions(channels, 'auto')).toHaveLength(channels.length + 1);
    expect(routingPolicyOptions(channels, 'disabled')).toHaveLength(channels.length + 1);
    expect(routingPolicyOptions(channels, 'only:')).toHaveLength(channels.length + 1);
    expect(routingPolicyOptions(channels, undefined)).toHaveLength(channels.length + 1);
  });
});

describe('accountPolicyOnly / accountPolicyChannelKey', () => {
  test('round-trips a channel key', () => {
    expect(accountPolicyOnly('start-plan')).toBe('only:start-plan');
    expect(accountPolicyChannelKey(accountPolicyOnly('start-plan'))).toBe('start-plan');
  });

  test('reports no pinned channel for auto, empty or invalid values', () => {
    expect(accountPolicyChannelKey(undefined)).toBeNull();
    expect(accountPolicyChannelKey('')).toBeNull();
    expect(accountPolicyChannelKey('auto')).toBeNull();
    expect(accountPolicyChannelKey('only:')).toBeNull();
    expect(accountPolicyChannelKey('only:  ')).toBeNull();
    expect(accountPolicyChannelKey('start-plan-only')).toBeNull();
  });

  test('reads a pinned channel through surrounding whitespace', () => {
    expect(accountPolicyChannelKey(' only: start-plan ')).toBe('start-plan');
  });
});

describe('normalizeAccountView channels', () => {
  const readChannels = (value: unknown) => normalizeAccountView({ channels: value }).channels;

  test('drops entries without a usable key', () => {
    expect(
      readChannels([
        { key: 'start-plan', label: 'ZCode Start Plan' },
        { label: 'no key' },
        { key: '   ' },
        'start-plan',
        null,
      ])
    ).toEqual([{ key: 'start-plan', label: 'ZCode Start Plan' }]);
  });

  test('falls back to the key when the label is empty', () => {
    expect(readChannels([{ key: 'start-plan', label: '' }, { key: 'api-key' }])).toEqual([
      { key: 'start-plan', label: 'start-plan' },
      { key: 'api-key', label: 'api-key' },
    ]);
  });

  test('trims both fields', () => {
    expect(readChannels([{ key: ' start-plan ', label: ' ZCode Start Plan ' }])).toEqual([
      { key: 'start-plan', label: 'ZCode Start Plan' },
    ]);
  });

  test('keeps an empty array as a real answer and a missing field as unknown', () => {
    expect(readChannels([])).toEqual([]);
    expect(readChannels(undefined)).toBeUndefined();
    expect(readChannels('start-plan')).toBeUndefined();
  });
});

describe('normalizeAccountView policy', () => {
  test('accepts auto and only:<channel key>', () => {
    expect(normalizeAccountView({ policy: 'auto' }).policy).toBe('auto');
    expect(normalizeAccountView({ policy: 'only:start-plan' }).policy).toBe('only:start-plan');
    expect(normalizeAccountView({ policy: ' only: start-plan ' }).policy).toBe('only:start-plan');
  });

  test('drops the retired enum and malformed values', () => {
    expect(normalizeAccountView({ policy: 'start-plan-only' }).policy).toBeUndefined();
    expect(normalizeAccountView({ policy: 'only:' }).policy).toBeUndefined();
    expect(normalizeAccountView({ policy: 'only:  ' }).policy).toBeUndefined();
    expect(normalizeAccountView({}).policy).toBeUndefined();
  });
});

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko'] as const;

/** 卡片上「套餐/渠道」那行与固定策略词表一起退役，6 个语种都不该再有这些 key。 */
const RETIRED_POOL_KEYS = [
  'quota_plan',
  'quota_channel',
  'policy_start_plan_only',
  'policy_api_key_only',
  'policy_start_plan_first',
  'policy_disabled',
  // 「暂无套餐额度 / 刷新该账号以获取额度」：前者替账号断言了它没有套餐，后者是
  // 一句刷完也不会兑现的承诺（刷完仍是「未上报」）。两个状态合并成一句陈述。
  'quota_unknown',
  'quota_unknown_hint',
  // 「未配置」：插件不再替没有密钥的渠道编造分组，这个状态永远不会出现。
  'quota_no_credential',
];

const readPoolLocale = (locale: string): Record<string, string> => {
  const raw = readFileSync(
    new URL(`../src/i18n/locales/${locale}.json`, import.meta.url),
    'utf8'
  );
  return (JSON.parse(raw) as { account_pool: Record<string, string> }).account_pool;
};

describe('account pool i18n keys', () => {
  test('drops the retired keys in every locale', () => {
    LOCALES.forEach((locale) => {
      const pool = readPoolLocale(locale);
      RETIRED_POOL_KEYS.forEach((key) => {
        expect(Object.keys(pool)).not.toContain(key);
      });
    });
  });

  test('adds the new keys with identical placeholders in every locale', () => {
    LOCALES.forEach((locale) => {
      const pool = readPoolLocale(locale);
      expect(pool.policy_only).toContain('{{name}}');
      expect(pool.quota_group_models).toContain('{{count}}');
      expect(pool.quota_expires_at).toContain('{{time}}');
      // 按日窗口换的是周期，不是额度有效期，措辞必须分开。
      expect(pool.quota_resets_at).toContain('{{time}}');
      expect(pool.quota_remaining_time).toContain('{{minutes}}');
      expect(pool.quota_label_plain.length).toBeGreaterThan(0);
      // 「未开通」不带占位符，但每个语种都必须有。
      expect(pool.quota_not_subscribed.length).toBeGreaterThan(0);
      // 「还没读到额度」是另一条状态，同样每个语种都必须有，且不能与上面重复。
      expect(pool.quota_pending.length).toBeGreaterThan(0);
      expect(pool.quota_pending).not.toBe(pool.quota_not_subscribed);
      // 开通日期是纯标签 + 值，不带占位符，但每个语种都必须有。
      expect(pool.opened_at_label.length).toBeGreaterThan(0);
    });
  });

  test('keeps the surviving policy and quota keys in every locale', () => {
    LOCALES.forEach((locale) => {
      const pool = readPoolLocale(locale);
      ['policy_label', 'policy_default', 'policy_hint', 'quota_label', 'quota_remaining'].forEach(
        (key) => {
          expect(Object.keys(pool)).toContain(key);
        }
      );
    });
  });
});

describe('account pool card body', () => {
  test('leaves the routing policy control to the action row', () => {
    expect(poolSource).not.toContain('policyBlock');
    expect(poolSource).not.toContain('POLICY_VALUES');
    expect(poolSource).not.toContain("t('account_pool.policy_label')");
  });

  test('still states the pool state and the plan quota', () => {
    expect(poolSource).toContain("t('account_pool.state_label')");
    expect(poolSource).toContain("'account_pool.quota_label'");
    // 额度按渠道分组：分组标题给渠道名 + 组内模型数。
    expect(poolSource).toContain("t('account_pool.quota_group_models'");
  });

  test('colors the quota bar by the remaining fraction', () => {
    expect(poolSource).toContain('barSuccess');
    expect(poolSource).toContain('barCaution');
    expect(poolSource).toContain('barDanger');
  });

  test('prefers a real amount and never draws a bar for a message alone', () => {
    expect(poolSource).toContain("t('account_pool.quota_remaining'");
    expect(poolSource).toContain('bucketDescription');
    expect(poolSource).toContain('description === undefined && drawsBar && fraction !== null');
  });

  test('reports a bare balance without inventing a ratio', () => {
    // 只有 remaining、没有 total ⇒ 没有分母：报数值，不画比例条。
    expect(poolSource).toContain('hasBalance');
    expect(poolSource).toContain('toLocaleString');
    expect(poolSource).toContain('bucket.total !== undefined ||');
  });

  test('states the plan expiry once per plan group, per row only when the rows disagree', () => {
    // 计划一级的事实挂组头：组内一致时只说一次，不一致才逐行（`sharedResetAt` 返回 null）。
    expect(poolSource).toContain('sharedResetAt(group.buckets)');
    expect(poolSource).toContain('styles.groupExpiry');
    expect(poolSource).toContain('styles.bucketExpiry');
    expect(poolSource).toContain('groupResetAt ? null : bucket.resetAt');
    expect(poolSource).toContain("'account_pool.quota_expires_at'");
  });

  test('only hoists an expiry to a header that exists', () => {
    // 无名组没有组头，也就没有「说一次」的位置：此时必须逐行，否则时刻会漂到组外。
    expect(poolSource).toContain('group.name ? sharedResetAt(group.buckets) : null');
  });

  test('calls a daily plan a reset rather than an expiry, header included', () => {
    // 一个计划一组之后，组头的时刻就是整份计划的时刻：按日计划每 24 小时换一次，
    // 把它的日切说成「到期」等于宣布过期。
    expect(poolSource).toContain("'account_pool.quota_resets_at'");
    expect(poolSource).toContain("bucket.window?.trim() === 'daily'");
    expect(poolSource).toContain('group.name ? sharedWindow(group.buckets) : null');
    expect(poolSource).toContain("groupWindow === 'daily'");
  });

  test('pairs every expiry with a countdown that ticks on its own', () => {
    // 只报时刻要读者自己减；只报剩余又没法安排 ⇒ 两半都要，且由卡片统一供给 now。
    expect(poolSource).toContain('resolveResetInstant(resetAt, window, now)');
    expect(poolSource).toContain('remainingMinutes(at, now)');
    expect(poolSource).toContain("t('account_pool.quota_remaining_time', { minutes })");
    // 分钟时钟是全应用共享的，不给每张卡片各起一个定时器。
    expect(poolSource).toContain('useNow()');
    // 组头与模型行读同一个 now，不能各算各的。
    expect(poolSource).toContain('<QuotaSummary account={account} now={now} />');
  });

  test('hands the window down so a daily boundary can roll forward', () => {
    // 「是不是按日」决定过去时刻要不要往前滚，窗口必须一路传到 ExpiryLine。
    expect(poolSource).toContain('window={bucket.window}');
    // 组头报的是整份计划的时刻，窗口同样要传下去。
    expect(poolSource).toContain('window={groupWindow}');
  });

  test('names the block after what the account actually reports', () => {
    // 有渠道/套餐分组 ⇒「套餐额度」；没有（积分制账号）⇒ 只说「额度」。
    expect(poolSource).toContain("'account_pool.quota_label_plain'");
    expect(poolSource).toContain("bucket.group?.trim() ?? ''");
  });

  test('says one thing about an account with no quota, whatever the reason', () => {
    // 没有读数（unknown）与读到了空（quota.length === 0）对读者是同一件事：这个账号
    // 没有可用额度。分开说会逼出一句「刷新以获取额度」——刚刷完也还是这句。
    // 措辞只说状态、不说机制：不能写成「未上报」，那读起来像采集坏了。
    expect(poolSource).toContain("t('account_pool.quota_empty')");
    expect(poolSource).not.toContain('quota_unknown');
    // 读取失败是另一回事，仍然单独说，且不能被当成「没有额度」。
    expect(poolSource).toContain("account.quotaState === 'query-error'");
    expect(poolSource).toContain("t('account_pool.quota_error')");
  });

  test('names each plan that reported no quota instead of collapsing them', () => {
    // 「两个套餐都没有额度」是两条状态，不是一句笼统的「没有额度」：插件为每个套餐保留
    // 分组，并用稳定 token 说明原因；句子由前端按语言组装（插件没有语言环境）。
    expect(poolSource).toContain("'not-subscribed': 'account_pool.quota_not_subscribed'");
    // 没有密钥的渠道不再编造分组，所以前端也不该留着那条永远走不到的映射。
    expect(poolSource).not.toContain('no-credential');
    expect(poolSource).toContain('describeQuotaBucket(bucket.description, t)');
    // 只有状态、没有读数的一组没有模型可数，不能报成「1 个模型」。
    expect(poolSource).toContain('const hasReadings = group.buckets.some(');
  });

  test('shows the account age only when the platform reported it', () => {
    // 开通时刻是账号自己的事实，宿主只在插件真的报了时才下发；读不到就整行不出现，
    // 不拿凭证创建时间顶替（那是另一件事）。格式化不出日期时也不留空行。
    expect(poolSource).toContain("t('account_pool.opened_at_label')");
    expect(poolSource).toContain('account.openedAt ? formatDateValue(account.openedAt');
    expect(poolSource).toContain('{openedAt && (');
  });

  test('names the credential site instead of repeating the account-pool title', () => {
    // 整页就是账号池，卡片里再写一次「账号池」等于没说。卡片讲的是凭证自己的站点：
    // 域名 + 国内/国际，来自 provider 键的固定映射，未登记就不出这一行。
    expect(poolSource).not.toContain('section_title');
    expect(poolSource).toContain("t('account_pool.site_label')");
    expect(poolSource).toContain('resolveCredentialSite(providerKey)');
  });
});

describe('credential site identity', () => {
  test('maps every site key to its own upstream domain', async () => {
    const { resolveCredentialSite } = await import('../src/features/authFiles/siteIdentity');
    expect(resolveCredentialSite('workbuddy-cn')).toEqual({
      brand: 'WorkBuddy',
      region: 'cn',
      domain: 'copilot.tencent.com',
    });
    expect(resolveCredentialSite('workbuddy-intl')).toEqual({
      brand: 'CodeBuddy',
      region: 'intl',
      domain: 'codebuddy.ai',
    });
    expect(resolveCredentialSite('workbuddy-global')).toEqual({
      brand: 'WorkBuddy',
      region: 'intl',
      domain: 'workbuddy.ai',
    });
    expect(resolveCredentialSite('zcode-bigmodel')?.domain).toBe('bigmodel.cn');
    expect(resolveCredentialSite('zcode-zai')?.domain).toBe('z.ai');
    // 未登记的键不造站点：徽标回落到 i18n 标签，站点行不出现。
    expect(resolveCredentialSite('codex')).toBeNull();
    // Loomy 的模型网关（loomyad.xunfei.cn）与账号服务（account.xfinfr.com）不是一个
    // 站点域名，写哪个都是编的；台账侧也明确断言它没有站点，这里保持一致。
    expect(resolveCredentialSite('loomy')).toBeNull();
  });

  test('gives every credential key its own badge colour', async () => {
    // 徽标文字不足以区分同一插件的多个站点（workbuddy-cn 与 workbuddy-global
    // 都叫 WorkBuddy），所以站点表里的每个键都必须在配色表里有自己的一项，
    // 不能落到 unknown 的虚线灰底。
    const { resolveCredentialSite } = await import('../src/features/authFiles/siteIdentity');
    const { TYPE_COLORS } = await import('../src/utils/quota/constants');
    for (const key of [
      'workbuddy-cn',
      'workbuddy-intl',
      'workbuddy-global',
      'zcode-bigmodel',
      'zcode-zai',
    ]) {
      expect(resolveCredentialSite(key)).not.toBeNull();
      expect(TYPE_COLORS[key]?.light).toBeDefined();
      expect(TYPE_COLORS[key]?.dark).toBeDefined();
    }
    // loomy 没有站点行，但它的徽标仍然要出现在凭据页与 tab 上。
    expect(TYPE_COLORS.loomy?.light).toBeDefined();
    expect(TYPE_COLORS.loomy?.dark).toBeDefined();
  });

  test('keeps the filter tab to a product name plus 国内/国际', () => {
    const tabs = readFileSync(
      new URL('../src/features/authFiles/components/ProviderTabs.tsx', import.meta.url),
      'utf8'
    );
    expect(tabs).toContain('resolveCredentialSite(type)');
    expect(tabs).toContain('auth_files.region_${site.region}');
    // 域名留给卡片：tab 不再挂第二个域名行。
    expect(tabs).not.toContain('site.domain');
  });
});

describe('account pool quota rendering', () => {
  // 后端实测载荷：凭证只有免费渠道，上游答「没有这个套餐」。没有密钥的渠道不再上报，
  // 所以卡片上只会有这一组。
  const noQuotaAccount = (): AccountView =>
    account({
      provider: 'zcode-zai',
      quotaState: 'entitled',
      quota: [
        { group: 'Start Plan (free)', remainingFraction: 0, description: 'not-subscribed' },
      ],
    });

  const renderPool = async (view: AccountView, language: string) => {
    const previous = i18n.language;
    await i18n.changeLanguage(language);
    const markup = renderToStaticMarkup(
      createElement(AuthFilePoolSection, {
        account: view,
        providerKey: 'zcode',
        quotaCapable: true,
      })
    );
    await i18n.changeLanguage(previous);
    return markup;
  };

  test('names the plan it checked when there is no quota', async () => {
    const markup = await renderPool(noQuotaAccount(), 'zh-CN');

    // 省略组名，读者就不知道查过哪个套餐。
    expect(markup).toContain('Start Plan (free)');
    expect(markup).toContain('未开通');
    // 不再退化成一句笼统的「没有可用额度」。
    expect(markup).not.toContain('没有可用额度');
    // token 不能漏到界面上。
    expect(markup).not.toContain('not-subscribed');
  });

  /**
   * 「问过了、还没读到」不是「上游说没有」。新号在计划生效前探测，上游答的就是
   * 空数组；把它说成「未开通」等于替账号断言了它没有套餐，而它其实有。
   */
  const pendingAccount = (): AccountView =>
    account({
      provider: 'zcode-zai',
      quotaState: 'entitled',
      quota: [{ group: 'Start Plan (free)', remainingFraction: 0, description: 'pending' }],
    });

  test('does not call an unread channel an unsubscribed one', async () => {
    const markup = await renderPool(pendingAccount(), 'zh-CN');

    expect(markup).toContain('暂未读到额度');
    expect(markup).not.toContain('未开通');
    // token 不能漏到界面上。
    expect(markup).not.toContain('pending');
  });

  test('does not count a state row as a model', async () => {
    const markup = await renderPool(noQuotaAccount(), 'zh-CN');

    // 「未开通」不是「1 个模型」：这一组没有模型可数。
    expect(markup).not.toContain('个模型');
  });

  /**
   * 后端实测载荷：一个通道同时持有一份活动计划和一份常规计划。两组各两行，
   * 每组的期限相同，组头的说法必须按各自窗口区分。
   */
  const twoPlansAccount = (): AccountView =>
    account({
      provider: 'zcode-zai',
      quotaState: 'entitled',
      quota: [
        {
          group: 'ZCode 1024 Dev Day',
          model: 'GLM-5.3',
          window: 'one_time',
          remainingFraction: 1,
          remaining: 200000000,
          total: 200000000,
          resetAt: '2099-10-26T01:00:00Z',
        },
        {
          group: 'ZCode 1024 Dev Day',
          model: 'GLM-5.3-Flash',
          window: 'one_time',
          remainingFraction: 0.99,
          remaining: 299998300,
          total: 300000000,
          resetAt: '2099-10-26T01:00:00Z',
        },
        {
          group: 'ZCode Start Plan',
          model: 'GLM-5.3',
          window: 'daily',
          remainingFraction: 0.99,
          remaining: 2998305,
          total: 3000000,
          resetAt: '2099-10-25T15:59:00Z',
        },
        {
          group: 'ZCode Start Plan',
          model: 'GLM-5.3-Flash',
          window: 'daily',
          remainingFraction: 0.96,
          remaining: 4830889,
          total: 5000000,
          resetAt: '2099-10-25T15:59:00Z',
        },
      ],
    });

  test('draws one block per plan, each with its own heading and amounts', async () => {
    const markup = await renderPool(twoPlansAccount(), 'zh-CN');

    // 两个计划各自成组：压成一组会让常规计划的三百万看起来属于活动计划。
    expect(markup).toContain('ZCode 1024 Dev Day');
    expect(markup).toContain('ZCode Start Plan');
    // 每个计划各两行，组内模型数按组算，不是四行一起算。
    expect(markup.split('2 个模型').length - 1).toBe(2);
    expect(markup).not.toContain('4 个模型');
  });

  test('calls the campaign expiry an expiry and the standing plan a reset', async () => {
    const markup = await renderPool(twoPlansAccount(), 'zh-CN');

    // 一次性活动到期就是到期；按日常规计划换的是周期，不是额度有效期。
    expect(markup.split('到期时间').length - 1).toBe(1);
    expect(markup.split('下一次重置时间').length - 1).toBe(1);
  });

  test('states each plan period once, at its own heading', async () => {
    const markup = await renderPool(twoPlansAccount(), 'zh-CN');

    // 组内各桶时刻相同 ⇒ 只在组头说一次，四行不再各报一遍。
    expect(markup.split('剩余时间').length - 1).toBe(2);
  });

  /**
   * 非模型桶（余额、计划总量）的行标题是 `label`，不是 `model`：宿主
   * `account_view.go:98` 已下发，面板必须显示它，否则读者看到的是一行没有名字的
   * 额度，或者更糟 —— 把余额画成某个模型。
   */
  test('titles a non-model bucket by its label, not by a model it does not have', async () => {
    const labelAccount = (): AccountView =>
      account({
        provider: 'zcode-zai',
        quotaState: 'entitled',
        quota: [
          { group: 'ZCode', label: '账户余额', remainingFraction: 0.4, remaining: 1200 },
          { group: 'ZCode', model: 'GLM-5.3', remainingFraction: 0.9 },
        ],
      });
    const markup = await renderPool(labelAccount(), 'zh-CN');

    expect(markup).toContain('账户余额');
    expect(markup).toContain('GLM-5.3');
    // 余额行没有模型可显示，标签必须来自 label 本身。
    expect(markup.split('账户余额').length - 1).toBe(1);
  });
});
