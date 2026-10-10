// 08 安全管理分区：渲染契约 + 两条「换密钥」链路的关键接线。
//
// 弹窗里的交互（输入、提交、错误态）需要真实浏览器，这里用静态渲染 + 源码契约
// 保护最容易回归的部分：分区渲染了什么、未启用时不渲染什么、按钮真的接在后端
// 调用上，以及换密钥后当前会话不会因为「还带着旧值」而失效。
//
// ⚠️ zustand 5 在 SSR 下用 `getInitialState()` 作为 server snapshot，所以
// `SectionSecurity` 的静态标记永远是「库未启用」那一档；需要看到主密码行的两种
// 形态时，直接渲染可展示的 `SecurityKeyRow`（分区自己也是这么组合的）。

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import { DEFAULT_VISUAL_VALUES } from '@/types/visualConfig';
import { SectionSecurity, SecurityKeyRow } from '@/features/config/components/sections/SectionSecurity';
import {
  CONFIG_SECTION_IDS,
  CONFIG_TAB_ICONS,
  SECTION_INDEX_LABELS,
} from '@/features/config/constants';

const translations = i18n.cloneInstance({ lng: 'en' });
const props = { values: DEFAULT_VISUAL_VALUES, disabled: false, onChange: () => {} };
const render = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n: translations }, element));
const escapeText = (value: string) =>
  renderToStaticMarkup(createElement('span', null, value)).slice(6, -7);
const t = (key: string) =>
  escapeText(translations.t(`config_management.visual.sections.security.${key}`));

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko'] as const;

describe('security section registration', () => {
  test('is a canonical section with an index label and a tab icon', () => {
    expect(CONFIG_SECTION_IDS).toContain('security');
    expect(SECTION_INDEX_LABELS.security).toBe('08');
    expect(CONFIG_TAB_ICONS.security).toBeDefined();
  });

  test('owns no config fields, so it adds no search index entries', async () => {
    const { CONFIG_FIELD_SEARCH_INDEX } = await import('@/features/config/searchIndex');
    expect(CONFIG_FIELD_SEARCH_INDEX.filter((e) => e.sectionId === 'security')).toHaveLength(0);
  });
});

describe('security section rendering', () => {
  test('renders the card and the management key row', () => {
    const markup = render(createElement(SectionSecurity, props));
    expect(markup).toContain(t('title'));
    expect(markup).toContain(t('description'));
    expect(markup).toContain('08');
    expect(markup).toContain(t('key_title'));
    expect(markup).toContain(t('key_desc'));
    expect(markup).toContain(`>${t('change')}<`);
    // 未启用密钥库时不出现主密码行——不摆不能用的控件。
    expect(markup).not.toContain(t('pass_title'));
    expect(markup).not.toContain(`>${t('set')}<`);
  });

  test('keeps the dialogs unmounted while closed', () => {
    const markup = render(createElement(SectionSecurity, props));
    expect(markup).not.toContain('role="dialog"');
  });

  test('the master password row offers to change once a password is installed', () => {
    const markup = render(
      createElement(SecurityKeyRow, {
        icon: null,
        title: t('pass_title'),
        description: t('pass_desc'),
        actionLabel: t('change'),
        onAction: () => {},
      })
    );
    expect(markup).toContain(t('pass_title'));
    expect(markup).toContain(t('pass_desc'));
    expect(markup).toContain(`>${t('change')}<`);
    expect(markup).not.toContain(t('pass_desc_unset'));
  });

  test('the master password row offers to set one when none is installed', () => {
    const markup = render(
      createElement(SecurityKeyRow, {
        icon: null,
        title: t('pass_title'),
        description: t('pass_desc_unset'),
        actionLabel: t('set'),
        onAction: () => {},
      })
    );
    expect(markup).toContain(t('pass_desc_unset'));
    expect(markup).toContain(`>${t('set')}<`);
    expect(markup).not.toContain(`>${t('change')}<`);
  });

  test('a read-only row renders its action disabled', () => {
    const markup = render(
      createElement(SecurityKeyRow, {
        icon: null,
        title: t('key_title'),
        description: t('key_desc'),
        actionLabel: t('change'),
        disabled: true,
        onAction: () => {},
      })
    );
    const buttons = markup.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('disabled=""');
  });
});

