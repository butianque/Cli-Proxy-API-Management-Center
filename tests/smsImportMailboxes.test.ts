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

  test('a finished import lands on the email channel table', () => {
    expect(page).toContain("setCategory('email')");
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
    'import_type_label',
    'import_type_outlook',
    'import_method_label',
    'import_method_graph',
    'import_method_graph_note',
    'import_method_oauth2',
    'import_method_oauth2_note',
    'import_method_hint',
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

  test('both methods are offered, and neither is hidden behind the other', () => {
    expect(modal).toContain("const RECEIVING_METHODS: readonly ReceivingMethod[] = ['graph', 'oauth2'];");
  });

  test('the API passes the method through to the backend', () => {
    expect(api).toContain("nature?: 'oauth2' | 'graph'");
  });

  test('the channel editor treats Graph like the other token method', () => {
    // 应用 ID 与刷新令牌是两种令牌方式共用的；只认 oauth2 会让 Graph 渠道少一格。
    const editor = read('features/sms/ChannelEditorModal.tsx');
    expect(editor).toContain('usesRefreshToken(nature)');
    expect(editor).toContain('usesRefreshToken(mailNature)');
    expect(editor).not.toContain("nature === 'oauth2' &&");
  });
});
