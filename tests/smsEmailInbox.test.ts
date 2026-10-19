import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { SUPPLY_EMAIL_BASE } from '../src/services/api/email';
import {
  EMAIL_CATEGORY_OPTIONS,
  EMAIL_DEFAULT_NATURE,
  EMAIL_NATURES,
  PHONE_CATEGORY_OPTIONS,
  isCatchAllCategory,
} from '../src/features/sms/smsMapping';
import {
  formatReceivedAt,
  toInboxReading,
  toInboxStatus,
  toMailboxes,
  toMessages,
  toReceivedAt,
} from '../src/features/sms/emailMapping';

/**
 * The email category reads real mail from a real mailbox. These checks pin the
 * three things that decide whether the page can be trusted:
 *
 * 1. the panel talks to the base's own email routes;
 * 2. backend field names stop at the mapping module;
 * 3. nothing on the page invents a message, a code, or a timestamp.
 */

const read = (path: string) =>
  readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

describe('the email category reads the base supply routes', () => {
  test('the base prefix matches the backend mount point', () => {
    // Mirrors server_management_v8.go: v8.GET("/supply/email/status", ...) etc.
    expect(SUPPLY_EMAIL_BASE).toBe('/supply/email');
  });

  test('the api module calls every email route under the base prefix', () => {
    const api = read('services/api/email.ts');
    for (const route of ['status', 'inbox', 'credential']) {
      expect(api).toContain('${SUPPLY_EMAIL_BASE}/' + route);
    }
  });
});

describe('mailbox normalisation', () => {
  test('a configured mailbox keeps only what the page shows', () => {
    const [box] = toMailboxes([
      {
        channel_id: 'qq',
        label: 'QQ 邮箱',
        mailbox: 'box@qq.com',
        host: 'imap.qq.com:993',
        domain: 'ormnes.com',
        usage: 'self-domain',
        secret_name: 'qq-mail',
        has_credential: true,
      },
    ]);
    expect(box).toEqual({
      channelId: 'qq',
      label: 'QQ 邮箱',
      mailbox: 'box@qq.com',
      host: 'imap.qq.com:993',
      domain: 'ormnes.com',
      usage: 'self-domain',
      secretName: 'qq-mail',
      hasCredential: true,
    });
  });

  test('an unknown usage is reported as a personal mailbox, not a catch-all', () => {
    // Claiming a domain the operator did not configure would make the page
    // promise addresses that cannot be received.
    const [box] = toMailboxes([{ usage: 'whatever' }]);
    expect(box.usage).toBe('personal');
  });

  test('a missing field becomes empty rather than undefined', () => {
    const [box] = toMailboxes([{}]);
    expect(box.mailbox).toBe('');
    expect(box.hasCredential).toBe(false);
  });
});

describe('message normalisation', () => {
  test('a message carries its code and its recipients', () => {
    const [mail] = toMessages([
      {
        mailbox: 'INBOX',
        from: 'noreply@example.com',
        to: ['abc@ormnes.com'],
        subject: 'Your code: 552211',
        received_at: '2026-10-14T02:00:00Z',
        code: '552211',
        preview: 'Use 552211 to sign in.',
      },
    ]);
    expect(mail.code).toBe('552211');
    expect(mail.to).toEqual(['abc@ormnes.com']);
    expect(mail.receivedAt).toBe('2026-10-14T02:00:00.000Z');
  });

  test('a message with no code is kept, because it still arrived', () => {
    // "The mail arrived but carried no code" and "the mail never arrived" send
    // the operator looking in two different places.
    const [mail] = toMessages([{ subject: 'Welcome', code: '' }]);
    expect(mail.subject).toBe('Welcome');
    expect(mail.code).toBe('');
  });

  test('an unparseable date is null, never the current instant', () => {
    expect(toReceivedAt('not a date')).toBeNull();
    expect(toReceivedAt('')).toBeNull();
    expect(toReceivedAt(undefined)).toBeNull();
    expect(formatReceivedAt(null)).toBe('');
  });

  test('blank recipients are dropped instead of rendering empty cells', () => {
    const [mail] = toMessages([{ to: ['abc@ormnes.com', '  ', ''] }]);
    expect(mail.to).toEqual(['abc@ormnes.com']);
  });
});

