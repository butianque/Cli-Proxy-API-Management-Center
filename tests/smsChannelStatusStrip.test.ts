import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import { ChannelStatusStrip } from '../src/features/sms/ChannelStatusStrip';
import { formatReceivedAt } from '../src/features/sms/emailMapping';
import type { ChannelStatus, EmailMessage } from '../src/features/sms/types';

/**
 * The strip under a channel row is the only place a mailbox's numbers appear.
 * These render it for real (server-side markup) so the words are checked as
 * output, not as source text: a state that says the wrong thing is a bug the
 * operator reads, not a style preference.
 */

const render = (status: ChannelStatus, kind: 'email' | 'phone' = 'email') =>
  renderToStaticMarkup(createElement(ChannelStatusStrip, { kind, status }));

const message: EmailMessage = {
  channelId: 'ormnesqq',
  mailbox: 'INBOX',
  from: 'noreply@example.com',
  to: ['abc@ormnes.com'],
  subject: 'Your code',
  receivedAt: '2026-10-14T02:00:00.000Z',
  code: '552211',
  preview: 'Use 552211 to sign in.',
};

describe('a mailbox row states its own count and its own newest message', () => {
  test('the count, the sender and the code all appear', () => {
    const markup = render({
      kind: 'email',
      mailbox: 'box@qq.com',
      domain: 'ormnes.com',
      count: 3,
      windowHours: 72,
      latest: message,
    });
    // "3 in the last 3 days" — the window comes from the base, so 72h reads as
    // days rather than a number the reader has to divide.
    expect(markup).toContain(i18n.t('sms_service.row_email_window_days', { days: 3, n: 3 }));
    expect(markup).toContain('noreply@example.com');
    expect(markup).toContain(i18n.t('sms_service.row_email_code', { code: '552211' }));
    // The mailbox it reads is part of the row: two channels can share a domain.
    expect(markup).toContain('box@qq.com');
    expect(markup).toContain('@ormnes.com');
  });

  test('a window the base did not state is not turned into "3 days"', () => {
    const markup = render({
      kind: 'email',
      mailbox: 'box@qq.com',
      domain: '',
      count: 2,
      windowHours: 0,
      latest: null,
    });
    expect(markup).toContain(i18n.t('sms_service.row_email_count', { n: 2 }));
    expect(markup).not.toContain(i18n.t('sms_service.row_email_window_days', { days: 3, n: 2 }));
  });

  test('an empty mailbox says zero, and says nothing about a latest message', () => {
    const markup = render({
      kind: 'email',
      mailbox: 'box@qq.com',
      domain: 'ormnes.com',
      count: 0,
      windowHours: 72,
      latest: null,
    });
    expect(markup).toContain(i18n.t('sms_service.row_email_window_days', { days: 3, n: 0 }));
    expect(markup).not.toContain(i18n.t('sms_service.row_email_code', { code: '' }));
  });
});

describe('a row that could not be read says so', () => {
  test('the failure keeps its reason instead of reading as "no mail"', () => {
    // "No mail" sends the operator looking in the mailbox; "cannot read" sends
    // them to the credential. They are different next steps.
    const markup = render({ kind: 'error', message: 'search rejected' });
    expect(markup).toContain(i18n.t('sms_service.row_status_error', { message: 'search rejected' }));
    expect(markup).toContain('search rejected');
  });

  test('off, locked and missing-credential each have their own words', () => {
    const off = render({ kind: 'disabled' });
    const locked = render({ kind: 'locked' });
    const unreadyEmail = render({ kind: 'unready' }, 'email');
    const unreadyPhone = render({ kind: 'unready' }, 'phone');
    expect(off).toContain(i18n.t('sms_service.row_status_disabled'));
    expect(locked).toContain(i18n.t('sms_service.row_status_locked'));
    expect(unreadyEmail).toContain(i18n.t('sms_service.row_status_unready_email'));
    expect(unreadyPhone).toContain(i18n.t('sms_service.row_status_unready_phone'));
    // A switched-off row must not look like an empty one.
    expect(off).not.toContain(i18n.t('sms_service.row_status_loading'));
  });
});

describe('a phone row states the balance and what this channel took', () => {
  test('balance, count and the last use', () => {
    const markup = render(
      {
        kind: 'phone',
        balanceCny: 12.4,
        balanceError: '',
        taken: 3,
        latestAt: '2026-10-14T02:00:00.000Z',
      },
      'phone'
    );
    expect(markup).toContain(i18n.t('sms_service.row_phone_balance', { amount: '12.40' }));
    expect(markup).toContain(i18n.t('sms_service.row_phone_taken', { n: 3 }));
    // The instant is rendered in the reader's own locale and zone, so the
    // expectation comes from the same formatter rather than a fixed string.
    expect(markup).toContain(
      i18n.t('sms_service.row_phone_latest', { time: formatReceivedAt('2026-10-14T02:00:00.000Z') })
    );
  });

  test('an unreadable balance is stated, never shown as zero', () => {
    // "¥0.00" is a claim about the account. An unknown balance is not zero.
    const markup = render(
      {
        kind: 'phone',
        balanceCny: null,
        balanceError: 'balance endpoint timed out',
        taken: 0,
        latestAt: null,
      },
      'phone'
    );
    expect(markup).toContain(i18n.t('sms_service.row_phone_balance_unknown'));
    expect(markup).not.toContain('0.00');
    // The reason travels with it, so the tooltip is not empty.
    expect(markup).toContain('balance endpoint timed out');
  });

  test('the phone numbers are labelled as the platform\'s, not this channel\'s', () => {
    // The pool records the platform's own channel uid, not the supply channel
    // id, so a per-channel count would always be zero — a made-up number. The
    // phone kind has one platform credential, so the copy says so (pinned in
    // the locale test).
    const markup = render(
      { kind: 'phone', balanceCny: 1, balanceError: '', taken: 4, latestAt: null },
      'phone'
    );
    expect(markup).toContain(i18n.t('sms_service.row_phone_taken', { n: 4 }));
  });
});
