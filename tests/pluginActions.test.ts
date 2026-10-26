import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { buildActionPayload } from '@/features/actions/actionPayload';
import { collectResultLinks } from '@/features/actions/actionResultLinks';
import { PluginActionCard } from '@/features/actions/PluginActionCard';
import type { PluginAction } from '@/services/api/actions';

/**
 * 插件动作是「基座渲染插件声明的操作」这条链路的用户侧。这里锁两件事：
 *  1. 面板调的是基座的 `/actions`、`/jobs` 路由，而不是任何插件自建路径；
 *  2. 通用卡片按声明渲染（参数表单、危险/长任务标记），并且空值不入参 ——
 *     动作方把「没填」当作「全部」，发一个空串会变成「名为空的账号」。
 */

const read = (path: string) =>
  readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

const action = (overrides: Partial<PluginAction> = {}): PluginAction => ({
  pluginId: 'loomy',
  key: 'loomy.rewards-bind',
  title: '绑定邀请码',
  description: '为指定账号绑定一个邀请码。',
  method: 'POST',
  params: [
    { name: 'auth_index', title: '账号', type: 'string', required: false, options: [] },
    { name: 'code', title: '邀请码', type: 'string', required: false, options: [] },
  ],
  destructive: true,
  longRunning: false,
  ...overrides,
});

describe('the actions page reads the base action and job routes', () => {
  test('the api module calls the base routes and nothing plugin-specific', () => {
    const api = read('services/api/actions.ts');
    expect(api).toContain("apiClient.get('/actions')");
    expect(api).toContain("apiClient.post(`/actions/${encodeURIComponent(key)}`");
    expect(api).toContain("apiClient.get('/jobs')");
    expect(api).toContain("apiClient.get(`/jobs/${encodeURIComponent(id)}`");
    expect(api).toContain("apiClient.delete(`/jobs/${encodeURIComponent(id)}`");
    expect(api).not.toContain('/v0/management/plugins');
  });

  test('the page does not reach into a plugin route or its own HTML', () => {
    for (const name of ['PluginActionsPage.tsx', 'PluginActionCard.tsx']) {
      const source = read(`features/actions/${name}`);
      expect(source).not.toContain('/v0/management/plugins');
      expect(source).not.toContain('plugin-pages');
    }
  });
});

describe('buildActionPayload keeps only what the operator filled in', () => {
  test('empty optional values are omitted, so the plugin sees "all"', () => {
    expect(buildActionPayload(action(), {})).toEqual({});
    expect(buildActionPayload(action(), { auth_index: '  ', code: '' })).toEqual({});
  });

  test('filled values are sent trimmed', () => {
    expect(buildActionPayload(action(), { auth_index: ' abc123 ', code: ' X1 ' })).toEqual({
      auth_index: 'abc123',
      code: 'X1',
    });
  });

  test('boolean parameters are only sent when true', () => {
    const withFlag = action({
      params: [{ name: 'dry_run', title: '试运行', type: 'bool', required: false, options: [] }],
    });
    expect(buildActionPayload(withFlag, { dry_run: false })).toEqual({});
    expect(buildActionPayload(withFlag, { dry_run: true })).toEqual({ dry_run: true });
  });
});

describe('PluginActionCard renders a declared action', () => {
  test('shows the title, description, parameter labels and the irreversible mark', () => {
    const markup = renderToStaticMarkup(
      createElement(PluginActionCard, {
        action: action(),
        busy: false,
        onTrigger: () => {},
      })
    );
    expect(markup).toContain('绑定邀请码');
    expect(markup).toContain('为指定账号绑定一个邀请码。');
    expect(markup).toContain('账号');
    expect(markup).toContain('邀请码');
    expect(markup).toContain(i18n.t('plugin_actions.destructive'));
    expect(markup).toContain(i18n.t('plugin_actions.run'));
  });

  test('marks a long-running action and keeps a plain one unmarked', () => {
    const longRunning = renderToStaticMarkup(
      createElement(PluginActionCard, {
        action: action({ destructive: false, longRunning: true }),
        busy: false,
        onTrigger: () => {},
      })
    );
    expect(longRunning).toContain(i18n.t('plugin_actions.long_running'));
    expect(longRunning).not.toContain(i18n.t('plugin_actions.destructive'));
  });

  test('offers a returned link as copyable text with a copy button, never a navigation', () => {
    const markup = renderToStaticMarkup(
      createElement(PluginActionCard, {
        action: action({ destructive: false }),
        busy: false,
        result: { status: 'ok', invite_link: 'https://zcode.z.ai/invite/6WYWVN2M' },
        onTrigger: () => {},
      })
    );
    expect(markup).toContain(i18n.t('plugin_actions.result_links'));
    // 链接必须是可复制文本：点一下就跳走会让操作者丢掉刚跑完的结果。
    expect(markup).toContain('https://zcode.z.ai/invite/6WYWVN2M');
    expect(markup).not.toContain('href="https://zcode.z.ai/invite/6WYWVN2M"');
    expect(markup).not.toContain('target="_blank"');
    expect(markup).toContain(i18n.t('common.copy'));
  });
});

describe('collectResultLinks finds only shareable links', () => {
  test('walks the result, keeps absolute http(s) links, drops duplicates and prose', () => {
    const links = collectResultLinks({
      inviter: { name: 'zcode-2a48afcd', invited_total: 0 },
      invite_link: 'https://zcode.z.ai/invite/6WYWVN2M',
      notes: ['打开 https://zcode.z.ai/invite/6WYWVN2M 完成绑定', 'javascript:alert(1)'],
      matches: [{ link: ' https://example.com/a ' }],
    });
    expect(links).toEqual(['https://zcode.z.ai/invite/6WYWVN2M', 'https://example.com/a']);
  });

  test('stops at five links so a noisy result stays readable', () => {
    const links = collectResultLinks(
      Array.from({ length: 8 }, (_, index) => ({ link: `https://example.com/${index}` }))
    );
    expect(links).toHaveLength(5);
  });
});

describe('the actions page is a plugin rail, not a flat grid', () => {
  test('one plugin is shown at a time, guided by two steps', () => {
    const source = read('features/actions/PluginActionsPage.tsx');
    expect(source).toContain('styles.rail');
    expect(source).toContain("t('plugin_actions.step_pick')");
    expect(source).toContain("t('plugin_actions.step_run')");
    expect(source).toContain('activeGroup.actions');
    expect(source).not.toContain('styles.grid');
  });

  test('names no plugin in the page source, so a new plugin needs no page change', () => {
    const source = read('features/actions/PluginActionsPage.tsx');
    for (const pluginId of ['loomy', 'zcode', 'workbuddy']) {
      expect(source).not.toContain(`'${pluginId}'`);
    }
  });
});
