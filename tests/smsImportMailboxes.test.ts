import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

/**
 * 导入邮箱的契约。
 *
 * 这一批邮箱的刷新令牌是**凭据**，所以约束不在「界面长什么样」，而在三条边界：
 * 1. 值不经过面板解析 —— 粘进来的整段文本原样发给基座，面板不按 `----` 切字段，
 *    也就不存在把令牌拼进请求体的第二条路径；
 * 2. 入口只有一个，且排在「配置」左边 —— 号码池页头是唯一的入口；
 * 3. 请求超时单独放宽 —— 一批里每个邮箱都要做一次登录，默认 30 秒只够几个。
 */

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

const api = read('services/api/email.ts');
const modal = read('features/sms/ImportMailboxesModal.tsx');
const page = read('features/sms/SmsServicePage.tsx');

describe('the batch import sends text, never parsed fields', () => {
  test('the endpoint is the backend import route', () => {
    expect(api).toContain('`${SUPPLY_EMAIL_BASE}/import`');
  });

  test('the panel does not split the line itself', () => {
    // 分隔符只在基座解析；面板出现对它的切分，就说明有一处自己在猜字段顺序。
    expect(modal).not.toContain("split('----')");
    expect(api).not.toContain("split('----')");
  });

  test('the batch is chunked so one request stays inside its own timeout', () => {
    expect(modal).toContain('IMPORT_CHUNK_LINES');
    expect(api).toContain('180_000');
  });
});

describe('the entry sits beside the configuration entry', () => {
  test('the import button is the pool header action', () => {
    expect(page).toContain('sms_service.import_mailboxes');
    expect(page).toContain('<ImportMailboxesModal');
  });

  test('it renders before the configuration button', () => {
    const header = page.slice(page.indexOf('headerActions'));
    expect(header.indexOf('import_mailboxes')).toBeLessThan(header.indexOf('config_button'));
  });

  test('a finished import stays on the pool and re-reads it', () => {
    // The imported mailboxes are pool identities, so they appear in the table the
    // operator is already looking at. Jumping to the channel settings would send
    // them looking for rows that are not there.
    const done = page.slice(page.indexOf('onImported'));
    expect(done).toContain("setView('pool')");
    expect(done).toContain('setPoolReloadKey((value) => value + 1)');
    expect(done).not.toContain("setView('config')");
    expect(done).not.toContain("setCategory('email')");
  });
});

describe('a mailbox that fails the check is not imported', () => {
  test('the check is on by default and the note says what it does', () => {
    expect(modal).toContain('useState(true)');
    expect(modal).toContain('sms_service.import_verify_note');
  });

  test('only failures are listed, and the list is bounded', () => {
    expect(modal).toContain('FAILURE_LIST_LIMIT');
    expect(modal).toContain("line.outcome !== 'imported' && line.outcome !== 'updated'");
  });
});

describe('the credential never leaves the request', () => {
  test('the modal does not persist or log the paste', () => {
    expect(modal).not.toContain('localStorage');
    expect(modal).not.toContain('console.');
  });

  test('the answer is not stored as state beyond the summary', () => {
    // 只留账号与结局；整段回包（含每行原始数据）不进 state。
    expect(modal).toContain('const rejected: EmailImportLineWire[] = [];');
  });
});

