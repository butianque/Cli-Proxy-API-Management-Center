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
    expect(saveBody).toContain("if (label.trim() === '' || chosenNatures.size === 0) return;");
    // 「先填账号和密码」这条规则已经撤掉：凭据存在密钥库里，留空就是保留它。
    expect(source).not.toContain('config_need_credentials');
    expect(source).not.toContain('accountFilled');
    expect(source).not.toContain('nothingToSave');
  });

  test('the guard returns before any write happens', () => {
    const guard = saveBody.indexOf('chosenNatures.size === 0) return;');
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

describe('a successful save closes the modal', () => {
  test('the save path closes it, after telling the parent to refresh', () => {
    // 结果已经在渠道表里了：让使用者再点一次「关闭」只是多一步。
    expect(saveBody).toContain('onSaved();');
    expect(saveBody).toContain('onClose();');
    expect(saveBody.indexOf('onSaved();')).toBeLessThan(saveBody.indexOf('onClose();'));
    // 失败路径不能收窗，否则错误信息没地方显示。
    const saveStart = saveBody.indexOf('const result = await supplyApi.saveChannel');
    const failBranch = saveBody.slice(saveStart, saveBody.indexOf('onSaved();'));
    expect(failBranch).toContain('return;');
  });

  test('the lock notice sits next to the buttons it disables', () => {
    expect(footer).toContain("t('sms_service.config_gate_locked_hint')");
    expect(footer).toContain("t('sms_service.config_save')");
    // 提示渲染在 footer 里（紧邻保存按钮），不吊在弹窗正文最底部。
    expect(body).not.toContain('config_gate_locked_hint');
  });
});

describe('the verification buttons answer one question: did it connect', () => {
  const testBody = between(source, 'const handleTest', 'const handleWebLogin');
  const loginBody = between(source, 'const handleWebLogin', '一种接入方式的连接信息块');

  test('a successful test reports the connection, not the balance', () => {
    // 余额属于渠道池，不属于这个按钮：它只回答「凭据连得上吗」。顺手报一个
    // 「余额 ¥2.29」会让人以为余额低就是连接有问题。
    expect(source).toContain("t('sms_service.config_test_ok')");
    expect(source).not.toContain('config_test_ok_balance');
    expect(testBody).not.toContain('toFixed(');
    expect(testBody).not.toContain("setApiTest({ kind: 'ok', balance");
  });

  test('a successful sign-in reports the sign-in, not how many channels it saw', () => {
    expect(source).toContain("t('sms_service.config_web_login_ok')");
    expect(source).not.toContain('webLogin.channels');
    expect(loginBody).not.toContain('.channels');
  });

  test('the two results carry no number, in any language', () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko']) {
      const bundle = JSON.parse(
        readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8')
      ) as { sms_service?: Record<string, string> };
      const section = bundle.sms_service ?? {};
      // 没有值可填的占位符会原样印在屏幕上（「可用 {{count}} 个渠道」），
      // 而死键只是噪音。
      expect(section.config_web_login_ok).not.toContain('{{');
      expect(section).not.toHaveProperty('config_test_ok_balance');
    }
  });
});

