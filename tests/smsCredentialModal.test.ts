import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

/**
 * 渠道配置弹窗的保存契约（源码契约测试）。
 *
 * 这里锁死的是三条**曾经出过或差点出过**的回归：
 * ① 空提交不能走到写凭据的接口（历史上网页账号覆盖过 API 密钥，见 docs/ops/07 §11.22）；
 * ② 保存只提交当前 Tab 的字段，另一条路径不会被空值覆盖；
 * ③ 保存成功后不自动关窗，就地给出反馈。
 */

const source = readFileSync(
  new URL('../src/features/sms/ChannelConfigModal.tsx', import.meta.url),
  'utf8'
);

/** 取 `start` 到 `end` 之间的源码片段（含起点，不含终点）。 */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = end === '' ? text.length : text.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
}

const saveBody = between(source, 'const handleSave', 'const handleTest');
const apiBranch = between(saveBody, "if (tab === 'api')", '} else {');
const webBranch = between(saveBody, '} else {', 'setSubmitAttempted(false)');
const footer = between(source, 'footer={', '<div className={styles.body}>');
const body = source.slice(source.indexOf('<div className={styles.body}>'));

describe('an empty submit never reaches the credential API', () => {
  test('the save path returns before either write when nothing is filled', () => {
    expect(saveBody).toContain('if (!complete)');
    expect(saveBody.indexOf('if (!complete)')).toBeLessThan(
      saveBody.indexOf('smsApi.saveApiCredential')
    );
    expect(saveBody.indexOf('if (!complete)')).toBeLessThan(
      saveBody.indexOf('smsApi.saveWebCredential')
    );
    // 守卫必须真的返回，而不是「提示一句然后继续往下写」。
    expect(between(saveBody, 'if (!complete) {', '}')).toContain('return;');
  });

  test('one criterion decides, not two', () => {
    expect(source).not.toContain('nothingToSave');
    expect(source).not.toContain('canSubmit');
    expect(source).toContain('const complete = accountFilled && passwordFilled;');
  });

  test('the button stays clickable so the click can explain itself', () => {
    expect(source).toContain("disabled={saving || gatePhase === 'locked'}");
    expect(source).toContain("t('sms_service.config_need_credentials')");
    expect(source).toContain('showNeedCredentials');
  });
});

describe('a save submits only the tab in front of the user', () => {
  test('the API branch never touches the website sign-in fields', () => {
    expect(apiBranch).toContain('smsApi.saveApiCredential');
    expect(apiBranch).toContain('api_user:');
    expect(apiBranch).toContain('api_pass:');
    expect(apiBranch).not.toMatch(/web_user|web_pass|webUser|webPass|saveWebCredential/);
  });

  test('the sign-in branch never touches the API fields or the endpoint', () => {
    expect(webBranch).toContain('smsApi.saveWebCredential');
    expect(webBranch).not.toMatch(
      /api_user|api_pass|apiUser|apiPass|saveApiCredential|endpoint/
    );
  });

  test('a custom endpoint is submitted only when it was actually filled in', () => {
    // 空串在后端是「保留旧值」，会把自定义地址静默吃掉。
    expect(saveBody).not.toMatch(/endpoint:\s*endpointLocked/);
    expect(saveBody).toContain(
      "if (!endpointLocked && endpoint.trim() !== '') input.endpoint = endpoint.trim();"
    );
  });
});

describe('a successful save reports itself instead of vanishing', () => {
  test('the save path never closes the modal', () => {
    expect(saveBody).not.toContain('onClose');
    expect(source).not.toContain('onClose()');
  });

  test('success is shown in the modal and the parent is told to refresh', () => {
    expect(saveBody).toContain('setSaved(true);');
    expect(saveBody).toContain('onSaved();');
    expect(source).toContain("t('sms_service.config_saved')");
  });

  test('the lock notice sits next to the buttons it disables', () => {
    const notice = between(
      source,
      'let saveNotice: SaveNotice | null = null;',
      'const applySaveResults'
    );
    expect(notice).toContain("t('sms_service.config_gate_locked_hint')");
    // 提示渲染在 footer 里（紧邻保存按钮），不再吊在弹窗最底部。
    expect(footer).toContain('{saveNotice.text}');
    expect(footer).toContain("t('sms_service.config_save')");
    expect(body).not.toContain('config_gate_locked_hint');
  });
});

describe('the credential fields say the same thing in every language', () => {
  const locales = ['en', 'zh-CN', 'zh-TW', 'ru', 'ko', 'vi'];

  test('the account placeholder names the account, not a key', async () => {
    for (const locale of locales) {
      const messages = await Bun.file(`src/i18n/locales/${locale}.json`).json();
      const placeholder: string = messages.sms_service.config_ph_api_account;
      expect(placeholder).toBeString();
      expect(placeholder.trim()).not.toBe('');
      expect(placeholder.toLowerCase()).not.toContain('key');
      expect(placeholder).not.toMatch(/密钥|密鑰|ключ|키|khóa/);
    }
  });

  test('the save feedback keys exist in every locale', async () => {
    for (const locale of locales) {
      const messages = await Bun.file(`src/i18n/locales/${locale}.json`).json();
      for (const key of ['config_saved', 'config_need_credentials']) {
        expect(messages.sms_service[key]).toBeString();
        expect(messages.sms_service[key].trim()).not.toBe('');
      }
    }
  });
});
