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
      onChange: () => {},
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
  test('shows the current policy in the control', () => {
    const markup = render({
      channels: [{ key: 'start-plan', label: 'Start Plan (free)' }],
      policy: 'only:start-plan',
    });
    expect(markup).toContain(i18n.t('account_pool.policy_only', { name: 'Start Plan (free)' }));
  });

  test('shows the default option when the credential carries no policy', () => {
    const markup = render();
    expect(markup).toContain(i18n.t('account_pool.policy_default'));
  });

  test('states the effect of the choice without explaining the mechanism', () => {
    const markup = render();
    expect(markup).toContain(i18n.t('account_pool.policy_hint'));
    expect(markup).not.toContain('start-plan-only');
    expect(markup).not.toContain('metadata');
  });

  test('locks the control and reports progress while saving', () => {
    const idle = render();
    const saving = render({ saving: true });
    expect(idle).not.toContain(i18n.t('auth_files.routing_policy_saving'));
    expect(saving).toContain(i18n.t('auth_files.routing_policy_saving'));
    expect(saving).toContain('disabled=""');
  });

  test('renders nothing while closed', () => {
    expect(render({ open: false })).toBe('');
  });

  test('saves as soon as a value is picked', () => {
    // No DOM harness: the wiring itself is the contract, so assert it in source.
    expect(source).toContain('props.onChange(picked ? picked.value : null)');
    // 选项随账号实际渠道动态生成，不再走固定枚举。
    expect(source).not.toContain('ROUTING_POLICY_VALUES');
    expect(source).toContain('routingPolicyOptions(props.channels ?? [], props.policy)');
  });
});
