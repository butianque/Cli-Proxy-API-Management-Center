import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { buildActionPayload } from '@/features/actions/actionPayload';
import {
  collectResultLinks,
  collectResultNotes,
  collectResultSteps,
} from '@/features/actions/actionResultLinks';
import { PluginActionCard } from '@/features/actions/PluginActionCard';
import { PluginActionsPage, PluginJobList } from '@/features/actions/PluginActionsPage';
import type { PluginAction, PluginJob } from '@/services/api/actions';

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

describe('steps turn one result into a checklist', () => {
  const steps = [
    {
      key: 'bind',
      index: 1,
      title: '绑定邀请码',
      state: 'todo',
      detail: '用浏览器登录 zcode.z.ai，打开下面的链接',
      link: 'https://zcode.z.ai/invite/6WYWVN2M',
      action: { key: 'zcode.referral-redeem', label: '检查进度', params: { invitee: 'idx-a' } },
    },
    { key: 'message', index: 2, title: '发一条消息', state: 'blocked', detail: '绑定成功后自动发送' },
    { key: 'device', index: 3, title: '客户端登录', state: 'done' },
  ];

  test('the shape is normalized: order by index, unknown state becomes todo, links must be http(s)', () => {
    const collected = collectResultSteps({
      status: 'not_bound',
      steps: [
        { key: 'device', index: 3, title: '客户端登录', state: 'done' },
        { key: 'bind', index: 1, title: '绑定邀请码', state: 'weird', link: 'javascript:alert(1)' },
        { key: 'message', index: 2, title: '发一条消息', state: 'blocked' },
      ],
    });
    expect(collected.map((step) => step.key)).toEqual(['bind', 'message', 'device']);
    expect(collected[0]?.state).toBe('todo');
    expect(collected[0]?.link).toBeUndefined();
    expect(collected[1]?.state).toBe('blocked');
  });

  test('a result without steps or with unnamed entries adds nothing', () => {
    expect(collectResultSteps({ status: 'ok' })).toEqual([]);
    expect(collectResultSteps({ steps: [{ title: 'no key' }, { key: 'k' }] })).toEqual([]);
    expect(collectResultSteps('not an object')).toEqual([]);
  });

  test('a job renders each step with its state, link and next action', () => {
    const markup = renderJobList([
      job({ title: 'Complete onboarding', result: { status: 'not_bound', steps } }),
    ]);

    expect(markup).toContain(i18n.t('plugin_actions.steps_title'));
    // 每一步都要能看出「在哪一步、差什么」。
    expect(markup).toContain('1');
    expect(markup).toContain('绑定邀请码');
    expect(markup).toContain(i18n.t('plugin_actions.step_state_todo'));
    expect(markup).toContain(i18n.t('plugin_actions.step_state_blocked'));
    expect(markup).toContain(i18n.t('plugin_actions.step_state_done'));
    expect(markup).toContain('发一条消息');
    // 链接是复制对象，不是跳转。
    expect(markup).toContain('https://zcode.z.ai/invite/6WYWVN2M');
    expect(markup).not.toContain('href="https://zcode.z.ai/invite/6WYWVN2M"');
    // 下一步就是再跑一次，按钮直接带好参数。
    expect(markup).toContain('检查进度');
  });

  test('a step link is not repeated by the generic link block in the action card', () => {
    const markup = renderToStaticMarkup(
      createElement(PluginActionCard, {
        action: action({ destructive: false }),
        busy: false,
        result: { status: 'not_bound', steps },
        onTrigger: () => {},
        onRunAction: () => {},
      })
    );
    // 步骤里已经带着自己的链接，再列一遍同样的地址就是重复。
    expect(markup).toContain('https://zcode.z.ai/invite/6WYWVN2M');
    expect(markup).not.toContain(i18n.t('plugin_actions.result_links'));
  });
});

