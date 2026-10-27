import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import { AuthFileRoutingPolicySheet } from '../src/features/authFiles/components/AuthFileRoutingPolicySheet';
import { accountPolicyChannelKey, accountPolicyOnly } from '../src/features/authFiles/accountPool';

const source = readFileSync(
  new URL('../src/features/authFiles/components/AuthFileRoutingPolicySheet.tsx', import.meta.url),
  'utf8'
);

const render = (
  props: Partial<Parameters<typeof AuthFileRoutingPolicySheet>[0]> = {}
): string =>
  renderToStaticMarkup(
    createElement(AuthFileRoutingPolicySheet, {
      open: true,
      fileName: 'zcode.json',
      saving: false,
      disabled: false,
      onClose: () => {},
      onSave: () => {},
      ...props,
    })
  );

describe('routing policy vocabulary', () => {
  test('pins a channel through the open-ended only: prefix', () => {
    expect(accountPolicyOnly('start-plan')).toBe('only:start-plan');
    expect(accountPolicyChannelKey('only:start-plan')).toBe('start-plan');
  });

  test('treats a policy that pins no channel as the default', () => {
    expect(accountPolicyChannelKey(undefined)).toBeNull();
    expect(accountPolicyChannelKey('')).toBeNull();
    expect(accountPolicyChannelKey('auto')).toBeNull();
    expect(accountPolicyChannelKey('only:')).toBeNull();
    expect(accountPolicyChannelKey('only:   ')).toBeNull();
  });
});

describe('routing policy sheet presentation contract', () => {
  // 面板只显示插件上报的通道名；key 与名称都来自账号视图，面板不内置清单。
  // 插件侧给通道的兜底名称是否还叫 free/paid，是插件的事（见 07 §11.113）。
  const bothChannels = [
    { key: 'start-plan', label: 'JWT' },
    { key: 'api-key', label: 'API Key' },
  ];

  test('shows the current channel in the control', () => {
    const markup = render({ channels: bothChannels, policy: 'only:start-plan' });
    expect(markup).toContain(i18n.t('account_pool.policy_only', { name: 'JWT' }));
  });

  test('shows the default option when the credential pins no channel', () => {
    const markup = render({ channels: bothChannels });
    expect(markup).toContain(i18n.t('account_pool.policy_default'));
  });

  test('states the effect of the choice without explaining the mechanism', () => {
    const markup = render({ channels: bothChannels });
    expect(markup).toContain(i18n.t('account_pool.policy_hint'));
    expect(markup).not.toContain('start-plan-only');
    expect(markup).not.toContain('metadata');
  });

  test('offers no channel control unless there is a second channel to choose', () => {
    // 只有一条通道时「全部通道」和「只用它」行为完全相同，一条都没有更没得选：
    // 两种情况下整块都不出现——不摆一个改不动任何东西的控件，也不拿说明文字占位。
    const withoutChoice = [[], undefined, [bothChannels[0]]];
    for (const channels of withoutChoice) {
      const markup = render({ channels });
      expect(markup).not.toContain('aria-expanded');
      expect(markup).not.toContain(i18n.t('account_pool.policy_default'));
      expect(markup).not.toContain(i18n.t('account_pool.policy_hint'));
      expect(markup).toContain(i18n.t('auth_files.routing_policy_concurrency_title'));
    }
  });

  test('has no channel prose or refresh action left to render', () => {
    // 空态与「只有一条」的说明都撤掉了：留着文案或回读入口只会让人以为还有东西没出现。
    expect(source).not.toContain('policy_single_plan');
    expect(source).not.toContain('policy_no_channels');
    expect(source).not.toContain('onRefreshChannels');
    expect(source).not.toContain('EmptyState');
  });

  test('offers the same-category sync only when the category has peers', () => {
    const withPeers = render({ syncScope: { categoryLabel: 'Loomy', peerCount: 3 } });
    expect(withPeers).toContain(i18n.t('auth_files.routing_policy_sync_label'));
    expect(withPeers).toContain(
      i18n.t('auth_files.routing_policy_sync_hint', { category: 'Loomy', count: 3 })
    );
    // 只有一张凭证的分类没有「同步」可言：不摆一个勾了也没区别的控件。
    expect(render({ syncScope: { categoryLabel: 'Loomy', peerCount: 0 } })).not.toContain(
      i18n.t('auth_files.routing_policy_sync_label')
    );
  });

  test('warns that an empty list clears the same-category credentials too', () => {
    // 空表 + 勾选 = 清除。勾选是交互态，静态渲染拿不到，这里钉住源码条件。
    expect(source).toContain('syncToCategory && rows.length === 0');
    expect(source).toContain("t('auth_files.routing_policy_sync_clear_hint')");
  });

  test('submits the sync choice together with the limits', () => {
    expect(source).toContain('syncToCategory: showSync && syncToCategory');
  });

  test('locks the control and reports progress while saving', () => {
    const idle = render({ channels: bothChannels });
    const saving = render({ channels: bothChannels, saving: true });
    expect(idle).not.toContain(i18n.t('auth_files.routing_policy_saving'));
    expect(saving).toContain(i18n.t('auth_files.routing_policy_saving'));
    expect(saving).toContain('disabled=""');
  });

  test('renders nothing while closed', () => {
    expect(render({ open: false })).toBe('');
  });

  test('saves the policy and the per-model limits in one submission', () => {
    // No DOM harness: the wiring itself is the contract, so assert it in source.
    expect(source).toContain('props.onSave({');
    expect(source).toContain('modelMaxConcurrency: buildModelConcurrency(rows)');
    expect(source).not.toContain('props.onChange');
    // 选项随账号实际渠道动态生成，不再走固定枚举。
    expect(source).not.toContain('ROUTING_POLICY_VALUES');
    expect(source).toContain('routingPolicyOptions(channels, props.policy)');
  });

  test('shows a saved per-model limit and the fallback for unlisted models', () => {
    const markup = render({
      modelMaxConcurrency: [
        { model: 'glm-5.3-flash', max_concurrency: 20 },
        { model: 'glm-5.3', max_concurrency: 1 },
      ],
      maxConcurrencyDefault: 3,
    });
    expect(markup).toContain('glm-5.3-flash');
    // 「其他模型」只报生效值，不解释继承层级。
    expect(markup).toContain(
      i18n.t('auth_files.routing_policy_concurrency_default', { limit: 3 })
    );
    expect(markup).toContain(i18n.t('auth_files.routing_policy_concurrency_zero_hint'));
  });

  test('offers the first row instead of shipping an empty limits table', () => {
    const markup = render();
    expect(markup).toContain(i18n.t('auth_files.routing_policy_concurrency_title'));
    expect(markup).toContain(i18n.t('auth_files.routing_policy_concurrency_add'));
    expect(markup).not.toContain('model_max_concurrency');
  });

  test('labels the model and limit fields on an editable row', () => {
    const markup = render({
      modelMaxConcurrency: [{ model: 'glm-5.3', max_concurrency: 2 }],
    });
    expect(markup).toContain(i18n.t('auth_files.routing_policy_concurrency_model'));
    expect(markup).toContain(i18n.t('auth_files.routing_policy_concurrency_limit'));
    expect(markup).toContain(i18n.t('auth_files.routing_policy_concurrency_remove', { model: 'glm-5.3' }));
  });
});