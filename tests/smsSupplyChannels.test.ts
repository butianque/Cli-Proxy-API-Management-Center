import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { toNatureOptions, toPool, toSupplyChannels } from '../src/features/sms/smsMapping';
import {
  channelDraftFromChannel,
  channelDraftToInput,
  kindBlockInput,
} from '../src/features/sms/channelDraft';
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

  test('the probe rides the channel route instead of a guessed one', () => {
    const api = read('services/api/supply.ts');
    expect(api).toContain('${SUPPLY_CHANNELS_BASE}/probe');
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
    'features/sms/SupplyPoolTable.tsx',
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

  test('the channel table takes the natures it offers from the backend response', () => {
    const table = read('features/sms/SupplyPoolTable.tsx');
    expect(table).toContain('toNatureOptions(');
    expect(table).not.toMatch(/\bnatures\s*=\s*\[\s*'api'/);
  });

  test('the connection and category labels have one home', () => {
    // They used to be copied per file. The credential modal, the channel table and
    // the editor all name the same concepts, so a copy is how the words drift apart.
    const mapping = read('features/sms/smsMapping.ts');
    expect(mapping).toContain('export const NATURE_LABEL');
    expect(mapping).toContain('export const CATEGORY_LABEL');
    // The list of selectable categories lives next to the labels for the same reason:
    // "what the table can render" and "what the editor can pick" must not drift.
    expect(mapping).toContain('export const CATEGORY_OPTIONS');
    for (const component of ['features/sms/SupplyPoolTable.tsx', 'features/sms/ChannelEditorModal.tsx']) {
      const source = read(component);
      expect(source).toContain('from \'./smsMapping\'');
      expect(source).not.toContain('const NATURE_LABEL');
      expect(source).not.toContain('const CATEGORY_LABEL');
      expect(source).not.toContain('const CATEGORY_OPTIONS');
    }
  });

  test('both categories are edited by the same component, differing only by kind', () => {
    const editor = read('features/sms/ChannelEditorModal.tsx');
    // The kind arrives as a prop; there is no second editor and no per-kind fork.
    expect(editor).toContain('kind: SupplyKind;');
    expect(editor).not.toContain('const editorKind');
    expect(editor).not.toContain("['phone', 'email']");
    // The methods offered still come from the backend's per-nature capability list.
    expect(editor).toContain('item.kinds.includes(kind)');
    expect(editor).toContain("nature === 'imap'");
    expect(editor).toContain("nature !== 'web'");
    // Both views open it.
    expect(read('features/sms/SupplyChannelCard.tsx')).toContain('ChannelEditorModal');
    expect(read('features/sms/PhoneSupplyView.tsx')).toContain('ChannelEditorModal');
  });

  test('the editor sections are localized and the phone credential is not a separate label', async () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'ko', 'vi']) {
      const messages = await Bun.file(`src/i18n/locales/${locale}.json`).json();
      for (const key of ['config_step_identity', 'config_step_natures', 'config_step_connection']) {
        expect(messages.sms_service[key]).toBeString();
        expect(messages.sms_service[key].trim()).not.toBe('');
      }
      // The phone card's heading is a product term, so every locale must carry it.
      expect(messages.sms_service.configured_title).toBeString();
      expect(messages.sms_service.configured_title.trim()).not.toBe('');
      expect(messages.sms_service.phone_credential).toBeUndefined();
    }
  });
});

describe('a draft submits the whole channel, never half of it', () => {
  // The backend replaces the whole channel on save, so a submit that carries only the
  // kind being edited silently deletes the other one.
  const both = (over: Partial<SupplyChannelWire> = {}) =>
    toSupplyChannels([
      channel({
        phone: {
          enabled: true,
          natures: ['api', 'web'],
          connections: { api: { secret: 'hz-key' }, web: { secret: 'web-key' } },
        },
        ...over,
      }),
    ])[0];

  test('editing one kind carries the other kind back unchanged', () => {
    const draft = channelDraftFromChannel(both());
    draft.label = 'Renamed';
    const input = channelDraftToInput(draft);
    expect(input.label).toBe('Renamed');
    expect(input.phone!.natures).toEqual(['api', 'web']);
    expect(input.phone!.connections.api!.secret).toBe('hz-key');
    expect(input.email!.connections.imap!.secret).toBe('imap-pass');
    expect(input.email!.connections.imap!.domain).toBe('ormnes.com');
  });

  test('a kind with no access method selected is omitted, not sent as an empty shell', () => {
    const input = channelDraftToInput(channelDraftFromChannel(toSupplyChannels([channel()])[0]));
    expect(input.phone).toBeUndefined();
    expect(input.email).toBeDefined();
  });

  test('the enable switch keeps the other kind and rewrites only its own flag', () => {
    const mapped = both();
    const input = kindBlockInput(mapped, 'phone', false);
    expect(input!.enabled).toBe(false);
    expect(input!.natures).toEqual(['api', 'web']);
    expect(input!.connections.api!.secret).toBe('hz-key');
    // The email block is untouched by the phone switch.
    expect(mapped.email!.connections.imap!.secret).toBe('imap-pass');
  });

  test('a disabled block survives an edit round-trip instead of being switched on', () => {
    const mapped = toSupplyChannels([
      channel({ email: { enabled: false, natures: ['imap'], connections: { imap: { account: 'me@qq.com' } } } }),
    ])[0];
    expect(channelDraftToInput(channelDraftFromChannel(mapped)).email!.enabled).toBe(false);
    expect(kindBlockInput(mapped, 'email', mapped.email!.enabled)!.enabled).toBe(false);
  });

  test('a blank field is trimmed, never sent as whitespace', () => {
    const draft = channelDraftFromChannel(both());
    draft.email.connections.imap!.account = '  me@qq.com  ';
    expect(channelDraftToInput(draft).email!.connections.imap!.account).toBe('me@qq.com');
  });
});
