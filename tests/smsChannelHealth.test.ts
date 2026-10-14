import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { isOverCeiling, toChannel, toLedger, toStatus, EMPTY_SMS_VIEW } from '../src/features/sms/smsMapping';
import type { SmsChannelWire, SmsLedgerWire } from '../src/services/api/sms';

/**
 * `toChannel` / `toLedger` / `toStatus` are the seam between the backend wire
 * shape and the page's domain types, and all three are pure. Rules broken here
 * before:
 *
 * - the health dot used a hard-coded price band (0.3) while the page counted
 *   "over ceiling" against the configured ceiling (0.35), so a channel could be
 *   flagged at the same time it was reported as within budget — the two now share
 *   one predicate (`isOverCeiling`), including the "no ceiling configured" case
 *   where both must stay quiet instead of reporting "N above ¥0.00";
 * - a ledger row without a `last_used` was stamped with `now`, which renders as
 *   if the number had just been taken.
 */
const channel = (over: Partial<SmsChannelWire> = {}): SmsChannelWire => ({
  uid: 'c-1',
  name: '[21614]讯飞',
  price: 0.3,
  stock: 10,
  carriers: '移动',
  paragraphs: '170',
  ...over,
});

/** Options for one mapping call; the prefix word comes from i18n in the page. */
const withCeiling = (ceilingCny: number | null) => ({ ceilingCny, prefixLabel: '号段' });

describe('the channel health dot follows the configured price ceiling', () => {
  test('a channel inside the ceiling is good', () => {
    expect(toChannel(channel({ price: 0.3 }), withCeiling(0.35)).health).toBe('good');
  });

  test('a channel above the ceiling is a warning', () => {
    expect(toChannel(channel({ price: 0.4 }), withCeiling(0.35)).health).toBe('warning');
  });

  test('the same price flips with the ceiling, so the dot cannot drift from the count', () => {
    // 0.34 is over a 0.30 ceiling and inside a 0.35 one; a hard-coded band would
    // answer the same both times.
    expect(toChannel(channel({ price: 0.34 }), withCeiling(0.3)).health).toBe('warning');
    expect(toChannel(channel({ price: 0.34 }), withCeiling(0.35)).health).toBe('good');
  });

  test('an unknown ceiling does not invent an over-budget warning', () => {
    expect(toChannel(channel({ price: 9.99 }), withCeiling(0)).health).toBe('good');
    expect(toChannel(channel({ price: 9.99 }), withCeiling(null)).health).toBe('good');
  });

  test('paused or out of stock outranks the price band', () => {
    expect(toChannel(channel({ paused: true, price: 0.1 }), withCeiling(0.35)).health).toBe(
      'critical'
    );
    expect(toChannel(channel({ stock: 0, price: 0.1 }), withCeiling(0.35)).health).toBe('warning');
  });

  test('a non-finite price is reported as 0, not as NaN', () => {
    expect(toChannel(channel({ price: Number.NaN }), withCeiling(0.35)).priceCny).toBe(0);
  });
});

describe('the over-ceiling count and the dot share one predicate', () => {
  test('an unset ceiling is never "exceeded", at any price', () => {
    // The page counted `price > ceiling` with no `> 0` guard, so an unconfigured
    // ceiling (0) made the card header read "N above ¥0.00" while every dot was
    // green. Both sides now answer through `isOverCeiling`.
    expect(isOverCeiling(9.99, 0)).toBe(false);
    expect(isOverCeiling(9.99, null)).toBe(false);
    expect(isOverCeiling(0, 0.35)).toBe(false);
    expect(isOverCeiling(0.35, 0.35)).toBe(false);
    expect(isOverCeiling(0.36, 0.35)).toBe(true);
  });

  test('the predicate agrees with the dot for the same price and ceiling', () => {
    for (const [price, ceiling] of [
      [0.3, 0.35],
      [0.4, 0.35],
      [0.34, 0.3],
      [9.99, 0],
      [9.99, null],
    ] as const) {
      const dotSaysOver = toChannel(channel({ price }), withCeiling(ceiling)).health === 'warning';
      // A warning dot from price alone must be exactly the predicate's answer.
      expect(dotSaysOver).toBe(isOverCeiling(price, ceiling));
    }
  });

  test('the page uses that predicate and hides the chip when no ceiling is set', () => {
    // The phone category view owns the channel table now; the page is only the
    // category container. The predicate contract follows the logic.
    const page = readFileSync(
      new URL('../src/features/sms/PhoneSupplyView.tsx', import.meta.url),
      'utf8'
    );
    expect(page).toContain('isOverCeiling(');
    expect(page).not.toContain('channel.priceCny > ');
    expect(page).toContain('view.ceilingCny > 0 ?');
  });

  test('an unloaded snapshot is never rendered as ¥0.00', () => {
    // The guardrail card read `¥0.00` from the empty view before the backend
    // answered, i.e. it invented a real spend and a real cap. Every money and
    // count reading now goes through the `loaded` flag, and the good/warn colour
    // is only applied when a cumulative cap actually exists.
    const page = readFileSync(
      new URL('../src/features/sms/PhoneSupplyView.tsx', import.meta.url),
      'utf8'
    );
    expect(page).toContain("view.loaded ? formatCny(view.spentCny) : '—'");
    expect(page).toContain("spent: view.loaded ? formatCny(view.spentCny) : '—'");
    expect(page).toContain('const capConfigured = view.loaded && view.maxTotalCny > 0;');
    expect(page).not.toContain('view.spentCny >= view.maxTotalCny ?');
  });

  test('the empty view is unloaded, not a zero reading', () => {
    expect(EMPTY_SMS_VIEW.loaded).toBe(false);
    expect(toStatus({ status: 'ok' }, '号段').loaded).toBe(true);
  });

  test('the custom platform endpoint the operator typed is actually submitted', () => {
    // The field was editable but `handleSave` always sent `endpoint: ''`, so the
    // control could not change anything while the backend does accept the field.
    const modal = readFileSync(
      new URL('../src/features/sms/ChannelConfigModal.tsx', import.meta.url),
      'utf8'
    );
    expect(modal).toContain("endpoint: endpointLocked ? '' : endpoint.trim()");
    // The built-in platform's address stays read-only, so it must not be sent.
    expect(modal).toContain('endpointLocked ? (');
  });

  test('the channel modal has one entry per state, not three duplicates', () => {
    // The header "channel config" button, the card's "add channel" action and the
    // row's "edit" action all opened the same modal. The card action was removed:
    // the empty state carries the "add" action and a configured row carries "edit".
    const page = readFileSync(
      new URL('../src/features/sms/PhoneSupplyView.tsx', import.meta.url),
      'utf8'
    );
    expect(page).not.toContain('sms_service.configure_channels');
    // Two entries remain: the empty-state add and the configured-row edit.
    expect(page.match(/sms_service\.configure_add/g)?.length).toBe(1);
    expect(page.match(/sms_service\.configure_edit/g)?.length).toBe(1);
  });
});

