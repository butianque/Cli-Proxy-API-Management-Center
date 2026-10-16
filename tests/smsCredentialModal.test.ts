import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

/**
 * 渠道编辑器的保存契约（源码契约测试）。
 *
 * 手机号与邮箱**共用同一个编辑器**，所以契约也只有一份。这里锁死的是四条
 * **出过或差点出过**的回归：
 * ① 必填只有「名称 + 至少一种接入方式」—— 曾经要求「先填账号和密码」，
 *    于是凭据已经存好的渠道反而存不进去；
 * ② 凭据留空 = 保留已存值，但**半个凭据**（只填账号或只填密码）必须挡住，
 *    不能静默合并成半条（历史上网页账号覆盖过 API 密钥，见 docs/ops/07 §11.22）；
 * ③ 保存顺序是「先凭据、后渠道记录」—— 主密码那道门没过，就不该先建一条空壳；
 * ④ 保存成功后不自动关窗，就地给出反馈。
 */

const source = readFileSync(
  new URL('../src/features/sms/ChannelEditorModal.tsx', import.meta.url),
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
const footer = between(source, 'footer={', '<div className={styles.body}>');
const body = source.slice(source.indexOf('<div className={styles.body}>'));

describe('the required fields are the name and one access method', () => {
  test('the guard asks for a name and one access method, nothing else', () => {
    expect(saveBody).toContain(
      "if (draft.label.trim() === '' || block.natures.size === 0) return;"
    );
    // 「先填账号和密码」这条规则已经撤掉：凭据存在密钥库里，留空就是保留它。
    expect(source).not.toContain('config_need_credentials');
    expect(source).not.toContain('accountFilled');
    expect(source).not.toContain('nothingToSave');
  });

  test('the guard returns before any write happens', () => {
    const guard = saveBody.indexOf('block.natures.size === 0) return;');
    expect(guard).toBeLessThan(saveBody.indexOf('smsApi.saveApiCredential'));
    expect(guard).toBeLessThan(saveBody.indexOf('supplyApi.saveChannel'));
  });
});

describe('a blank credential keeps the stored one, a half one is refused', () => {
  test('each credential is written only when something was actually typed', () => {
    // 空串在后端是「保留旧值」，所以「没填」就不能走写接口。
    expect(saveBody).toContain('if (apiSelected && apiFilled)');
    expect(saveBody).toContain('if (webSelected && webFilled)');
  });

  test('half a credential pair is refused instead of silently merged', () => {
    expect(saveBody).toContain('if (apiPairBroken || webPairBroken) return;');
    // 「填了任意一个」与「两个都填了」必须是两个不同的判断。
    expect(source).toContain(
      "const apiFilled = apiUser.trim() !== '' || apiPass.trim() !== '';"
    );
    expect(source).toContain(
      "const apiComplete = apiUser.trim() !== '' && apiPass.trim() !== '';"
    );
    expect(source).toContain('const apiPairBroken = attempted && apiSelected && apiFilled && !apiComplete;');
  });

  test('a custom endpoint travels only when it was actually filled in', () => {
    expect(saveBody).not.toMatch(/endpoint:\s*endpointLocked/);
    expect(saveBody).toContain(
      "if (!endpointLocked && endpoint.trim() !== '') input.endpoint = endpoint.trim();"
    );
  });
});

describe('credentials are written before the channel record', () => {
  test('both credential writes happen above the channel save', () => {
    const channelSave = saveBody.indexOf('supplyApi.saveChannel');
    expect(channelSave).toBeGreaterThan(-1);
    expect(saveBody.indexOf('smsApi.saveApiCredential')).toBeLessThan(channelSave);
    expect(saveBody.indexOf('smsApi.saveWebCredential')).toBeLessThan(channelSave);
  });

  test('a failed credential write aborts the save instead of leaving a shell', () => {
    expect(saveBody).toContain(
      'if (!applyCredentialResult(await smsApi.saveApiCredential(input, passphrase))) return;'
    );
    expect(saveBody).toContain('if (!applyCredentialResult(result)) return;');
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
    expect(footer).toContain("t('sms_service.config_gate_locked_hint')");
    expect(footer).toContain("t('sms_service.config_save')");
    // 提示渲染在 footer 里（紧邻保存按钮），不吊在弹窗正文最底部。
    expect(body).not.toContain('config_gate_locked_hint');
  });
});

describe('the masked hint belongs to the selected platform', () => {
  test('the hint is gated on the platform the stored credential belongs to', () => {
    // 切到「自定义」却还显示内置平台的 e3••••f8，就是拿别人的凭据当提示。
    expect(source).toContain('const credentialBelongsHere = credential?.provider === platformId;');
    expect(source).toContain(
      "const apiHint = credentialBelongsHere ? (credential?.apiUserHint ?? '') : '';"
    );
    expect(source).toContain(
      "const webHint = credentialBelongsHere ? (credential?.webUserHint ?? '') : '';"
    );
  });

  test('no masked account is hard-coded in the component', () => {
    // 占位符只能来自后端给的脱敏提示，或退回通用占位符；
    // 组件里不许出现「某个具体账号」的掩码（图 5 的 e3••••f8）。
    expect(source).not.toMatch(/[0-9a-zA-Z]•/);
    expect(source).toContain(
      "placeholder={apiHint || t('sms_service.config_ph_api_account')}"
    );
    expect(source).toContain(
      "placeholder={webHint || t('sms_service.config_ph_web_user')}"
    );
  });
});

describe('a custom platform asks for its own name', () => {
  test('the name field is relabelled when the platform is custom', () => {
    expect(source).toContain("t('sms_service.config_field_custom_name')");
    expect(source).toContain("kind === 'phone' && !endpointLocked");
  });

  test('a built-in platform address is read-only, not an editable box', () => {
    expect(source).toContain('const endpointLocked = Boolean(platform.defaultEndpoint);');
    expect(source).toContain('{platform.defaultEndpoint}');
  });
});

describe('the platform follows the stored credential', () => {
  test('the platform is never forced to the built-in one', () => {
    // 手机号只有**一份**平台凭据，渠道记录只指名它 ⇒ 默认平台必须是**已存凭据所属**的那个。
    // 曾经每次打开都写死内置平台，于是编辑一个配在「自定义」上的渠道时，名称标签、
    // 地址框与脱敏提示会三处同时说错。
    expect(source).not.toContain('setPlatformId(SMS_PLATFORMS[0].id)');
    expect(source).not.toContain('platformId, setPlatformId');
    expect(source).toContain("const stored = credential?.provider ?? '';");
    expect(source).toContain('const known = SMS_PLATFORMS.find((item) => item.id === stored);');
  });

  test('an explicit pick outranks the credential, and reopening drops the pick', () => {
    expect(source).toContain('if (platformChoice) return platformChoice;');
    expect(source).toContain('setPlatformChoice(item.id);');
    expect(source).toContain('setPlatformChoice(null);');
  });
});

describe('the two categories share one editor', () => {
  test('the kind is a prop, so there is no second editor per category', () => {
    expect(source).toContain('kind: SupplyKind;');
    expect(source).not.toContain('const editorKind');
    expect(source).not.toContain('role="tablist"');
  });

  test('the offered methods come from the backend capability list', () => {
    expect(source).toContain('natures.filter((item) => item.kinds.includes(kind))');
    expect(source).not.toMatch(/\bnatures\s*=\s*\[\s*'api'/);
  });

  test('no backend field name leaks into the component', () => {
    for (const wire of ['secret_present', 'api_present', 'cookie_present', 'store_available']) {
      expect(source).not.toContain(wire);
    }
  });
});

describe('the editor says the same thing in every language', () => {
  const locales = ['en', 'zh-CN', 'zh-TW', 'ru', 'ko', 'vi'];

  test('the section and field keys exist in every locale', async () => {
    for (const locale of locales) {
      const messages = await Bun.file(`src/i18n/locales/${locale}.json`).json();
      for (const key of [
        'config_step_identity',
        'config_step_platform',
        'config_step_natures',
        'config_step_connection',
        'config_field_custom_name',
        'config_saved',
        'config_api_lead',
        'config_web_lead',
      ]) {
        expect(messages.sms_service[key]).toBeString();
        expect(messages.sms_service[key].trim()).not.toBe('');
      }
    }
  });

  test('the section labels carry no numbering of their own', async () => {
    // 段号由组件按实际段数算（邮箱没有「选择平台」那一段），不能写死在文案里。
    for (const locale of locales) {
      const messages = await Bun.file(`src/i18n/locales/${locale}.json`).json();
      for (const key of [
        'config_step_identity',
        'config_step_platform',
        'config_step_natures',
        'config_step_connection',
      ]) {
        expect(messages.sms_service[key]).not.toMatch(/[①②③④]/);
      }
    }
  });

  test('the retired tab model keys are gone from every locale', async () => {
    for (const locale of locales) {
      const messages = await Bun.file(`src/i18n/locales/${locale}.json`).json();
      for (const key of [
        'config_tabs_label',
        'config_tab_api',
        'config_tab_web',
        'config_step_credentials',
        'config_editor_desc',
        'config_need_credentials',
        'action_need_session',
      ]) {
        expect(messages.sms_service[key]).toBeUndefined();
      }
    }
  });

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
});