describe('collectResultNotes turns the plugin’s sentences into the only explanation', () => {
  test('keeps trimmed, non-empty, unique notes and caps them', () => {
    expect(
      collectResultNotes({
        notes: ['  打开前先确认登录的是 a@b.com  ', '', 42, '同一句', '同一句', 'n2', 'n3', 'n4'],
      })
    ).toEqual(['打开前先确认登录的是 a@b.com', '同一句', 'n2', 'n3']);
    expect(collectResultNotes({ notes: 'not a list' })).toEqual([]);
    expect(collectResultNotes('not an object')).toEqual([]);
  });

  test('a result without steps shows its notes, a result with steps does not repeat them', () => {
    const notes = ['链接不认账号：打开前先确认登录的是 a@b.com', '这个链接对池里 3 个号都有效'];
    const withoutSteps = renderToStaticMarkup(
      createElement(PluginActionCard, {
        action: action({ destructive: false }),
        busy: false,
        result: { status: 'ok', invite_link: 'https://zcode.z.ai/invite/ABC', notes },
        onTrigger: () => {},
      })
    );
    expect(withoutSteps).toContain(`>${notes[0]}<`);
    expect(withoutSteps).toContain(`>${notes[1]}<`);

    const withSteps = renderToStaticMarkup(
      createElement(PluginActionCard, {
        action: action({ destructive: false }),
        busy: false,
        result: {
          status: 'not_bound',
          notes,
          steps: [{ key: 'bind', index: 1, title: '绑定邀请码', state: 'todo', detail: notes[0] }],
        },
        onTrigger: () => {},
      })
    );
    // 步骤已经逐条说过的话，不再作为说明重复一遍（原始 JSON 里当然还在）。
    expect(withSteps).not.toContain(`>${notes[1]}<`);
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

const job = (overrides: Partial<PluginJob> = {}): PluginJob => ({
  id: 'job-1',
  pluginId: 'loomy',
  key: 'loomy.rewards-bind',
  title: 'Rewards bind',
  state: 'done',
  progress: 1,
  message: '',
  startedAt: 1_700_000_000_000,
  logs: [],
  ...overrides,
});

const renderJobList = (jobs: PluginJob[]) =>
  renderToStaticMarkup(
    createElement(PluginJobList, { jobs, onCancel: () => {}, onRunChoice: () => {} })
  );

describe('the job list stays short until the operator asks for more', () => {
  test('eight finished jobs plus a running one: five finished shown, the running one always shown', () => {
    const jobs = [
      job({ id: 'live', title: 'Live 01', state: 'running', progress: 0.5 }),
      ...Array.from({ length: 8 }, (_, index) =>
        job({ id: `done-${index}`, title: `Finished 0${index + 1}` })
      ),
    ];
    const markup = renderJobList(jobs);

    // 后端按新→旧下发，默认露最近五条，顺序不能被打乱。
    expect(markup.match(/Finished 0\d/g)).toEqual([
      'Finished 01',
      'Finished 02',
      'Finished 03',
      'Finished 04',
      'Finished 05',
    ]);
    // 运行中的任务不能被折叠掉：它带着唯一的取消入口。
    expect(markup).toContain('Live 01');
    expect(markup).toContain(i18n.t('plugin_actions.job_cancel'));
    expect(markup).toContain(i18n.t('plugin_actions.jobs_running'));
    expect(markup).toContain(i18n.t('plugin_actions.jobs_finished'));
    // 更早的任务要有入口，并说清总数。
    expect(markup).toContain(i18n.t('plugin_actions.jobs_show_earlier'));
    expect(markup).toContain(i18n.t('plugin_actions.jobs_total', { count: 8 }));
  });

  test('five finished jobs or fewer need no "show earlier" control', () => {
    const markup = renderJobList(
      Array.from({ length: 5 }, (_, index) => job({ id: `done-${index}`, title: `Finished 0${index + 1}` }))
    );
    expect(markup.match(/Finished 0\d/g)).toHaveLength(5);
    expect(markup).not.toContain(i18n.t('plugin_actions.jobs_show_earlier'));
  });

  test('without jobs the page renders no job card at all', () => {
    const markup = renderToStaticMarkup(createElement(PluginActionsPage));
    expect(markup).not.toContain(i18n.t('plugin_actions.jobs_title'));
  });

  test('a finished job shows its result and one button per named candidate', () => {
    const markup = renderJobList([
      job({
        title: 'Complete onboarding',
        message: '3 accounts still need a task',
        result: {
          status: 'needs_target',
          choices: [
            { label: 'Night lamp', hint: 'zcode-aaaa · 1/3', params: { invitee: 'idx-a' } },
            { label: 'Second', hint: 'zcode-bbbb · 0/3', params: { invitee: 'idx-b' } },
          ],
        },
      }),
    ]);

    // 候选必须点名到账号，人才能对上自己刚才登录的是哪一个。
    expect(markup).toContain('Night lamp');
    expect(markup).toContain('zcode-aaaa · 1/3');
    expect(markup).toContain('Second');
    // 一排按钮前面必须有句话，说明「点它就是继续」。
    expect(markup).toContain(i18n.t('plugin_actions.choices_title'));
    // 结果的原始 JSON 仍然可查，但要点开才占地方。
    expect(markup).toContain(i18n.t('plugin_actions.job_result'));
    expect(markup).toContain('needs_target');
  });
});
