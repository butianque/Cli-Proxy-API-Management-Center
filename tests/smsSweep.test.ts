import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  PROBE_CHUNK_SIZE,
  canReauthorize,
  chunkAddresses,
  classifyOffline,
  isSweepCandidate,
  sharedOfflineDetail,
  sweepAddresses,
  type OfflineMailbox,
} from '../src/features/sms/sweepOffline';
import type { MailboxProbe, PoolEntry, SupplyNature } from '../src/features/sms/types';

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

const card = read('features/sms/SupplyPoolCard.tsx');
const modal = read('features/sms/SweepOfflineModal.tsx');
const page = read('features/sms/SmsServicePage.tsx');
const supplyApi = read('services/api/supply.ts');

/** 一个自带凭据的邮箱身份：扫活只检查这一种。 */
function entry(
  identity: string,
  nature: SupplyNature | null,
  hasCredential: boolean | null = true,
  overrides: Partial<PoolEntry> = {}
): PoolEntry {
  return {
    kind: 'email',
    identity,
    domain: identity.slice(identity.lastIndexOf('@') + 1),
    channelId: '',
    source: '',
    sourceDetail: '',
    account: '',
    platform: '',
    state: 'registered',
    lastUsedAt: null,
    projects: [],
    mailbox: nature === null ? null : { nature, endpoint: '', hasCredential },
    ...overrides,
  };
}

const probes = (entries: Array<[string, MailboxProbe]>) => new Map<string, MailboxProbe>(entries);

const row = (target: PoolEntry): OfflineMailbox => ({
  entry: target,
  cause: 'unreachable',
  detail: '',
});

describe('only a real failure counts as offline', () => {
  test('a probe that failed is offline, with the backend reason kept', () => {
    const address = entry('bought@outlook.com', 'oauth2');
    const verdict = classifyOffline(
      [address],
      probes([[address.identity, { state: 'offline', detail: 'invalid_grant' }]])
    );
    expect(verdict.offline).toHaveLength(1);
    expect(verdict.offline[0].cause).toBe('unreachable');
    expect(verdict.offline[0].detail).toBe('invalid_grant');
    expect(verdict.online).toHaveLength(0);
    expect(verdict.unknown).toHaveLength(0);
  });

  test('a probe that connected is online', () => {
    const address = entry('bought@outlook.com', 'oauth2');
    const verdict = classifyOffline(
      [address],
      probes([[address.identity, { state: 'online', detail: 'INBOX' }]])
    );
    expect(verdict.online).toEqual([address]);
    expect(verdict.offline).toHaveLength(0);
  });

  test('a missing credential is offline even with no probe answer', () => {
    // 密钥库确定没有它的凭据：不用连也知道打不开。这与「读不到」是两件事。
    const address = entry('gone@outlook.com', 'graph', false);
    const verdict = classifyOffline([address], probes([]));
    expect(verdict.offline).toHaveLength(1);
    expect(verdict.offline[0].cause).toBe('credential-missing');
  });

  test('not tested is never reported as offline', () => {
    // `unready` / `unsupported` / 没给结论，都只是「判断不了」。把它们混进离线
    // 清单，人会去重新导入一个本来好好的号。
    const unready = entry('locked@outlook.com', 'oauth2', null);
    const unsupported = entry('plain@example.com', 'imap');
    const silent = entry('quiet@example.com', 'oauth2');
    const verdict = classifyOffline(
      [unready, unsupported, silent],
      probes([
        [unready.identity, { state: 'unready', detail: 'store locked' }],
        [unsupported.identity, { state: 'unsupported', detail: '' }],
      ])
    );
    expect(verdict.offline).toHaveLength(0);
    expect(verdict.unknown.map((item) => item.identity)).toEqual([
      'locked@outlook.com',
      'plain@example.com',
      'quiet@example.com',
    ]);
  });

  test('a successful probe outranks a missing credential flag', () => {
    const address = entry('odd@outlook.com', 'graph', false);
    const verdict = classifyOffline(
      [address],
      probes([[address.identity, { state: 'online', detail: 'INBOX' }]])
    );
    expect(verdict.online).toEqual([address]);
  });

  test('addresses are matched however they were typed', () => {
    const address = entry('Mixed@Outlook.com ', 'oauth2');
    const verdict = classifyOffline(
      [address],
      probes([['mixed@outlook.com', { state: 'offline', detail: '' }]])
    );
    expect(verdict.offline).toHaveLength(1);
    expect(verdict.offline[0].entry).toBe(address);
  });
});

