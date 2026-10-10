import { describe, expect, test } from 'bun:test';
import { toChannel, toLedger } from '../src/features/sms/smsMapping';
import type { SmsChannelWire, SmsLedgerWire } from '../src/services/api/sms';

/**
 * `toChannel` / `toLedger` are the seam between the backend wire shape and the
 * page's domain types, and both are pure. Two rules were broken here:
 *
 * - the health dot used a hard-coded price band (0.3) while the page counted
 *   "over ceiling" against the configured ceiling (0.35), so a channel could be
 *   flagged at the same time it was reported as within budget;
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

describe('the channel health dot follows the configured price ceiling', () => {
  test('a channel inside the ceiling is good', () => {
    expect(toChannel(channel({ price: 0.3 }), 0.35).health).toBe('good');
  });

  test('a channel above the ceiling is a warning', () => {
    expect(toChannel(channel({ price: 0.4 }), 0.35).health).toBe('warning');
  });

  test('the same price flips with the ceiling, so the dot cannot drift from the count', () => {
    // 0.34 is over a 0.30 ceiling and inside a 0.35 one; a hard-coded band would
    // answer the same both times.
    expect(toChannel(channel({ price: 0.34 }), 0.3).health).toBe('warning');
    expect(toChannel(channel({ price: 0.34 }), 0.35).health).toBe('good');
  });

  test('an unknown ceiling does not invent an over-budget warning', () => {
    expect(toChannel(channel({ price: 9.99 }), 0).health).toBe('good');
    expect(toChannel(channel({ price: 9.99 }), null).health).toBe('good');
  });

  test('paused or out of stock outranks the price band', () => {
    expect(toChannel(channel({ paused: true, price: 0.1 }), 0.35).health).toBe('critical');
    expect(toChannel(channel({ stock: 0, price: 0.1 }), 0.35).health).toBe('warning');
  });

  test('a non-finite price is reported as 0, not as NaN', () => {
    expect(toChannel(channel({ price: Number.NaN }), 0.35).priceCny).toBe(0);
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
