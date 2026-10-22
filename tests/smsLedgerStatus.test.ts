import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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
});
