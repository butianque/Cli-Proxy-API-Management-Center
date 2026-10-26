import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import { apiClient } from '@/services/api/client';
import { pluginsApi } from '@/services/api/plugins';
import {
  buildPluginOAuthProviderCards,
  OAuthPage,
} from '@/pages/OAuthPage';
import type { PluginListEntry } from '@/types';
import en from '@/i18n/locales/en.json';

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

const plugin = (overrides: Partial<PluginListEntry> = {}): PluginListEntry =>
  ({
    id: 'zcode',
    path: 'plugins/zcode',
    configured: true,
    registered: true,
    enabled: true,
    effectiveEnabled: true,
    supportsOAuth: true,
    logo: '/plugins/zcode/logo.png',
    configFields: [],
    menus: [],
    metadata: {
      name: 'ZCode',
      version: '1.0.0',
      author: '',
      githubRepository: '',
      logo: '',
      configFields: [],
    },
    ...overrides,
  }) as PluginListEntry;

describe('plugin OAuth provider cards', () => {
  test('a plugin with two providers yields one card per provider key', () => {
    const cards = buildPluginOAuthProviderCards(
      [
        plugin({
          oauthProvider: 'zcode',
          oauthProviders: ['zcode-bigmodel', 'zcode-zai'],
          oauthProviderLabels: { 'zcode-bigmodel': '国内站', 'zcode-zai': '国际站' },
        }),
      ],
      ''
    );

    expect(cards.map((card) => card.id)).toEqual(['zcode-bigmodel', 'zcode-zai']);
    expect(cards.map((card) => card.title)).toEqual(['ZCode · 国内站', 'ZCode · 国际站']);
    expect(cards.map((card) => card.icon)).toEqual([
      '/plugins/zcode/logo.png',
      '/plugins/zcode/logo.png',
    ]);
  });

  test('a multi-provider plugin without labels falls back to the plugin name', () => {
    const cards = buildPluginOAuthProviderCards(
      [plugin({ oauthProviders: ['zcode-bigmodel', 'zcode-zai'] })],
      ''
    );

    expect(cards.map((card) => card.id)).toEqual(['zcode-bigmodel', 'zcode-zai']);
    expect(cards.map((card) => card.title)).toEqual(['ZCode', 'ZCode']);
  });

  test('a single-entry plugin keeps the previous card shape', () => {
    const cards = buildPluginOAuthProviderCards(
      [
        plugin({
          id: 'loomy',
          oauthProvider: 'loomy',
          oauthProviderLabels: { loomy: 'Loomy' },
          metadata: null,
        }),
      ],
      ''
    );

    expect(cards).toEqual([
      {
        kind: 'plugin',
        id: 'loomy',
        title: 'loomy',
        icon: '/plugins/zcode/logo.png',
      },
    ]);
  });

  test('built-in provider ids still win and disabled plugins stay hidden', () => {
    const cards = buildPluginOAuthProviderCards(
      [
        plugin({ oauthProviders: ['codex', 'zcode-zai'] }),
        plugin({ id: 'disabled', oauthProvider: 'zcode-zai', effectiveEnabled: false }),
        plugin({ id: 'unsupported', oauthProvider: 'zcode-zai', supportsOAuth: false }),
      ],
      ''
    );

    expect(cards.map((card) => card.id)).toEqual(['zcode-zai']);
  });

  test('normalizes backend provider keys and labels before cards are built', async () => {
    const get = spyOn(apiClient, 'get').mockResolvedValue({
      plugins_enabled: true,
      plugins_dir: 'plugins',
      plugins: [
        {
          id: 'zcode',
          supports_oauth: true,
          effective_enabled: true,
          oauth_provider: 'zcode',
          oauth_providers: ['ZCode-Bigmodel', 'zcode-zai', 'bad key', ''],
          oauth_provider_labels: { 'zcode-bigmodel': '国内站', 'zcode-zai': '   ' },
        },
        {
          id: 'loomy',
          supports_oauth: true,
          effective_enabled: true,
          oauth_provider: 'loomy',
          oauth_providers: [],
          oauth_provider_labels: {},
        },
      ],
    });
    spies.push(get);

    const { plugins } = await pluginsApi.list();
    expect(plugins[0].oauthProviders).toEqual(['zcode-bigmodel', 'zcode-zai']);
    expect(plugins[0].oauthProviderLabels).toEqual({ 'zcode-bigmodel': '国内站' });
    expect(plugins[1].oauthProviders).toBeUndefined();
    expect(plugins[1].oauthProviderLabels).toBeUndefined();

    const cards = buildPluginOAuthProviderCards(plugins, '');
    expect(cards.map((card) => card.id)).toEqual(['zcode-bigmodel', 'zcode-zai', 'loomy']);
    expect(cards.map((card) => card.title)).toEqual(['zcode · 国内站', 'zcode', 'loomy']);
  });
});

describe('fingerprint browser login option', () => {
  test('is offered only where the plugin declares the capability', () => {
    // 指纹浏览器是插件自己的登录方式，宿主不能凭 provider 名字猜：声明了能力位的
    // 插件卡才带这个开关，没声明的一律不带。
    const [declared] = buildPluginOAuthProviderCards(
      [plugin({ oauthProvider: 'zcode', supportsFingerprintBrowser: true })],
      ''
    );
    expect(declared.fingerprintBrowser).toBe(true);

    const [undeclared] = buildPluginOAuthProviderCards(
      [plugin({ id: 'loomy', oauthProvider: 'loomy', supportsFingerprintBrowser: false })],
      ''
    );
    expect(undeclared.fingerprintBrowser).toBe(false);

    // 宿主没给这个字段（老版本后端）时按「不支持」处理，而不是默认开启。
    const [legacy] = buildPluginOAuthProviderCards([plugin({ oauthProvider: 'zcode-zai' })], '');
    expect(legacy.fingerprintBrowser).toBeUndefined();
  });

  test('is labelled in all six shipped locales', async () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko']) {
      const messages = JSON.parse(await Bun.file(`src/i18n/locales/${locale}.json`).text()) as {
        auth_login: Record<string, string>;
      };
      for (const key of ['zcode_fingerprint_browser', 'zcode_fingerprint_browser_hint']) {
        expect(messages.auth_login[key]?.trim()).toBeTruthy();
      }
    }
  });

  test('drives the request from the per-provider page state instead of local decoration', () => {
    const source = readFileSync('src/pages/OAuthPage.tsx', 'utf8');
    expect(source).toContain('supportsFingerprintBrowser(provider) &&');
    expect(source).toContain('checked={state.fingerprintBrowser ?? true}');
    expect(source).toContain('updateProviderState(provider.id, { fingerprintBrowser: value })');
    // 只有声明了能力位的 provider 才把选择发给宿主；其余传 undefined，保持插件默认。
    expect(source).toContain('fingerprintBrowser: fingerprintBrowserProviders.has(provider)');
  });

  test('offers no such control on built-in cards', async () => {
    const i18n = createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
    const markup = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(MemoryRouter, null, createElement(OAuthPage))
      )
    );
    expect(markup).toContain('Devin OAuth');
    expect(markup).not.toContain(en.auth_login.zcode_fingerprint_browser);
    expect(markup).not.toContain(en.auth_login.zcode_fingerprint_browser_hint);
  });
});
