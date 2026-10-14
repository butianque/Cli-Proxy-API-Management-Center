import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { toNatureOptions, toPool, toSupplyChannels } from '../src/features/sms/smsMapping';
import type { SupplyChannelWire, SupplyLedgerWire } from '../src/services/api/supply';

/**
 * A source is a label plus a nature plus the connection details that nature
 * implies. The label is what a person reads and picks from; the nature is what
 * decides both the connection form and the shape of the pool. These checks pin
 * that split, and pin the mapping module as the only place backend field names
 * appear.
 */

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

const channel = (over: Partial<SupplyChannelWire> = {}): SupplyChannelWire => ({
  id: 'email-ormnes',
  kind: 'email',
  label: 'Ormnes',
  nature: 'imap',
  ...over,
});

describe('a source is a label plus a nature plus its connection', () => {
  test('the label is free text and the nature is the switch', () => {
    const mapped = toSupplyChannels([channel()])[0];
    expect(mapped.label).toBe('Ormnes');
    expect(mapped.nature).toBe('imap');
    expect(mapped.kind).toBe('email');
  });

  test('an absent optional field is empty, never undefined leaking into the page', () => {
    const mapped = toSupplyChannels([channel()])[0];
    expect(mapped.endpoint).toBe('');
    expect(mapped.account).toBe('');
    expect(mapped.secret).toBe('');
    expect(mapped.secretPresent).toBe(false);
  });

  test('only an explicit off means off', () => {
    expect(toSupplyChannels([channel({ enabled: false })])[0].enabled).toBe(false);
    expect(toSupplyChannels([channel()])[0].enabled).toBe(true);
  });

  test('the offered natures are the backend set, not a page-local copy', () => {
    const options = toNatureOptions([
      { nature: 'api', kinds: ['phone', 'email'] },
      { nature: 'imap', kinds: ['email'] },
    ]);
    expect(options).toEqual([
      { nature: 'api', kinds: ['phone', 'email'] },
      { nature: 'imap', kinds: ['email'] },
    ]);
    // A missing list is an empty set, not a crash.
    expect(toNatureOptions(undefined)).toEqual([]);
    expect(toSupplyChannels(undefined)).toEqual([]);
    expect(toPool(undefined)).toEqual([]);
  });
});

describe('the pool records what was handed out, without inventing', () => {
  const entry = (over: Partial<SupplyLedgerWire> = {}): SupplyLedgerWire => ({
    kind: 'email',
    address: 'a@ormnes.com',
    source: 'email-ormnes',
    ...over,
  });

  test('a bound account reads as registered and an unbound one as pending', () => {
    expect(toPool([entry({ account: 'loomy-1', target: 'loomy' })])[0].state).toBe('registered');
    expect(toPool([entry()])[0].state).toBe('pending');
    expect(toPool([entry({ state: 'blacklisted' })])[0].state).toBe('failed');
    expect(toPool([entry({ state: 'released' })])[0].state).toBe('released');
  });

  test('a missing time stays empty instead of becoming "now"', () => {
    expect(toPool([entry()])[0].lastUsedAt).toBeNull();
    expect(toPool([entry({ last_used: 1_700_000_000 })])[0].lastUsedAt).toBe(
      new Date(1_700_000_000 * 1000).toISOString()
    );
  });

  test('the source travels with the identity, so it stays traceable', () => {
    expect(toPool([entry()])[0].source).toBe('email-ormnes');
  });
});

describe('the source surface keeps backend field names out of the components', () => {
  const components = [
    'features/sms/SupplyChannelCard.tsx',
    'features/sms/SupplyPoolCard.tsx',
    'features/sms/EmailSupplyView.tsx',
    'features/sms/PhoneSupplyView.tsx',
  ];

  test('the wire field names appear in the mapping module only', () => {
    const mapping = read('features/sms/smsMapping.ts');
    expect(mapping).toContain('secret_present');
    expect(mapping).toContain('last_used');
    for (const component of components) {
      const source = read(component);
      // The snake_case wire name is the tell: it must never reach a component.
      expect(source).not.toContain('secret_present');
      expect(source).not.toMatch(/\.\s*secret_present|raw\.\w+_/);
    }
  });

  test('a credential value never crosses the source surface', () => {
    // The card reports whether the named credential exists; it never reads a value.
    const source = read('features/sms/SupplyChannelCard.tsx');
    expect(source).toContain('secretPresent');
    expect(source).not.toMatch(/channel\.secret(Value|Plain)/);
  });

  test('the source card takes the natures it offers from the backend response', () => {
    const source = read('features/sms/SupplyChannelCard.tsx');
    expect(source).toContain('toNatureOptions(');
    expect(source).toContain('allowedNatures');
    // A hand-kept nature list would let the page offer one the host refuses.
    expect(source).not.toMatch(/\bnatures\s*=\s*\[\s*'api'/);
  });
});
