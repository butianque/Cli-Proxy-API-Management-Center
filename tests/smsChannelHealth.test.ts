import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { EMPTY_SMS_VIEW, isOverCeiling, toChannel, toLedger, toProbes, toStatus } from '../src/features/sms/smsMapping';
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

  test('the empty view is unloaded, not a zero reading', () => {
    expect(EMPTY_SMS_VIEW.loaded).toBe(false);
    expect(toStatus({ status: 'ok' }, '号段').loaded).toBe(true);
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
    // Two views: pool (default) and config (overlay).
    expect(page).toContain("useState<PageView>('pool')");
    expect(page).toContain('<SupplyPoolCard');
    // The page delegates to shared views, not to smsApi directly.
    expect(page).not.toContain('smsApi.getStatus');
  });

  test('the config view switches category and hands each one its own view', () => {
    const page = read('SmsServicePage.tsx');
    // The category switch is a real control, and the page owns it so the two
    // views cannot each render a second tablist for the same decision.
    expect(page).toContain('sms_service.tab_phone');
    expect(page).toContain('sms_service.tab_email');
    expect(page).toContain('<PhoneSupplyView />');
    expect(page).toContain('<SupplyChannelCard');
    // Credentials are opened by the views, never by the container.
    expect(page).not.toContain('<ChannelConfigModal');
    expect(page).not.toContain('<ChannelEditorModal');
  });

  test('the phone view owns the credential entry, not the platform data panels', () => {
    const phone = read('PhoneSupplyView.tsx');
    expect(phone).toContain('<ChannelEditorModal');
    expect(phone).toContain('smsApi.getStatus');
    // The platform-side readouts (balance / platform channels / ledger / guardrail /
    // tips) were taken off this page; where they land is still to be decided.
    expect(phone).not.toContain('sms_service.stat_balance');
    expect(phone).not.toContain('sms_service.channels_title');
    expect(phone).not.toContain('sms_service.ledger_title');
    expect(phone).not.toContain('sms_service.guardrail_title');
    expect(phone).not.toContain('sms_service.tips_title');
    expect(phone).not.toContain('sms_service.refresh_channels');
  });

  test('both kinds list their channels through the same table', () => {
    const phone = read('PhoneSupplyView.tsx');
    const card = read('SupplyChannelCard.tsx');
    // Same skeleton: the page wrapper plus a header action row.
    for (const view of [phone, card]) {
      expect(view).toContain('styles.pageHeader');
      expect(view).toContain('styles.headerActions');
      expect(view).toContain('<SupplyPoolTable');
    }
    // One shared table per kind. Neither view lists channels itself.
    expect(phone).toContain('kind="phone"');
    expect(card).toContain('kind="email"');
    expect(phone).not.toContain('listChannels(');
    expect(card).not.toContain('listChannels(');
    // Both kinds open the same editor; the kind arrives as a prop, so neither view
    // can grow a second editor that only its own category understands.
    expect(card).toContain('ChannelEditorModal');
    expect(card).not.toContain('onCategoryChange');
    expect(card).not.toContain('role="tablist"');
    // The card takes no category prop — it *is* the email view, and the kind is
    // fixed inside it. Its rows re-read themselves: the table bumps its own
    // reload key after a save, so nothing outside has to be told a channel
    // changed.
    expect(card).not.toMatch(/kind\??:\s*SupplyKind/);
    expect(card).toContain('setReloadKey((key) => key + 1)');
    expect(phone).toContain('ChannelEditorModal');
    const editor = read('ChannelEditorModal.tsx');
    expect(editor).not.toContain('role="tablist"');
    expect(editor).toContain('kind: SupplyKind;');
    expect(editor).not.toContain("['phone', 'email']");
  });

  test('the pool table has exactly one add entry, and it lives in the page header', () => {
    const table = read('SupplyPoolTable.tsx');
    // The empty state used to carry a second "add channel" button, which disappeared
    // as soon as the first row existed — so "where do I add one" depended on the data.
    expect(table).not.toContain('onAdd');
    expect(table).not.toContain('config_add_phone');
    expect(table).not.toContain('config_add_email');
    expect(read('PhoneSupplyView.tsx')).toContain('config_add_phone');
    expect(read('SupplyChannelCard.tsx')).toContain('config_add_email');
  });

  test('the channel pool is a table with the seven columns and a real switch', () => {
    const table = read('SupplyPoolTable.tsx');
    for (const key of [
      'pool_col_name',
      'pool_col_category',
      'pool_col_natures',
      'pool_col_connection',
      'pool_col_switch',
      'pool_col_edit',
      'pool_col_remove',
    ]) {
      expect(table).toContain(key);
    }
    // Every control changes something real: the switch writes the enabled flag, the
    // delete deletes, and the state comes from a real probe. No local-only state.
    expect(table).toContain('supplyApi.saveChannel');
    expect(table).toContain('supplyApi.removeChannel');
    expect(table).toContain('supplyApi.probeChannels');
    expect(table).toContain('<ToggleSwitch');
    // The methods a channel offers still come from the backend, not a page-local list.
    expect(table).toContain('toNatureOptions(');
    // Wire field names stay in the mapping module.
    expect(table).not.toContain('secret_present');
  });

  test('the probe seam keeps unknown states out of the page', () => {
    expect(
      toProbes([{ id: 'a', natures: { api: { state: 'online' }, web: { state: 'nonsense' } } }])
    ).toEqual([{ id: 'a', natures: { api: 'online' } }]);
    expect(toProbes([{ id: '', natures: { api: { state: 'online' } } }])).toEqual([]);
    expect(toProbes(undefined)).toEqual([]);
  });

});