describe('the sweep only checks mailboxes that own a credential', () => {
  test('phones and channel-issued addresses are out of scope', () => {
    const phone = entry('13800138000', null, null, { kind: 'phone', domain: '' });
    const issued = entry('alias@self-hosted.com', null, null);
    const owned = entry('bought@outlook.com', 'oauth2');
    expect(isSweepCandidate(phone)).toBe(false);
    expect(isSweepCandidate(issued)).toBe(false);
    expect(isSweepCandidate(owned)).toBe(true);
    expect(sweepAddresses([phone, issued, owned])).toEqual(['bought@outlook.com']);
  });

  test('one credential is probed once, in a stable order', () => {
    // 同一个信箱下的多个地址共用一份凭据：重复问只会让同一次失败在清单里出现好几遍。
    const first = entry('A@Outlook.com', 'oauth2');
    const second = entry('a@outlook.com', 'oauth2');
    expect(sweepAddresses([first, second])).toEqual(['a@outlook.com']);
  });
});

describe('probing is chunked at the backend limit', () => {
  test('the chunk size is the 40 the backend accepts', () => {
    expect(PROBE_CHUNK_SIZE).toBe(40);
  });

  test('41 addresses become 40 + 1, not one oversized request', () => {
    const addresses = Array.from({ length: 41 }, (_, index) => `box${index}@example.com`);
    const chunks = chunkAddresses(addresses);
    expect(chunks.map((chunk) => chunk.length)).toEqual([40, 1]);
    expect(chunks.flat()).toEqual(addresses);
  });

  test('nothing to check produces no request at all', () => {
    expect(chunkAddresses([])).toEqual([]);
  });
});

describe('re-authorising is only offered where a sign-in can help', () => {
  test('nothing selected means nothing to do', () => {
    expect(canReauthorize([])).toBe(false);
  });

  test('the Microsoft routes qualify, the password route does not', () => {
    expect(canReauthorize([row(entry('a@outlook.com', 'oauth2'))])).toBe(true);
    expect(canReauthorize([row(entry('a@outlook.com', 'graph'))])).toBe(true);
    expect(canReauthorize([row(entry('a@self-hosted.com', 'imap'))])).toBe(false);
  });

  test('one unpromising row disables it for the whole selection', () => {
    expect(
      canReauthorize([row(entry('a@outlook.com', 'oauth2')), row(entry('b@domain.com', 'imap'))])
    ).toBe(false);
  });
});

describe('a reason shared by every row is written once', () => {
  const withDetail = (address: string, detail: string): OfflineMailbox => ({
    ...row(entry(address, 'oauth2')),
    detail,
  });

  test('identical reasons are lifted out of the list', () => {
    const rows = [
      withDetail('a@outlook.com', 'invalid_grant'),
      withDetail('b@outlook.com', 'invalid_grant'),
    ];
    expect(sharedOfflineDetail(rows)).toBe('invalid_grant');
  });

  test('one differing reason keeps every row as it is', () => {
    // 合并显示不同的话，等于把依据说错。
    const rows = [
      withDetail('a@outlook.com', 'invalid_grant'),
      withDetail('b@outlook.com', 'account disabled'),
    ];
    expect(sharedOfflineDetail(rows)).toBe('');
  });

  test('a blank reason is not a shared reason', () => {
    const rows = [
      withDetail('a@outlook.com', 'invalid_grant'),
      withDetail('b@outlook.com', ''),
    ];
    expect(sharedOfflineDetail(rows)).toBe('');
  });

  test('a single row keeps its own reason', () => {
    expect(sharedOfflineDetail([withDetail('a@outlook.com', 'invalid_grant')])).toBe('');
  });
});

describe('the sweep entry sits in the pool header, left of the count', () => {
  test('the button precedes the identity count in one row', () => {
    const header = card.slice(card.indexOf('styles.poolExtra'));
    expect(header.indexOf('sms_service.pool_sweep')).toBeLessThan(
      header.indexOf('sms_service.pool_extra')
    );
  });

  test('the button opens the sweep, not a cleanup of unknown rows', () => {
    expect(card).toContain('setSweepOpen(true)');
    expect(card).toContain('<SweepOfflineModal');
    expect(card).toContain('sweepCandidates(entries)');
  });

  test('with nothing to check the button is disabled instead of opening an empty dialog', () => {
    expect(card).toContain('disabled={ownMailboxes.length === 0}');
  });

  test('a removal re-reads the ledger', () => {
    expect(card).toContain('onRemoved');
    expect(page).toContain('poolReloadKey');
  });
});