describe('every locale carries the new copy', () => {
  const keys = [
    'import_mailboxes',
    'import_title',
    'import_lead',
    'import_field_list',
    'import_placeholder',
    'import_count',
    'import_verify',
    'import_verify_note',
    'import_start',
    'import_progress',
    'import_summary',
    'import_failures',
    'import_more',
    'import_close',
    'import_err_empty',
    'import_err_generic',
    'import_mode_label',
    'import_mode_paste',
    'import_mode_paste_note',
    'import_mode_signin',
    'import_mode_signin_note',
    'import_mode_note',
    'import_mode_note_note',
    'import_note_lead',
    'import_note_field_list',
    'import_note_placeholder',
    'import_note_count',
    'import_note_start',
    'import_note_summary',
    'import_note_unlinked',
    'import_signin_lead',
    'import_signin_field_list',
    'import_signin_placeholder',
    'import_signin_start',
    'import_signin_stop',
    'import_signin_progress',
    'import_signin_code_hint',
    'import_signin_copy',
    'import_signin_copied',
    'import_signin_open',
    'import_signin_expires',
    'import_signin_unlock_note',
    'import_signin_unlock_placeholder',
    'import_signin_commit',
    'import_signin_summary',
    'import_signin_err_stop',
    'import_signin_status_waiting',
    'import_signin_status_verifying',
    'import_signin_status_saving',
    'import_signin_status_done',
    'import_signin_alias_title',
    'import_signin_status_denied',
    'import_signin_status_expired',
    'import_signin_status_failed',
    'import_signin_status_cancelled',
    'import_method_label',
    'import_method_graph',
    'import_method_graph_note',
    'import_method_oauth2',
    'import_method_oauth2_note',
    'import_method_imap',
    'import_method_imap_note',
    'import_method_hint',
    'import_lead_imap',
    'import_imap_placeholder',
    'import_imap_host',
    'import_imap_host_placeholder',
    'nature_graph',
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

/**
 * 收信方式是使用者要回答的问题，不是基座能猜的。
 *
 * 同一份刷新令牌通常只带一条路的权限：走邮箱服务器（IMAP）或者走微软邮件接口
 * （Graph）。所以导入时必须把选中的那一条发出去 —— 面板自己猜一个，猜错的表现是
 * 「这个令牌没有那条路的权限」，看起来像号坏了。
 */
describe('the receiving method travels with the batch', () => {
  test('the modal asks for the method and sends it', () => {
    expect(modal).toContain('RECEIVING_METHODS');
    expect(modal).toContain('nature: method');
  });

  test('all three methods are offered, and none is hidden behind another', () => {
    // A mailbox that logs in with its own password is a third transport: its
    // server is not Microsoft's, and no refresh token exists for it.
    expect(modal).toContain(
      "const RECEIVING_METHODS: readonly ReceivingMethod[] = ['graph', 'oauth2', 'imap'];"
    );
  });

  test('the API passes the method through to the backend', () => {
    expect(api).toContain("nature?: 'imap' | 'oauth2' | 'graph'");
  });

  test('a password mailbox carries its server, a token batch does not', () => {
    // Two-field lines have nowhere to write the server, so the modal asks once;
    // a token batch takes a fixed one and must not send a value of its own.
    expect(modal).toContain("host: method === 'imap' ? imapHost : undefined");
    expect(api).toContain("host?: string");
  });

  test('a password batch with no server anywhere is refused per line, not guessed', () => {
    // The panel does not read the paste, so it cannot know which lines carry a
    // server. The backend refuses a hostless line and names it; guessing one
    // would come back as "wrong password" for a mailbox whose password is fine.
    expect(modal).not.toContain("split('----')");
    expect(modal).toContain("t('sms_service.import_lead_imap')");
  });

  test('the channel editor never asks for a mailbox credential', () => {
    // A channel mailbox logs in with an authorization code only. The token fields
    // that used to sit here now belong to the pool import: one mailbox, one
    // credential, its own identity.
    const editor = read('features/sms/ChannelEditorModal.tsx');
    expect(editor).not.toContain('usesRefreshToken');
    expect(editor).not.toContain('field_mail_client_id');
    expect(editor).not.toContain('field_mail_refresh_token');
    expect(editor).toContain("nature: 'imap'");
  });
});

/**
 * 授权导入：卖家只给了账号，刷新令牌只能由账号本人登录一次换来。
 *
 * 面板在这条路上的职责只有「把码摆出来、把状态说清楚」，凭据从头到尾不经过它 ——
 * 令牌从微软直接进基座的密钥库。
 */
describe('the sign-in import asks for accounts only', () => {
  test('the three routes are the backend ones', () => {
    expect(api).toContain('`${SUPPLY_EMAIL_BASE}/authorize`');
    expect(api).toContain('/authorize/${encodeURIComponent(id)}/cancel');
    expect(api).toContain('/authorize/${encodeURIComponent(id)}/commit');
  });

  test('the list travels as text, so nothing here parses it', () => {
    expect(modal).toContain('accounts: lines.join');
    expect(modal).not.toContain("split('----')");
  });

  test('a batch already waiting is adopted, not reported as an error', () => {
    // 同一时刻只能有一批：第二条路径的正确答案是接上它，因为操作者要的是「继续」。
    expect(modal).toContain("result.reason === 'busy'");
    expect(api).toContain('busy?: boolean');
  });

  test('the credential never reaches the panel', () => {
    // 回包里只有状态与那个 8 位码；令牌由基座直接写进密钥库。
    expect(api).toContain('flows?: EmailAuthorizeFlowWire[]');
    expect(modal).not.toContain('refresh_token');
    expect(modal).not.toContain('localStorage');
  });
});

describe('the waiting is driven by the backend, not by a timer of its own', () => {
  test('progress is polled while a sign-in is pending', () => {
    expect(modal).toContain('SIGNIN_POLL_MS');
    expect(modal).toContain('emailApi');
    expect(modal).toContain('getAuthorization');
  });

  test('waiting keeps the operator session alive', () => {
    // 一次登录最长十几分钟，而服务端的空闲窗口是分钟级：不续期，人还在输码就被登出。
    expect(modal).toContain('touchSession');
  });

  test('a batch left running is picked up when the dialog is reopened', () => {
    expect(modal).toContain('existing.some((flow) => !isTerminal(flow))');
  });

  test('the code is rendered from the answer, never copied into state', () => {
    expect(modal).toContain('current.user_code');
    expect(modal).not.toContain('setUserCode');
    expect(modal).toContain('copyToClipboard');
  });
});

describe('a locked store does not throw the sign-in away', () => {
  test('the panel offers one password field to finish it', () => {
    // 登录已经完成、只差写库：重新登录微软是最贵的补救方式，也是最没必要的一种。
    expect(modal).toContain("current.status === 'awaiting_unlock'");
    expect(modal).toContain('commitAuthorization');
  });

  test('a parked sign-in shows no stop button', () => {
    // 这一批已经不再自己往前走，点「停止」看不出任何变化 —— 底栏给的是关闭。
    expect(modal).toContain("current?.status === 'awaiting_unlock'");
    expect(modal).toContain('signinFinished || parked');
  });

  test('a sign-in that landed on another address says so', () => {
    // 填的是别名时凭据会存到微软报的主地址上：这不是失败，但操作者得看得出
    // 池子里那个号是从哪来的。
    expect(modal).toContain('stored_as');
    expect(modal).toContain('import_signin_alias_title');
    expect(modal).not.toContain('import_signin_status_mismatch');
  });
});

/**
 * 登记地址：自建域下的地址只写台账，不配口令。
 *
 * 那类域的信全落进渠道的 catch-all 信箱 —— 给一个虚拟地址配一份口令，读信时用不上，
 * 却会让人以为它自己收信。所以这条路只记「池子里有这个号」，不写凭据。
 */
describe('a self-hosted address is recorded, never given its own password', () => {
  const supply = read('services/api/supply.ts');

  test('the record route is the pool identities route', () => {
    expect(supply).toContain('${SUPPLY_POOL_BASE}/identities');
    expect(supply).toContain('importIdentities');
  });

  test('the three routes are offered side by side', () => {
    expect(modal).toContain(
      "const IMPORT_MODES: readonly ImportMode[] = ['paste', 'signin', 'note'];"
    );
  });

  test('recording sends addresses only, in backend-sized batches', () => {
    expect(modal).toContain('NOTE_CHUNK_LINES');
    expect(modal).toContain('supplyApi.importIdentities');
    const record = modal.slice(
      modal.indexOf('const handleRecord'),
      modal.indexOf('const handleStartSignin')
    );
    // 这条路没有可输的口令，也不碰令牌：它写的是台账，不是密钥库。
    expect(record).not.toContain('passphrase');
    expect(record).not.toContain('refresh_token');
  });

  test('an address no channel covers is still recorded, and said out loud', () => {
    // 登记了但收不到信，和「能收信」是两件事：摘要之外要单独说一句。
    expect(modal).toContain('noteSummary.unlinked > 0');
    expect(modal).toContain('import_note_unlinked');
  });
});
