import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  SMS_PLATFORMS,
  identityState,
  projectLabel,
  projectSite,
  resolvePlatformId,
  toMailboxProbes,
  toNatureOptions,
  toPool,
  toSupplyChannels,
} from '../src/features/sms/smsMapping';
import {
  channelDraftFromChannel,
  channelDraftToInput,
  kindBlockInput,
  platformNatures,
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
      imap: { account: 'me@qq.com', secret: 'imap-pass', domain: 'ormnes.com' },
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

  test('a mailbox identity carries its own receiving method', () => {
    // A mailbox imported on its own reads mail with its own credential, so the
    // row has to say how — there is no channel to ask.
    const mapped = toPool([
      entry({
        channel_id: '',
        mailbox: { nature: 'graph', endpoint: '', has_credential: true, has_password: true },
      }),
    ])[0];
    expect(mapped.mailbox).toEqual({ nature: 'graph', endpoint: '', hasCredential: true });
    // A channel identity has none: it reads mail through the channel.
    expect(toPool([entry({ channel_id: 'ormnes' })])[0].mailbox).toBeNull();
  });

  test('the pool row names an imported mailbox by its origin, not by a channel', () => {
    // An imported mailbox has no channel, so the source cell must say where it
    // came from instead of falling back to "—" as if the record were incomplete.
    const card = read('features/sms/SupplyPoolCard.tsx');
    expect(card).toContain('identityState');
    expect(card).toContain("t('sms_service.pool_origin_import')");
    expect(card).toContain('NATURE_LABEL[mailbox.nature]');
  });

  test('the pool card separates the kind of identity from the channel it came from', () => {
    // The category cell answers "phone or mailbox", which is a property of the
    // identity. The channel's own category (third-party / self-built) belongs to
    // the channel table; repeating it here would make one word mean two things.
    const card = read('features/sms/SupplyPoolCard.tsx');
    expect(card).not.toContain('CATEGORY_LABEL');
    expect(card).toContain("t('sms_service.ledger_col_channel')");
    expect(card).toContain("t('sms_service.ledger_col_source')");
    expect(card).toContain("'sms_service.tab_phone'");
    expect(card).toContain("'sms_service.tab_email'");
  });

  test('the source cell shows the line inside the channel, not the platform', () => {
    // 豪猪's 对接码 is what says which line a number came from; the channel name
    // alone cannot. The mailbox kind records the domain instead.
    expect(toPool([entry({ kind: 'phone', meta: { channel: '21614-a' } })])[0].sourceDetail).toBe(
      '21614-a'
    );
    expect(toPool([entry({ meta: { domain: 'ormnes.com' } })])[0].sourceDetail).toBe('ormnes.com');
    // A kind never borrows the other kind's key.
    expect(toPool([entry({ kind: 'phone', meta: { domain: 'ormnes.com' } })])[0].sourceDetail).toBe(
      ''
    );
    expect(toPool([entry()])[0].sourceDetail).toBe('');
  });

  test('the pool card re-reads when an import finishes', () => {
    // The table loads once on mount; an import happens elsewhere on the page.
    expect(read('features/sms/SupplyPoolCard.tsx')).toContain('reloadKey');
  });

  test('a channel identity is online, offline or unknown — never "credential ready"', () => {
    // Online: at least one declared nature answered. A phone number only needs
    // its API to take a code, so a dead web login does not make it unusable.
    expect(identityState(null, ['api', 'web'], { api: 'online', web: 'offline' }).key).toBe(
      'sms_service.pool_state_online'
    );
    expect(identityState(null, ['imap'], { imap: 'offline' }).key).toBe(
      'sms_service.pool_state_offline'
    );
    // Never probed, no nature declared, or the probe could not run: unknown.
    expect(identityState(null, ['imap'], undefined).key).toBe('sms_service.pool_state_unknown');
    expect(identityState(null, ['imap'], { imap: 'unready' }).key).toBe(
      'sms_service.pool_state_unknown'
    );
    expect(identityState(null, [], { imap: 'online' }).key).toBe('sms_service.pool_state_unknown');
  });

  test('a mailbox identity reports what a connection said, not what its credential implies', () => {
    const mailbox = { nature: 'imap', endpoint: '', hasCredential: true } as const;
    // Having the credential only means it could connect; nothing has connected
    // yet. Claiming "online" here would be fabricated.
    expect(identityState(mailbox, [], undefined).key).toBe('sms_service.pool_state_unknown');
    // A probe that reached the mailbox is the one thing that may say online.
    expect(identityState(mailbox, [], undefined, { state: 'online', detail: '' }).key).toBe(
      'sms_service.pool_state_online'
    );
    // A mailbox that answered and refused the login cannot receive mail: offline,
    // and the reason travels with the state so the operator knows what to fix.
    const offline = identityState(mailbox, [], undefined, {
      state: 'offline',
      detail: 'email: the mailbox rejected the login',
    });
    expect(offline.key).toBe('sms_service.pool_state_offline');
    expect(offline.detail).toContain('rejected');
    // A credential that could not be read was never tried, so it is still
    // unknown: saying offline would send someone to replace a working account.
    expect(identityState(mailbox, [], undefined, { state: 'unready', detail: 'locked' }).key).toBe(
      'sms_service.pool_state_unknown'
    );
    // A locked key store cannot tell whether the credential is there, so it is
    // not "missing" either.
    expect(identityState({ nature: 'imap', endpoint: '', hasCredential: null }, [], undefined).key).toBe(
      'sms_service.pool_state_unknown'
    );
    // A credential that is definitely gone cannot authenticate: offline.
    expect(identityState({ nature: 'imap', endpoint: '', hasCredential: false }, [], undefined).key).toBe(
      'sms_service.pool_state_offline'
    );
  });

  test('an address probe is looked up by address, and an unreadable answer is dropped', () => {
    const probes = toMailboxProbes([
      { address: 'Yundxr60804@Outlook.com', state: 'online', detail: 'connected, 3 mailboxes' },
      { address: 'abc@ormnes.com', state: 'offline', detail: 'no configured mailbox receives this address' },
      // A state the backend does not declare is not guessed into a verdict.
      { address: 'weird@ormnes.com', state: 'maybe' },
      // An answer with no address belongs to no row, so it is not applied to one.
      { state: 'online' },
    ]);
    expect(probes.get('yundxr60804@outlook.com')?.state).toBe('online');
    expect(probes.get('abc@ormnes.com')?.detail).toContain('no configured mailbox');
    expect(probes.has('weird@ormnes.com')).toBe(false);
    expect(probes.size).toBe(2);
  });

  test('the pool card probes an imported mailbox itself, not a channel it does not have', () => {
    // An imported address has no channel, so asking one would answer about a
    // different mailbox. The card has to ask the address's own mailbox.
    const card = read('features/sms/SupplyPoolCard.tsx');
    expect(card).toContain('emailApi.probeAddresses');
    expect(card).toContain('mailboxProbes.get');
  });

  test('every registration on an identity is kept, one per project and account', () => {
    const mapped = toPool([
      entry({
        channel_id: 'ormnes',
        projects: [
          { target: 'loomy', account: 'loomy-16723433586', outcome: 'registered', at: 1_700_000_000 },
          { target: 'zcode-zai', account: 'zcode-zai-0f101ea3', outcome: 'registered', at: 1_700_000_100 },
        ],
      }),
    ])[0];
    expect(mapped.channelId).toBe('ormnes');
    expect(mapped.projects).toHaveLength(2);
    expect(mapped.projects[0]).toEqual({
      target: 'loomy',
      account: 'loomy-16723433586',
      state: 'registered',
      registeredAt: new Date(1_700_000_000 * 1000).toISOString(),
    });
    expect(mapped.projects[1].target).toBe('zcode-zai');
  });

  test('a registration without a project or an account is not a registration', () => {
    const mapped = toPool([entry({ projects: [{ outcome: 'registered' }, {}] })])[0];
    expect(mapped.projects).toEqual([]);
  });

  test('a registration with no time stays empty instead of becoming "now"', () => {
    const mapped = toPool([entry({ projects: [{ target: 'loomy', account: 'loomy-1' }] })])[0];
    expect(mapped.projects[0].registeredAt).toBeNull();
    expect(mapped.projects[0].state).toBe('pending');
  });

  test('an identity with no registrations reports none, so nothing is invented', () => {
    expect(toPool([entry()])[0].projects).toEqual([]);
    expect(toPool([entry()])[0].channelId).toBe('');
  });
});