describe('the ledger never invents a timestamp', () => {
  const ledger = (over: Partial<SmsLedgerWire> = {}): SmsLedgerWire => ({
    phone: '17000000000',
    account: 'acct',
    last_used: 1_700_000_000,
    ...over,
  });

  test('a recorded time is converted as-is', () => {
    expect(toLedger(ledger()).takenAt).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });

  test('a missing time stays empty instead of becoming "now"', () => {
    expect(toLedger(ledger({ last_used: 0 })).takenAt).toBeNull();
    expect(toLedger(ledger({ last_used: undefined })).takenAt).toBeNull();
  });
});

describe('the status view is the only place backend field names live', () => {
  test('a locked store hides credential readings instead of claiming "not configured"', () => {
    const view = toStatus(
      {
        status: 'unavailable',
        error: 'store locked',
        store_available: false,
        // A locked store cannot read the names, so the backend reports them absent
        // even though they exist — the view must not turn that into "never set up".
        api_present: false,
        cookie_present: false,
        balance_cny: 12.5,
      },
      '号段'
    );
    expect(view.storeLocked).toBe(true);
    expect(view.connection).toBe('unavailable');
    expect(view.connectionReason).toBe('store locked');
    // Balance is a credential reading: it must not survive the lock.
    expect(view.balanceCny).toBeNull();
  });

  test('a reachable balance is what makes the connection "connected"', () => {
    const view = toStatus({ status: 'ok', balance_cny: 12.5, api_present: true }, '号段');
    expect(view.connection).toBe('connected');
    expect(view.balanceCny).toBe(12.5);
    expect(view.storeLocked).toBe(false);
  });

  test('a balance error is reported as a failed connection, not as unavailable', () => {
    const view = toStatus({ status: 'ok', balance_error: 'bad credential' }, '号段');
    expect(view.connection).toBe('failed');
    expect(view.connectionReason).toBe('bad credential');
  });

  test('the ceiling reaches both the view and every channel it maps', () => {
    const view = toStatus(
      {
        status: 'ok',
        budget: { max_per_number_cny: 0.35, max_total_cny: 5 },
        channels: [channel({ price: 0.4 }), channel({ uid: 'c-2', price: 0.3 })],
      },
      '号段'
    );
    expect(view.ceilingCny).toBe(0.35);
    expect(view.maxTotalCny).toBe(5);
    expect(view.channels.map((c) => c.health)).toEqual(['warning', 'good']);
    expect(view.channels.filter((c) => isOverCeiling(c.priceCny, view.ceilingCny))).toHaveLength(1);
  });

  test('a missing snapshot time stays empty instead of becoming "now"', () => {
    expect(toStatus({ status: 'ok' }, '号段').updatedAt).toBe('');
    expect(toStatus({ status: 'ok', channels_updated_at: 0 }, '号段').updatedAt).toBe('');
    expect(toStatus({ status: 'ok', channels_updated_at: 1_700_000_000 }, '号段').updatedAt).toBe(
      new Date(1_700_000_000 * 1000).toISOString()
    );
  });
});

describe('the page carries both supply categories and two views', () => {
  const read = (name: string) =>
    readFileSync(new URL(`../src/features/sms/${name}`, import.meta.url), 'utf8');

  test('the container switches between pool and config views', () => {
    const page = read('SmsServicePage.tsx');
    // Category tabs are real controls.
    expect(page).toContain('tab_phone');
    expect(page).toContain('tab_email');
    // Two views: pool (default) and config (overlay).
    expect(page).toContain("useState<PageView>('pool')");
    expect(page).toContain('<SupplyPoolCard');
    expect(page).toContain('<SupplyChannelCard');
    // The page delegates to shared cards, not to smsApi directly.
    expect(page).not.toContain('smsApi.getStatus');
  });

  test('the phone credential modal is reachable from the config view', () => {
    const page = read('SmsServicePage.tsx');
    expect(page).toContain('<ChannelConfigModal');
    expect(page.match(/setModalOpen\(true\)/g)?.length).toBe(1);
  });

  test('the phone view still owns its data load and header actions', () => {
    const phone = read('PhoneSupplyView.tsx');
    expect(phone).toContain('smsApi.getStatus');
    expect(phone).toContain('export function PhoneSupplyView');
    expect(phone).toContain('smsApi.refreshChannels()');
  });
});
