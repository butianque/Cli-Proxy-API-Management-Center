import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { toNatureOptions, toPool, toSupplyChannels } from '../src/features/sms/smsMapping';
import type { SupplyChannelWire, SupplyLedgerWire } from '../src/services/api/supply';
import { SUPPLY_POOL_BASE } from '../src/services/api/supply';

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

const channel = (over: Partial<SupplyChannelWire> = {}): SupplyChannelWire => ({
  id: 'ormnes',
  label: 'Ormnes',
  category: 'self-built',
  email: {
    enabled: true,
    natures: ['imap'],
    connections: {
      imap: { account: 'me@qq.com', secret: 'imap-pass', usage: 'self-domain', domain: 'ormnes.com' },
    },
  },
  ...over,
});

describe('a source can serve one or both kinds with multiple natures', () => {
  test('the supply pool uses the pool endpoint', () => {
    expect(SUPPLY_POOL_BASE).toBe('/supply/pool');
    expect(read('services/api/supply.ts')).not.toContain('/supply/ledger');
  });

  test('a channel with email only maps correctly', () => {
    const mapped = toSupplyChannels([channel()])[0];
    expect(mapped.label).toBe('Ormnes');
    expect(mapped.category).toBe('self-built');
    expect(mapped.email).not.toBeNull();
    expect(mapped.email!.natures).toEqual(['imap']);
    expect(mapped.phone).toBeNull();
  });

  test('a channel with both kinds maps both blocks', () => {
    const mapped = toSupplyChannels([channel({
      phone: {
        enabled: true,
        natures: ['api', 'web'],
        connections: {
          api: { secret: 'hz-key' },
          web: { secret: 'web-key' },
        },
      },
    })])[0];
    expect(mapped.phone).not.toBeNull();
    expect(mapped.phone!.natures).toEqual(['api', 'web']);
    expect(mapped.email).not.toBeNull();
  });

  test('an absent optional connection field is empty, never undefined', () => {
    const mapped = toSupplyChannels([channel()])[0];
    const conn = mapped.email!.connections.imap!;
    expect(conn.endpoint).toBe('');
    expect(conn.account).toBe('me@qq.com');
    expect(conn.secret).toBe('imap-pass');
    expect(conn.secretPresent).toBe(false);
    expect(conn.usage).toBe('self-domain');
    expect(conn.domain).toBe('ormnes.com');
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
    expect(toNatureOptions(undefined)).toEqual([]);
    expect(toSupplyChannels(undefined)).toEqual([]);
    expect(toPool(undefined)).toEqual([]);
  });

  test('category defaults to third-party', () => {
    const mapped = toSupplyChannels([{ ...channel(), category: undefined }])[0];
    expect(mapped.category).toBe('third-party');
  });
});

describe('the pool records what was handed out, without inventing', () => {
  const entry = (over: Partial<SupplyLedgerWire> = {}): SupplyLedgerWire => ({
    kind: 'email',
    address: 'a@ormnes.com',
    source: 'ormnes',
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
    expect(toPool([entry()])[0].source).toBe('ormnes');
  });
});

describe('the source surface keeps backend field names out of the components', () => {
  const components = [
    'features/sms/SupplyChannelCard.tsx',
    'features/sms/SupplyPoolCard.tsx',
  ];

  test('the wire field names appear in the mapping module only', () => {
    const mapping = read('features/sms/smsMapping.ts');
    expect(mapping).toContain('secret_present');
    expect(mapping).toContain('last_used');
    for (const component of components) {
      const source = read(component);
      expect(source).not.toContain('secret_present');
    }
  });

  test('a credential value never crosses the source surface', () => {
    const source = read('features/sms/SupplyChannelCard.tsx');
    // The card mentions secretPresent only via the connection draft, never reads a raw value.
    expect(source).not.toMatch(/channel\.secret(Value|Plain)/);
  });

  test('the source card takes the natures it offers from the backend response', () => {
    const source = read('features/sms/SupplyChannelCard.tsx');
    expect(source).toContain('toNatureOptions(');
    expect(source).not.toMatch(/\bnatures\s*=\s*\[\s*'api'/);
  });

  test('the editor edits one kind and offers the connection methods that kind supports', () => {
    const editor = read('features/sms/ChannelEditorModal.tsx');
    // No category tabs: the editor edits the email block, so the email page cannot
    // build a phone block that nothing consumes.
    expect(editor).not.toContain("['phone', 'email']");
    expect(editor).toContain("const editorKind: SupplyKind = 'email'");
    // The methods offered still come from the backend's per-nature capability list.
    expect(editor).toContain('item.kinds.includes(editorKind)');
    expect(editor).toContain("nature === 'imap'");
    expect(editor).toContain("nature !== 'web'");
    expect(read('features/sms/SupplyChannelCard.tsx')).toContain('ChannelEditorModal');
  });

  test('the shared editor description is localized and phone credentials are not a separate label', async () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'ko', 'vi']) {
      const messages = await Bun.file(`src/i18n/locales/${locale}.json`).json();
      expect(messages.sms_service.config_editor_desc).toBeString();
      expect(messages.sms_service.config_editor_desc.trim()).not.toBe('');
      expect(messages.sms_service.phone_credential).toBeUndefined();
    }
  });
});