describe('security copy is complete in every locale', () => {
  const resolve = (root: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>((node, part) => {
      if (node && typeof node === 'object') return (node as Record<string, unknown>)[part];
      return undefined;
    }, root);

  test('every key resolves to a non-empty string', async () => {
    const en = (await Bun.file('src/i18n/locales/en.json').json()) as unknown;
    const enSection = resolve(en, 'config_management.visual.sections.security') as Record<
      string,
      unknown
    >;
    const keys = Object.keys(enSection);
    expect(keys.length).toBeGreaterThan(25);
    for (const locale of LOCALES) {
      const json = (await Bun.file(`src/i18n/locales/${locale}.json`).json()) as unknown;
      const section = resolve(json, 'config_management.visual.sections.security') as
        | Record<string, unknown>
        | undefined;
      expect(section).toBeDefined();
      for (const key of keys) {
        const value = section?.[key];
        expect(typeof value).toBe('string');
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('key rotation keeps the current session usable', () => {
  const dialogs = readFileSync(
    new URL('../src/features/config/components/sections/SecurityDialogs.tsx', import.meta.url),
    'utf8'
  );
  const section = readFileSync(
    new URL('../src/features/config/components/sections/SectionSecurity.tsx', import.meta.url),
    'utf8'
  );
  const configApi = readFileSync(
    new URL('../src/services/api/config.ts', import.meta.url),
    'utf8'
  );
  const smsApi = readFileSync(new URL('../src/services/api/sms.ts', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../src/services/api/client.ts', import.meta.url), 'utf8');
  const authStore = readFileSync(new URL('../src/stores/useAuthStore.ts', import.meta.url), 'utf8');

  test('the management key is rotated through the config endpoint', () => {
    expect(configApi).toContain("apiClient.patch('/config'");
    expect(configApi).toContain("management: { 'secret-key': key }");
    expect(dialogs).toContain('configApi.changeManagementKey');
  });

  test('the rotated key replaces the in-memory key, or the next request would 401', () => {
    expect(dialogs).toContain('updateManagementKey');
    // 只更新 store 不够：apiClient 才是真正带 Authorization 的地方。
    expect(authStore).toContain('apiClient.setConfig({ apiBase: get().apiBase, managementKey })');
  });

  test('the master password is replaced by unlocking first, then setting', () => {
    // 锁定态直接换会被后端拒绝，所以顺序不能反。
    const unlockAt = smsApi.indexOf("apiClient.post('/secrets/unlock'");
    const setAt = smsApi.indexOf("'/secrets/passphrase'");
    expect(unlockAt).toBeGreaterThan(-1);
    expect(setAt).toBeGreaterThan(unlockAt);
    expect(dialogs).toContain('smsApi.setPassphrase');
    expect(dialogs).toContain('smsApi.initializeStore');
  });

  test('the gate adopts the new passphrase so later writes use the right one', () => {
    expect(dialogs).toContain('adoptPassphrase');
  });

  test('a rejected passphrase does not sign the operator out', () => {
    // /secrets/* 的 401 是「主密码不符」，不是会话失效；按路径放行。
    expect(client).toContain('isPassphraseRoute');
    expect(client).toContain("'/secrets/unlock'");
    expect(client).toContain("'/secrets/passphrase'");
    expect(client).toContain('!isPassphraseRoute(error.config?.url)');
  });

  test('the master password row is only reachable when the store is enabled', () => {
    // 主密码那一行整体挂在 storeEnabled 之下，未启用时没有入口。
    expect(section).toContain('storeEnabled ?');
  });
});