describe('inbox reading state', () => {
  test('no configured mailbox is its own state, not an error', () => {
    const status = toInboxStatus({ enabled: false, locked: false, channels: [] });
    expect(status.configured).toBe(false);
    expect(status.locked).toBe(false);
  });

  test('a locked credential store is reported as locked, not as missing', () => {
    const status = toInboxStatus({
      enabled: true,
      locked: true,
      channels: [{ mailbox: 'box@qq.com', has_credential: true }],
    });
    expect(status.configured).toBe(true);
    expect(status.locked).toBe(true);
    expect(status.mailboxes).toHaveLength(1);
  });

  test('each mailbox reports its own count and its own newest message', () => {
    // One channel row shows one mailbox's numbers. Merging mailboxes into a
    // single "3 messages" is exactly the thing the row cannot answer.
    const reading = toInboxReading({
      window_hours: 72,
      mailboxes: [
        {
          channel_id: 'ormnesqq',
          mailbox: 'box@qq.com',
          domain: 'ormnes.com',
          count: 2,
          latest: {
            channel_id: 'ormnesqq',
            from: 'noreply@example.com',
            code: '552211',
            received_at: '2026-10-14T02:00:00Z',
          },
        },
      ],
    });
    expect(reading.windowHours).toBe(72);
    expect(reading.mailboxes[0].channelId).toBe('ormnesqq');
    expect(reading.mailboxes[0].count).toBe(2);
    expect(reading.mailboxes[0].latest?.code).toBe('552211');
  });

  test('a mailbox that could not be read keeps its reason', () => {
    // "Could not read" rendered as "no mail" sends the operator looking for
    // mail in a mailbox that was never opened.
    const reading = toInboxReading({
      mailboxes: [{ channel_id: 'qq', error: 'search rejected' }],
    });
    expect(reading.mailboxes[0].error).toBe('search rejected');
    expect(reading.mailboxes[0].count).toBe(0);
    expect(reading.mailboxes[0].latest).toBeNull();
  });

  test('a window the backend did not state is zero, never a guessed one', () => {
    expect(toInboxReading({}).windowHours).toBe(0);
    expect(toInboxReading(undefined).mailboxes).toEqual([]);
  });

  test('a message knows which mailbox carried it', () => {
    const [mail] = toMessages([{ channel_id: 'ormnesqq', subject: 'hi' }]);
    expect(mail.channelId).toBe('ormnesqq');
  });
});

describe('each channel row carries its own mail and balance', () => {
  test('the status strip reads through the domain api modules', () => {
    const source = read('features/sms/useChannelStatus.ts');
    expect(source).toContain("from '@/services/api/email'");
    expect(source).toContain("from '@/services/api/sms'");
    expect(source).toContain('emailApi.getInbox');
    expect(source).toContain('smsApi.getStatus');
    // Backend field names belong to the mapping module.
    expect(source).not.toContain('received_at');
    expect(source).not.toContain('channel_id');
  });

  test('the strip is the second line of the row it belongs to', () => {
    // Not a card below the table, not a drawer: the numbers sit under the
    // channel they describe, in the same table.
    const table = read('features/sms/SupplyPoolTable.tsx');
    expect(table).toContain('<ChannelStatusStrip');
    expect(table).toContain('<TableCell colSpan={7}>');
    expect(table).toContain('styles.stripRow');
    expect(table).toContain('useChannelStatus(kind, channels, reloadKey)');
  });

  test('there is no separate inbox view to wonder about', () => {
    // The mailbox category has exactly one entry: Settings → Email. What
    // arrived is a property of a channel, not a page of its own.
    const page = read('features/sms/SmsServicePage.tsx');
    expect(page).not.toContain('EmailInboxCard');
    expect(page).not.toContain("'inbox'");
    expect(page).toContain("type PageView = 'pool' | 'config'");
  });

  test('saving a channel makes its row re-read', () => {
    // Configure, then look at the row: without the bump the row you just
    // filled in still says "no authorization code yet" until a page reload.
    const card = read('features/sms/SupplyChannelCard.tsx');
    expect(card).toContain('setReloadKey((key) => key + 1)');
    const hook = read('features/sms/useChannelStatus.ts');
    expect(hook).toContain('reloadKey');
  });

  test('a row that is switched off or locked says so instead of showing nothing', () => {
    // "Nothing to show" and "this is off" are different answers; an empty
    // strip would read as the first one.
    const hook = read('features/sms/useChannelStatus.ts');
    expect(hook).toContain("kind: 'disabled'");
    expect(hook).toContain("kind: 'locked'");
    expect(hook).toContain("kind: 'unready'");
  });

  test('the authorization code is written as a password and never kept', () => {
    const editor = read('features/sms/ChannelEditorModal.tsx');
    expect(editor).toContain('emailApi.saveCredential');
    expect(editor).toContain('type="password"');
    // The value goes to the credential route; the channel payload keeps only
    // the entry name, so the code must not be part of the saved draft.
    expect(editor).not.toContain('mailAuthCode:');
  });

  test('nobody is asked to name the authorization code', () => {
    // 授权码属于那个邮箱，不属于这条渠道：条目名由账号派生，界面上不该再出现
    // 一个「给密码起名字」的框 —— 它对使用者没有意义，还容易和值填反。
    const editor = read('features/sms/ChannelEditorModal.tsx');
    expect(editor).not.toContain('source_field_secret');
    expect(editor).not.toContain('source_ph_secret');
    expect(editor).toContain("account: (mailConnection?.account ?? '').trim()");
  });
});

