import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import { ChannelStatusStrip } from '../src/features/sms/ChannelStatusStrip';
import { formatReceivedAt } from '../src/features/sms/emailMapping';
import type { ChannelStatus, EmailMessage } from '../src/features/sms/types';

/**
 * The strip under a channel row is where a channel's own numbers appear. These
 * render it for real (server-side markup) so the words are checked as output,
 * not as source text: a state that says the wrong thing is a bug the operator
 * reads, not a style preference.
 */

const render = (status: ChannelStatus, kind: 'email' | 'phone' = 'email', pooled?: number) =>
  renderToStaticMarkup(createElement(ChannelStatusStrip, { kind, status, pooled }));

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

describe('a channel row leads with what it contributed to the pool', () => {
  test('the count is stated for the kind this row shows', () => {
    const markup = render(
      { kind: 'email', mailbox: 'box@qq.com', domain: 'ormnes.com', latest: null },
      'email',
      3
    );
    expect(markup).toContain(i18n.t('sms_service.row_pooled_email', { n: 3 }));
  });

  test('zero is a counted answer, so it is said out loud', () => {
    const markup = render(
      { kind: 'phone', balanceCny: 1, balanceError: '', latestAt: null },
      'phone',
      0
    );
    expect(markup).toContain(i18n.t('sms_service.row_pooled_phone', { n: 0 }));
  });

  test('a count the base could not produce is left out, never shown as zero', () => {
    const markup = render(
      { kind: 'phone', balanceCny: 1, balanceError: '', latestAt: null },
      'phone'
    );
    expect(markup).not.toContain(i18n.t('sms_service.row_pooled_phone', { n: 0 }));
    expect(markup).toContain(i18n.t('sms_service.row_phone_balance', { amount: '1.00' }));
  });

  test('a row whose platform reading failed still states its count', () => {
    // The count is a ledger fact, not a platform reading: a locked store does not
    // make it unknown, and hiding it would leave the operator with less than the
    // base knows.
    const markup = render({ kind: 'locked' }, 'phone', 2);
    expect(markup).toContain(i18n.t('sms_service.row_pooled_phone', { n: 2 }));
    expect(markup).toContain(i18n.t('sms_service.row_status_locked'));
  });
});

describe('a mailbox row states its own newest message', () => {
  test('the sender and the code appear', () => {
    const markup = render({
      kind: 'email',
      mailbox: 'box@qq.com',
      domain: 'ormnes.com',
      latest: message,
    });
    expect(markup).toContain('noreply@example.com');
    expect(markup).toContain(i18n.t('sms_service.row_email_code', { code: '552211' }));
    // The mailbox it reads is part of the row: two channels can share a domain.
    expect(markup).toContain('box@qq.com');
    expect(markup).toContain('@ormnes.com');
  });

  test('an empty mailbox says nothing about a latest message', () => {
    const markup = render({
      kind: 'email',
      mailbox: 'box@qq.com',
      domain: 'ormnes.com',
      latest: null,
    });
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

describe('a phone row states the platform balance and the last use', () => {
  test('balance and the last use', () => {
    const markup = render(
      {
        kind: 'phone',
        balanceCny: 12.4,
        balanceError: '',
        latestAt: '2026-10-14T02:00:00.000Z',
      },
      'phone'
    );
    expect(markup).toContain(i18n.t('sms_service.row_phone_balance', { amount: '12.40' }));
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
        latestAt: null,
      },
      'phone'
    );
    expect(markup).toContain(i18n.t('sms_service.row_phone_balance_unknown'));
    expect(markup).not.toContain('0.00');
    // The reason travels with it, so the tooltip is not empty.
    expect(markup).toContain('balance endpoint timed out');
  });
});