describe('an offline mailbox gets exactly three ways out', () => {
  test('the footer offers export, re-authorise and removal', () => {
    expect(modal).toContain("t('sms_service.sweep_export')");
    expect(modal).toContain("t('sms_service.sweep_reauthorize')");
    expect(modal).toContain("t('sms_service.sweep_remove')");
  });

  test('the dialog has one close control, not two', () => {
    // 右上角已经有 X；底栏再来一个「关闭」= 同一个动作做两遍。
    expect(modal).not.toContain('sweep_close');
    expect(modal).toContain('phase === \'scanning\' ? undefined');
  });

  test('the export is a plain address list that can be pasted back', () => {
    expect(modal).toContain("selectedRows.map((row) => row.entry.identity).join('\\n')");
    expect(modal).toContain('downloadBlob');
  });

  test('re-authorising hands the addresses to the import, it does not sign in here', () => {
    expect(modal).toContain('onReauthorize(selectedRows.map((row) => row.entry.identity))');
    expect(page).toContain('setImportPrefill');
    expect(modal).not.toContain('startAuthorization');
  });

  test('removal asks first, then deletes one ledger row per address', () => {
    expect(modal).toContain('showConfirmation');
    expect(modal).toContain("supplyApi.removePoolAccount('email', address)");
    expect(supplyApi).toContain('removePoolAccount(');
  });

  test('a failed removal stays in the list and says why', () => {
    expect(modal).toContain('sweep_remove_failed');
    expect(modal).toContain('current.offline.filter((row) => !gone.has(row.entry.identity))');
  });

  test('unjudged identities are counted, not listed', () => {
    expect(modal).toContain('verdict.unknown.length > 0');
    expect(modal).toContain("t('sms_service.sweep_unknown'");
  });
});

describe('the sweep checks before it reports', () => {
  test('the probe request is the backend one, chunk by chunk', () => {
    expect(modal).toContain('emailApi.probeAddresses(chunk)');
    expect(modal).toContain('chunkAddresses(addresses)');
  });

  test('progress is reported while the chunks run', () => {
    expect(modal).toContain('setProgress');
    expect(modal).toContain("t('sms_service.sweep_scanning'");
  });

  test('closing the dialog stops the scan it started', () => {
    expect(modal).toContain('cancelled = true');
  });

  test('a language switch does not cut a running scan short', () => {
    // `t` 换语言就换一个身份：写进依赖 = 扫到一半被掐断，又因为「已经扫过」不再
    // 开始，弹窗永远停在「正在检查」。
    expect(modal).toContain('}, [open, entries]);');
    expect(modal).not.toContain('[open, entries, t]');
  });

  test('a check that did not finish does not also claim nothing failed', () => {
    expect(modal).toContain('scanError === null && offline.length === 0');
    expect(modal).toContain("sweep_err_probe', {");
  });
});

describe('the list stays readable when every row fails the same way', () => {
  test('the shared reason is shown once, above the list', () => {
    expect(modal).toContain('sharedOfflineDetail(offline)');
    expect(modal).toContain("t('sms_service.sweep_shared_cause_label')");
  });

  test('a row does not repeat the reason already stated above', () => {
    expect(modal).toContain('row.detail.trim() !== sharedDetail');
  });
});

describe('every locale carries the sweep copy', () => {
  const keys = [
    'pool_sweep',
    'pool_sweep_hint',
    'sweep_title',
    'sweep_lead',
    'sweep_shared_cause_label',
    'sweep_scanning',
    'sweep_err_probe',
    'sweep_clear',
    'sweep_clear_desc',
    'sweep_select_all',
    'sweep_selected',
    'sweep_unknown',
    'sweep_cause_unreachable',
    'sweep_cause_credential-missing',
    'sweep_export',
    'sweep_export_done',
    'sweep_reauthorize',
    'sweep_reauthorize_hint',
    'sweep_remove',
    'sweep_remove_confirm_title',
    'sweep_remove_confirm',
    'sweep_remove_done',
    'sweep_remove_failed',
  ];

  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko']) {
    test(`${locale} has every key`, () => {
      const file = JSON.parse(read(`i18n/locales/${locale}.json`)) as {
        sms_service?: Record<string, string>;
      };
      for (const key of keys) {
        expect(file.sms_service?.[key]).toBeTruthy();
      }
    });
  }
});