describe('the masked hint belongs to the selected platform', () => {
  test('the hint is gated on the platform the stored credential belongs to', () => {
    // 切到「自定义」却还显示内置平台的 e3••••f8，就是拿别人的凭据当提示。
    expect(source).toContain('const credentialBelongsHere = credential?.provider === platformId;');
    expect(source).toContain(
      "const apiHint = isEditing && credentialBelongsHere ? (credential?.apiUserHint ?? '') : '';"
    );
    expect(source).toContain(
      "const webHint = isEditing && credentialBelongsHere ? (credential?.webUserHint ?? '') : '';"
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

describe('a new channel is not made to look pre-filled', () => {
  test('the masked account belongs to editing, not to adding', () => {
    // 新建渠道没有任何「已存的值」属于它：摆一个 e3••••f8 只会让人以为已经填好了。
    expect(source).toContain('const isEditing = channel !== null;');
    expect(source).toContain(
      "const apiHint = isEditing && credentialBelongsHere ? (credential?.apiUserHint ?? '') : '';"
    );
    expect(source).toContain(
      "const webHint = isEditing && credentialBelongsHere ? (credential?.webUserHint ?? '') : '';"
    );
  });

  test('the "keep what is stored" copy is editing-only', () => {
    // 没有存过东西的人看到「留空则保留已存的值」只会更糊涂。
    expect(source).toContain('{apiStored && <div className={styles.fieldNote}>{keepBlank}</div>}');
    expect(source).toContain('{webStored && <div className={styles.fieldNote}>{keepBlank}</div>}');
    expect(source).not.toContain('hint={keepBlank}');
    expect(source).not.toContain('hint={apiHint ? keepBlank : undefined}');
    expect(source).not.toContain('hint={webHint ? keepBlank : undefined}');
    expect(source).toContain(
      "hint={isEditing ? t('sms_service.config_field_endpoint_opt') : undefined}"
    );
  });

  test('the copy is gated on a credential really existing, not on having a mask to show', () => {
    // 「已存凭据在不在」与「有没有脱敏字符串可显示」是两件事：凭据在、账号字段为空时
    // 脱敏串是空的，那句话照样成立。锁着时基座报不出条目名，就都不说。
    expect(source).toContain(
      'const apiStored = isEditing && credentialBelongsHere && credential?.apiPresent === true;'
    );
    expect(source).toContain(
      'const webStored = isEditing && credentialBelongsHere && credential?.webPresent === true;'
    );
  });

  test('the same sentence is not repeated under every box', () => {
    // 一句话说清这一对框留空意味着什么；每个框下面各挂一遍只是噪音。
    const repeats = source.match(/keepBlank\}/g) ?? [];
    expect(repeats.length).toBe(2);
  });

  test('adding falls back to guiding copy', () => {
    // 退回的正是引导文案：告诉使用者该填什么，而不是暗示已经填好。
    expect(source).toContain("placeholder={apiHint || t('sms_service.config_ph_api_account')}");
    expect(source).toContain("placeholder={webHint || t('sms_service.config_ph_web_user')}");
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
    expect(source).toContain('resolvePlatformId(platformChoice, credential?.provider)');
  });

  test('an explicit pick outranks the credential, and reopening drops the pick', () => {
    expect(source).toContain('setPlatformChoice(item.id)');
    expect(source).toContain('setPlatformChoice(null)');
  });
});

describe('the name follows the platform until it is edited', () => {
  test('a built-in platform names the channel by itself', () => {
    // 选了内置平台还要把平台名抄进名称栏，就是联动断了。
    expect(source).toContain(
      "const platformLabel = (item: SmsPlatform) => (item.preset ? t(item.nameKey) : '');"
    );
    expect(source).toContain(
      "const label = kind === 'phone' && !labelEdited ? platformLabel(platform) : draft.label;"
    );
  });

  test('the field shows and submits the derived name, never a stale draft', () => {
    expect(source).toContain('value={label}');
    expect(source).not.toContain('value={draft.label}');
    expect(source).toContain('const result = await supplyApi.saveChannel(channelDraftToInput(submitted));');
    expect(source).toContain("if (label.trim() === '' || chosenNatures.size === 0) return;");
  });

  test('typing your own name stops it from following the platform', () => {
    expect(source).toContain('setLabelEdited(true)');
    // 打开时：已存渠道有自己的名字就算「改过」，没有名字的（旧数据）跟着平台补。
    expect(source).toContain("setLabelEdited(channel ? channel.label.trim() !== '' : false)");
  });
});

describe('the category and the access methods follow the platform too', () => {
  test('a built-in platform carries its own category, not a question for the operator', () => {
    // 豪猪接码是第三方服务 —— 这是平台的事实，不该让人自己选一遍。
    expect(source).toContain(
      "!categoryEdited && platformFacts?.defaultCategory\n      ? platformFacts.defaultCategory\n      : draft.category"
    );
    expect(source).toContain('value={category}');
    expect(source).not.toContain('value={draft.category}');
    expect(source).toContain('setCategoryEdited(true)');
  });

  test('a built-in platform checks every method it supports', () => {
    // 平台卡片上写着「用 API 接入取号，用网页登录管理渠道」，勾选框不能只勾一半。
    expect(source).toContain('const platformFacts = kind === \'phone\' && platform.preset ? platform : null;');
    expect(source).toContain('return platformNatures(defaults, allowed.map((item) => item.nature));');
    expect(source).toContain('if (!defaults || naturesEdited) return block.natures;');
    // 勾选框、连接块、必填判据、提交读同一个集合。
    expect(source).toContain('checked={chosenNatures.has(nature)}');
    expect(source).toContain('allowed.filter((item) => chosenNatures.has(item.nature))');
    expect(source).toContain("const apiSelected = kind === 'phone' && chosenNatures.has('api');");
    expect(source).toContain('natures: chosenNatures');
    expect(source).not.toContain('checked={block.natures.has(nature)}');
  });

  test('unticking starts from what the checkboxes show', () => {
    // 从草稿里的空集合起算，取消勾选反而会把它加上去。
    expect(source).toContain('const next = new Set(chosenNatures);');
    expect(source).toContain('setNaturesEdited(true);');
    expect(source).not.toContain('const next = new Set(current.natures);');
  });

  test('a stored channel keeps its own category and methods', () => {
    // 已存的值是使用者的选择，一律不覆盖；空的才跟着平台补。
    expect(source).toContain("setCategoryEdited(channel ? channel.category.trim() !== '' : false)");
    expect(source).toContain('setNaturesEdited(channel ? restored[kind].natures.size > 0 : false)');
  });

  test('email has no platform, so nothing is invented for it', () => {
    expect(source).toContain("const platformFacts = kind === 'phone' && platform.preset ? platform : null;");
    expect(source).toContain("const label = kind === 'phone' && !labelEdited ? platformLabel(platform) : draft.label;");
  });
});

describe('the two categories share one editor', () => {
  test('the kind is a prop, so there is no second editor per category', () => {
    expect(source).toContain('kind: SupplyKind;');
    expect(source).not.toContain('const editorKind');
    expect(source).not.toContain('role="tablist"');
  });

  test('the offered methods come from the backend capability list', () => {
    expect(source).toContain('natures');
    expect(source).toContain('item.kinds.includes(kind)');
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