describe('a project shows the name the credentials page already uses', () => {
  const en = JSON.parse(read('i18n/locales/en.json')) as Record<string, unknown>;
  // i18next 用 `.` 分段取键；这里照它的规则取，缺键就原样返回键名（与 i18next 一致）。
  const translate = (key: string) => {
    let node: unknown = en;
    for (const part of key.split('.')) {
      if (typeof node !== 'object' || node === null) return key;
      node = (node as Record<string, unknown>)[part];
    }
    return typeof node === 'string' ? node : key;
  };

  test('a known platform resolves to the product name the credentials page shows', () => {
    // 站点键在凭据页显示产品名（Z.ai / WorkBuddy），台账不能另起一个名字。
    expect(projectLabel('zcode-zai', translate)).toBe('Z.ai');
    expect(projectLabel('workbuddy-global', translate)).toBe('WorkBuddy');
  });

  test('an unknown platform falls back to the raw id, never to an invented name', () => {
    expect(projectLabel('loomy', translate)).toBe('Loomy');
    expect(projectLabel('', translate)).toBe('');
  });

  test('the site comes from the same table the credential card reads', () => {
    // 台账说「这个号注册在哪个站点」，卡片说「这张凭证属于哪个站点」——同一件事，
    // 必须查同一张表，否则同一个号在两个页面上会显示成两个站点。
    expect(projectSite('workbuddy-global')).toEqual({
      brand: 'WorkBuddy',
      region: 'intl',
      domain: 'workbuddy.ai',
    });
    expect(projectSite('zcode-zai')?.domain).toBe('z.ai');
    expect(projectSite('zcode-bigmodel')).toMatchObject({ region: 'cn', domain: 'bigmodel.cn' });
  });

  test('a platform with no single site domain shows its name, not a borrowed domain', () => {
    // loomy 的模型在 loomyad.xunfei.cn、账号在 account.xfinfr.com，没有单一站点域名。
    // 填任何一个都是把内部接口当站点；它只有一个注册通道，域名也不承担区分作用。
    expect(projectSite('loomy')).toBeNull();
    expect(projectSite('')).toBeNull();
  });

  test('the registration strip names the site and the outcome, not a raw key', () => {
    const card = read('features/sms/SupplyPoolCard.tsx');
    expect(card).toContain('projectSite');
    expect(card).toContain('auth_files.region_');
    expect(card).toContain('site.domain');
    // 模板串「{{project}}：{{state}}」不再使用：站点、结果、凭证名各占一格。
    expect(card).not.toContain('ledger_project');
  });

  test('every identity carries a strip, so an unused one says so', () => {
    // 一个刚导进来还没用过的号，如果整条带都不画，看起来就是「面板没做这一块」。
    const card = read('features/sms/SupplyPoolCard.tsx');
    expect(card).toContain('ledger_unused');
    expect(card).not.toContain('hasStrip');
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
    // The lists of selectable categories live next to the labels for the same reason:
    // "what the table can render" and "what the editor can pick" must not drift.
    expect(mapping).toContain('export const PHONE_CATEGORY_OPTIONS');
    expect(mapping).toContain('export const EMAIL_CATEGORY_OPTIONS');
    for (const component of ['features/sms/SupplyPoolTable.tsx', 'features/sms/ChannelEditorModal.tsx']) {
      const source = read(component);
      expect(source).toContain('from \'./smsMapping\'');
      expect(source).not.toContain('const NATURE_LABEL');
      expect(source).not.toContain('const CATEGORY_LABEL');
      expect(source).not.toContain('const PHONE_CATEGORY_OPTIONS');
      expect(source).not.toContain('const EMAIL_CATEGORY_OPTIONS');
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
    // Email then keeps the one method a channel can speak; a mailbox with its own
    // credential is imported into the pool instead.
    expect(editor).toContain('EMAIL_DEFAULT_NATURE');
    expect(editor).not.toContain('EMAIL_NATURES');
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

describe('the editor resolves one platform, and only a preset can name a channel', () => {
  test('an explicit pick outranks the stored credential', () => {
    expect(resolvePlatformId('custom', 'haozhuma')).toBe('custom');
    expect(resolvePlatformId('haozhuma', 'custom')).toBe('haozhuma');
  });

  test('without a pick the stored credential decides', () => {
    // 手机号这一类只有一份平台凭据，渠道记录只指名它 —— 界面显示的必须是它所属的那个。
    expect(resolvePlatformId(null, 'custom')).toBe('custom');
    expect(resolvePlatformId(null, 'haozhuma')).toBe('haozhuma');
  });

  test('a credential that matches no platform falls back to the built-in one', () => {
    expect(resolvePlatformId(null, undefined)).toBe(SMS_PLATFORMS[0].id);
    expect(resolvePlatformId(null, '')).toBe(SMS_PLATFORMS[0].id);
    expect(resolvePlatformId(null, 'nope')).toBe(SMS_PLATFORMS[0].id);
  });

  test('only a preset platform can name a channel by itself', () => {
    // 「自定义」不是一个能当渠道名用的词，所以它不能自带名字 —— 使用者必须自己起。
    expect(SMS_PLATFORMS.filter((item) => item.preset).map((item) => item.id)).toEqual(['haozhuma']);
    expect(SMS_PLATFORMS.find((item) => !item.preset)?.id).toBe('custom');
  });

  test('a preset platform declares the facts the operator would otherwise retype', () => {
    // 平台卡片上写着「用 API 接入取号，用网页登录管理渠道」，且它是第三方服务 ——
    // 这两条都是平台已知的事实，声明在平台清单里，编辑器据此带出默认值。
    const builtIn = SMS_PLATFORMS.find((item) => item.id === 'haozhuma')!;
    expect(builtIn.defaultCategory).toBe('third-party');
    expect(builtIn.defaultNatures).toEqual(['api', 'web']);

    // 「自定义」什么都不已知：连协议都不确定，不能替它声明。
    const custom = SMS_PLATFORMS.find((item) => item.id === 'custom')!;
    expect(custom.defaultCategory).toBeUndefined();
    expect(custom.defaultNatures).toBeUndefined();
  });

  test('the platform defaults are narrowed to the methods this kind really supports', () => {
    // 后端 `natures` 才是权威：平台声明的能力与它不一致时，取交集，绝不勾一个后端不认的方式。
    expect([...platformNatures(['api', 'web'], ['api', 'web'])].sort()).toEqual(['api', 'web']);
    expect([...platformNatures(['api', 'web'], ['api'])]).toEqual(['api']);
    expect([...platformNatures(['api', 'web'], [])]).toEqual([]);
    expect([...platformNatures(['api', 'web'], ['imap', 'api'])]).toEqual(['api']);
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

  test('an OAuth2 mailbox carries its application id through the draft and back', () => {
    // The application id is not a secret — the refresh token is — so it lives on
    // the channel and the editor shows it again. Dropping it on save would leave
    // a channel that can never mint a token.
    const mapped = toSupplyChannels([
      channel({
        email: {
          enabled: true,
          natures: ['oauth2'],
          connections: {
            oauth2: {
              endpoint: 'outlook.office365.com:993',
              account: 'box@outlook.com',
              client_id: 'app-123',
              secret: 'email-oauth2-box@outlook.com',
            },
          },
        },
      }),
    ])[0];
    const draft = channelDraftFromChannel(mapped);
    expect(draft.email.connections.oauth2!.clientId).toBe('app-123');
    const input = channelDraftToInput(draft);
    expect(input.email!.natures).toEqual(['oauth2']);
    expect(input.email!.connections.oauth2!.client_id).toBe('app-123');
    // The password login must not inherit an id that belongs to another method.
    expect(input.email!.connections.imap).toBeUndefined();
  });
});