describe('the category is what says "a domain of my own that catches everything"', () => {
  test('only a self-built domain can mint addresses', () => {
    // A mailbox of my own is mine, but it is still one address. Merging it with
    // a self-built domain would promise addresses that can never arrive.
    expect(isCatchAllCategory('self-built')).toBe(true);
    expect(isCatchAllCategory('self-owned')).toBe(false);
    expect(isCatchAllCategory('third-party')).toBe(false);
    expect(isCatchAllCategory('')).toBe(false);
  });

  test('a mailbox offers three categories, and each says something different', () => {
    expect([...EMAIL_CATEGORY_OPTIONS]).toEqual(['third-party', 'self-built', 'self-owned']);
  });

  test('a phone channel offers only a third-party service for now', () => {
    // Every number a receiving platform hands out comes from someone else's
    // service; offering two more answers that change nothing is a dead choice.
    expect([...PHONE_CATEGORY_OPTIONS]).toEqual(['third-party']);
    const editor = read('features/sms/ChannelEditorModal.tsx');
    // No select at all for phone: a one-option dropdown cannot change anything.
    expect(editor).toContain('{kind === \'email\' ? (');
    expect(editor).toContain("t(CATEGORY_LABEL[phoneCategory])");
  });

  test('a mailbox connects one way: an authorization code, OAuth2, or Graph', () => {
    // All three read the same mailbox; they differ in which route the credential
    // buys. Offering them as checkboxes would let an operator tick two — a record
    // the base refuses, because one mailbox holds one credential.
    //
    // OAuth2 and Graph are the same refresh token spent on two different
    // resources, so both are offered: a token is granted one route, and the
    // operator's answer is which one it was.
    expect([...EMAIL_NATURES]).toEqual(['imap', 'oauth2', 'graph']);
    expect(EMAIL_DEFAULT_NATURE).toBe('imap');
    const editor = read('features/sms/ChannelEditorModal.tsx');
    expect(editor).toContain('type="radio"');
    expect(editor).toContain('name="sms-email-nature"');
  });

  test('the editor does not ask for a usage the backend derives', () => {
    // Asking twice produces two answers; when they disagree nobody can say which
    // one the base follows.
    const editor = read('features/sms/ChannelEditorModal.tsx');
    expect(editor).not.toContain('usage_self_domain');
    expect(editor).not.toContain('usage_personal');
    expect(editor).toContain('isCatchAllCategory');
    // The domain field appears because of the category, not because of a switch.
    expect(editor).toContain('{catchAll && (');
  });

  test('the submit body no longer carries a usage', () => {
    const draft = read('features/sms/channelDraft.ts');
    expect(draft).not.toContain('usage');
  });

  test('the IMAP field is labelled as a mail server, not as a URL', () => {
    // An https placeholder in an IMAP field is an instruction to type the wrong
    // thing; the field then fails validation for a reason the operator cannot see.
    const editor = read('features/sms/ChannelEditorModal.tsx');
    expect(editor).toContain('imap.qq.com:993');
    expect(editor).toContain("t('sms_service.source_field_imap_host')");
  });

  test('the mailbox category offers only the methods that are implemented', () => {
    // The base accepts email/api but implements only the mailbox readers;
    // offering the checkbox builds a channel that can never connect.
    const editor = read('features/sms/ChannelEditorModal.tsx');
    expect(editor).toContain('EMAIL_NATURES');
    expect(editor).toContain("kind !== 'email' || EMAIL_NATURES.includes(item.nature)");
  });
});

describe('every locale can say the channel-row words', () => {
  const locales = ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko'];
  const keys = [
    'row_status_loading',
    'row_status_disabled',
    'row_status_locked',
    'row_status_unready_email',
    'row_status_unready_phone',
    'row_status_error',
    'row_status_error_unknown',
    'row_email_window_days',
    'row_email_window_hours',
    'row_email_count',
    'row_email_latest',
    'row_email_code',
    'row_phone_balance',
    'row_phone_balance_unknown',
    'row_phone_taken',
    'row_phone_latest',
    'field_mail_auth_code',
    'field_mail_auth_code_hint',
    'nature_oauth2',
    'field_mail_client_id',
    'field_mail_client_id_hint',
    'field_mail_refresh_token',
    'field_mail_refresh_token_hint',
    'source_field_imap_host',
    'source_hint_imap_host',
    'source_field_mail_account',
    'source_ph_mail_account',
    'email_lead_self_hosted',
    'field_domain',
    'source_ph_domain',
    'source_hint_domain',
    'source_ph_category',
    'source_err_category',
    'category_phone_note',
    'config_email_nature_note',
  ];

  test('all six locales define the same channel-row keys', () => {
    for (const locale of locales) {
      const bundle = JSON.parse(
        readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8')
      ) as { sms_service?: Record<string, unknown> };
      for (const key of keys) {
        const value = bundle.sms_service?.[key];
        expect(typeof value).toBe('string');
        expect(String(value).trim()).not.toBe('');
      }
    }
  });

  test('the phone count says it is the platform\'s, in every locale', () => {
    // The pool records the platform's own channel uid, so a number cannot be
    // attributed to one supply channel; the copy has to say where it comes from
    // or the row implies something the data does not support.
    const platformWord = /平台|Platform|платформ|Nền tảng|플랫폼/;
    for (const locale of locales) {
      const bundle = JSON.parse(
        readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8')
      ) as { sms_service?: Record<string, unknown> };
      const value = String(bundle.sms_service?.row_phone_taken ?? '');
      expect(value).toMatch(platformWord);
      expect(value).toContain('{{n}}');
    }
  });
});
