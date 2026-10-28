import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import { apiKeysApi } from '@/services/api/apiKeys';
import { authFilesApi } from '@/services/api/authFiles';
import { oauthApi } from '@/services/api/oauth';
import { pluginsApi, pluginStoreApi } from '@/services/api/plugins';
import { configApi } from '@/services/api/config';
import { configFileApi } from '@/services/api/configFile';
import { logsApi } from '@/services/api/logs';
import { versionApi } from '@/services/api/version';
import { vertexApi } from '@/services/api/vertex';
import { apiKeyUsageApi } from '@/services/api/apiKeyUsage';
import {
  accountsApi,
  normalizeAccountsResponse,
  normalizeAccountView,
} from '@/services/api/accounts';
import type { AccountFailureClass, AccountQuotaState } from '@/types/accounts';

const spies: Array<{ mockRestore(): void }> = [];
const mock = (
  method: 'get' | 'put' | 'patch' | 'post' | 'delete' | 'getRaw' | 'postForm',
  value: unknown = {}
) => {
  const spy = spyOn(apiClient, method).mockResolvedValue(value as never);
  spies.push(spy);
  return spy;
};
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

describe('v8 management API contracts', () => {
  test('client keys read direct lists and replace whole lists for update/delete', async () => {
    const get = mock('get', ['first', 'second']);
    const put = mock('put');
    expect(await apiKeysApi.list()).toEqual(['first', 'second']);
    expect(get).toHaveBeenCalledWith('/config/access/api-keys');
    await apiKeysApi.update(1, 'updated');
    expect(put).toHaveBeenLastCalledWith('/config/access/api-keys', ['first', 'updated']);
    get.mockResolvedValue(['first', 'second']);
    await apiKeysApi.delete(0);
    expect(put).toHaveBeenLastCalledWith('/config/access/api-keys', ['second']);
    await expect(apiKeysApi.update(-1, 'bad')).rejects.toBeInstanceOf(RangeError);
    expect(put).toHaveBeenCalledTimes(2);
  });

  test('read/modify/write operations abort after a connection change, even when switched back', async () => {
    const first = { apiBase: 'https://first.invalid', managementKey: 'fixture' };
    apiClient.setConfig(first);
    const get = mock('get');
    const put = mock('put');
    try {
      for (const operation of [
        () => apiKeysApi.update(0, 'new'),
        () => apiKeysApi.delete(0),
        () => pluginsApi.patchConfig('example', { custom: 'new' }),
        () => authFilesApi.saveOauthExcludedModels('codex', ['blocked']),
        () => authFilesApi.deleteOauthModelAlias('codex'),
      ]) {
        get.mockImplementation(async () => {
          apiClient.setConfig({
            apiBase: 'https://second.invalid',
            managementKey: 'other-fixture',
          });
          apiClient.setConfig(first);
          return ['old-fixture'];
        });
        await expect(operation()).rejects.toMatchObject({ name: 'AbortError' });
      }
      expect(put).not.toHaveBeenCalled();
    } finally {
      apiClient.setConfig({ apiBase: '', managementKey: '' });
    }
  });

  test('OAuth configuration reads direct maps and writes direct provider lists', async () => {
    const get = mock('get', {
      codex: [{ name: 'source', alias: 'alias', 'force-mapping': false }],
    });
    const put = mock('put');
    expect(await authFilesApi.getOauthModelAlias()).toEqual({
      codex: [{ name: 'source', alias: 'alias', forceMapping: false }],
    });
    expect(get).toHaveBeenLastCalledWith('/config/oauth/model-alias');
    await authFilesApi.saveOauthModelAlias('codex', [
      { name: 'source', alias: 'alias', forceMapping: false },
    ]);
    expect(put).toHaveBeenLastCalledWith('/config/oauth/model-alias', {
      codex: [{ name: 'source', alias: 'alias', 'force-mapping': false }],
    });
    get.mockResolvedValue({ codex: ['blocked'] });
    expect(await authFilesApi.getOauthExcludedModels()).toEqual({ codex: ['blocked'] });
    expect(get).toHaveBeenLastCalledWith('/config/oauth/excluded-models');
    await authFilesApi.saveOauthExcludedModels('codex', ['blocked']);
    expect(put).toHaveBeenLastCalledWith('/config/oauth/excluded-models', { codex: ['blocked'] });
    await authFilesApi.deleteOauthModelAlias('codex');
    expect(put).toHaveBeenLastCalledWith('/config/oauth/model-alias', {});
    await authFilesApi.deleteOauthExcludedEntry('codex');
    expect(put).toHaveBeenLastCalledWith('/config/oauth/excluded-models', {});
  });

  test('OAuth writes remove case/whitespace aliases without losing unrelated raw entries', async () => {
    const other = [{ name: 'other', alias: 'other', future: 'preserve' }];
    const get = mock('get', {
      ' Codex ': [{ name: 'old', alias: 'old' }],
      codex: [{ name: 'duplicate', alias: 'duplicate' }],
      claude: other,
    });
    const put = mock('put');
    await authFilesApi.saveOauthModelAlias('codex', [{ name: 'new', alias: 'new' }]);
    expect(put).toHaveBeenLastCalledWith('/config/oauth/model-alias', {
      claude: other,
      codex: [{ name: 'new', alias: 'new' }],
    });
    await authFilesApi.deleteOauthModelAlias('codex');
    expect(put).toHaveBeenLastCalledWith('/config/oauth/model-alias', { claude: other });
    get.mockResolvedValue({ ' Codex ': ['a'], CODEX: ['b'], claude: ['keep'] });
    await authFilesApi.saveOauthExcludedModels('codex', ['new']);
    expect(put).toHaveBeenLastCalledWith('/config/oauth/excluded-models', {
      claude: ['keep'],
      codex: ['new'],
    });
    await authFilesApi.deleteOauthExcludedEntry('codex');
    expect(put).toHaveBeenLastCalledWith('/config/oauth/excluded-models', { claude: ['keep'] });
  });

  test('concurrent OAuth alias renames and deletes preserve every provider update', async () => {
    let stored: Record<string, unknown> = {
      codex: [{ name: 'codex-model', alias: 'shared' }],
      claude: [{ name: 'claude-model', alias: 'shared' }],
      gemini: [{ name: 'untouched', alias: 'keep', future: true }],
    };
    mock('get').mockImplementation(async () => structuredClone(stored));
    mock('put').mockImplementation(async (_path, value) => {
      stored = structuredClone(value) as Record<string, unknown>;
      return {};
    });

    await Promise.all([
      authFilesApi.saveOauthModelAlias('codex', [{ name: 'codex-model', alias: 'renamed' }]),
      authFilesApi.saveOauthModelAlias('claude', [{ name: 'claude-model', alias: 'renamed' }]),
    ]);
    expect(stored).toEqual({
      codex: [{ name: 'codex-model', alias: 'renamed' }],
      claude: [{ name: 'claude-model', alias: 'renamed' }],
      gemini: [{ name: 'untouched', alias: 'keep', future: true }],
    });

    await Promise.all([
      authFilesApi.deleteOauthModelAlias('codex'),
      authFilesApi.deleteOauthModelAlias('claude'),
    ]);
    expect(stored).toEqual({ gemini: [{ name: 'untouched', alias: 'keep', future: true }] });
  });

  test('concurrent excluded-model writes preserve changes and recover after a failed write', async () => {
    let stored: Record<string, unknown> = { codex: ['old'], claude: ['old'] };
    mock('get').mockImplementation(async () => structuredClone(stored));
    const put = mock('put').mockImplementation(async (_path, value) => {
      stored = structuredClone(value) as Record<string, unknown>;
      return {};
    });
    await Promise.all([
      authFilesApi.saveOauthExcludedModels('codex', ['new']),
      authFilesApi.saveOauthExcludedModels('claude', ['new']),
    ]);
    expect(stored).toEqual({ codex: ['new'], claude: ['new'] });

    put.mockRejectedValueOnce(new Error('write failed'));
    const results = await Promise.allSettled([
      authFilesApi.deleteOauthExcludedEntry('codex'),
      authFilesApi.deleteOauthExcludedEntry('claude'),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(stored).toEqual({ codex: ['new'] });
    await authFilesApi.deleteOauthExcludedEntry('codex');
    expect(stored).toEqual({});
  });

  test('queued OAuth writes abort before reading after an ABA connection switch', async () => {
    const first = { apiBase: 'https://first.invalid', managementKey: 'fixture' };
    apiClient.setConfig(first);
    let releaseRead!: (value: unknown) => void;
    const blockedRead = new Promise<unknown>((resolve) => {
      releaseRead = resolve;
    });
    let notifyRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      notifyRead = resolve;
    });
    const get = mock('get').mockImplementationOnce(async () => {
      notifyRead();
      return blockedRead;
    });
    const put = mock('put');
    try {
      const results = Promise.allSettled([
        authFilesApi.deleteOauthModelAlias('codex'),
        authFilesApi.deleteOauthModelAlias('claude'),
      ]);
      await readStarted;
      apiClient.setConfig({ apiBase: 'https://second.invalid', managementKey: 'other' });
      apiClient.setConfig(first);
      releaseRead({});
      for (const result of await results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') expect(result.reason.name).toBe('AbortError');
      }
      expect(get).toHaveBeenCalledTimes(1);
      expect(put).not.toHaveBeenCalled();
      await authFilesApi.deleteOauthModelAlias('codex');
      expect(put).toHaveBeenCalledTimes(1);
    } finally {
      releaseRead({});
      apiClient.setConfig({ apiBase: '', managementKey: '' });
    }
  });

  test('only missing persisted config fields default; auth/network/route failures propagate', async () => {
    const get = mock('get');
    const readers = [
      apiKeysApi.list,
      authFilesApi.getOauthExcludedModels,
      authFilesApi.getOauthModelAlias,
      () => pluginsApi.getConfig('example'),
    ];
    for (const reader of readers) {
      get.mockRejectedValue({ status: 404, apiCode: 'not_found' });
      expect(await reader()).toEqual(reader === apiKeysApi.list ? [] : {});
      for (const error of [{ status: 401 }, { status: 404 }, new Error('network')]) {
        get.mockRejectedValue(error);
        await expect(reader()).rejects.toBe(error);
      }
    }
    const put = mock('put');
    get.mockRejectedValue({ status: 404, apiCode: 'not_found' });
    await authFilesApi.deleteOauthModelAlias('codex');
    expect(put).toHaveBeenCalledWith('/config/oauth/model-alias', {});
    get.mockRejectedValue({ status: 405 });
    await expect(authFilesApi.deleteOauthModelAlias('codex')).rejects.toEqual({ status: 405 });
    expect(put).toHaveBeenCalledTimes(1);
  });

  test('OAuth maps UI anthropic to claude and plugins use the shared login route', async () => {
    const get = mock('get');
    const post = mock('post');
    await oauthApi.startAuth('anthropic');
    expect(get).toHaveBeenLastCalledWith('/oauth/auth-url', {
      params: { provider: 'claude', is_webui: true },
    });
    await oauthApi.startAuth('example-plugin');
    expect(get).toHaveBeenLastCalledWith('/oauth/auth-url', {
      params: { provider: 'example-plugin' },
    });
    await oauthApi.startAuth('zcode-zai', { fingerprintBrowser: true });
    expect(get).toHaveBeenLastCalledWith('/oauth/auth-url', {
      params: { provider: 'zcode-zai', fingerprint_browser: '1' },
    });
    await oauthApi.startAuth('zcode-bigmodel', { fingerprintBrowser: false });
    // 取消勾选必须显式发 0：插件默认可能开着指纹浏览器，不发参数就关不掉。
    expect(get).toHaveBeenLastCalledWith('/oauth/auth-url', {
      params: { provider: 'zcode-bigmodel', fingerprint_browser: '0' },
    });
    // 没有意见（未声明能力位的 provider）就不发这个参数，保持插件自己的默认。
    await oauthApi.startAuth('loomy');
    expect(get).toHaveBeenLastCalledWith('/oauth/auth-url', {
      params: { provider: 'loomy' },
    });
    await oauthApi.submitCallback('anthropic', 'https://example.test/callback?code=test');
    expect(post).toHaveBeenLastCalledWith(
      '/oauth/callback',
      { provider: 'claude', redirect_url: 'https://example.test/callback?code=test' },
      undefined
    );
  });

  test('plugin enabled is an instance config scalar, preserving sibling config', async () => {
    const get = mock('get', { enabled: false, custom: 'value' });
    const put = mock('put');
    const post = mock('post');
    expect(await pluginsApi.getConfig('example')).toEqual({ enabled: false, custom: 'value' });
    expect(get).toHaveBeenLastCalledWith('/config/plugins/configs/example');
    await pluginsApi.patchConfig('example', { custom: 'new' });
    expect(put).toHaveBeenLastCalledWith('/config/plugins/configs/example', {
      enabled: false,
      custom: 'new',
    });
    await pluginsApi.updateEnabled('example', false);
    expect(put).toHaveBeenLastCalledWith('/config/plugins/configs/example/enabled', false);
    await pluginStoreApi.list();
    expect(get).toHaveBeenLastCalledWith('/plugins/store');
    await pluginStoreApi.install('example', { sourceId: 'official', version: '1.2.3' });
    expect(post).toHaveBeenLastCalledWith(
      '/plugins/store/example/install?source=official&version=1.2.3',
      { version: '1.2.3' }
    );
  });

  test('plugin form clears delete fields and object edits replace instead of deep-merging', async () => {
    mock('get', {
      enabled: true,
      untouched: { future: 'preserved' },
      cleared: 'remove-me',
      edited: { keep: 1, obsolete: 2 },
    });
    const put = mock('put');
    await pluginsApi.patchConfig('example', { cleared: null, edited: { keep: 3 } });
    expect(put).toHaveBeenCalledWith('/config/plugins/configs/example', {
      enabled: true,
      untouched: { future: 'preserved' },
      edited: { keep: 3 },
    });
  });

  test('operational routes and YAML retain business payloads, config booleans are unwrapped', async () => {
    const get = mock('get');
    const put = mock('put');
    const post = mock('post');
    const raw = mock('getRaw', { data: 'config: yaml' });
    const form = mock('postForm');
    await configApi.updateRequestLog(false);
    expect(put).toHaveBeenLastCalledWith('/config/observability/logs/request-log', false);
    await logsApi.fetchLogs({ limit: 10 });
    expect(get.mock.calls.at(-1)?.[0]).toBe('/observability/logs');
    await logsApi.fetchErrorLogs();
    expect(get.mock.calls.at(-1)?.[0]).toBe('/observability/logs/errors');
    await logsApi.downloadErrorLog('file.log');
    expect(raw.mock.calls.at(-1)?.[0]).toBe('/observability/logs/errors/file.log');
    await logsApi.downloadRequestLogById('request-id');
    expect(raw.mock.calls.at(-1)?.[0]).toBe('/observability/logs/requests/request-id');
    await versionApi.checkLatest();
    expect(get).toHaveBeenLastCalledWith('/server/latest-version');
    await apiKeyUsageApi.getUsage();
    expect(get.mock.calls.at(-1)?.[0]).toBe('/observability/usage/api-keys');
    await authFilesApi.resetCooldown('auth-index-1');
    expect(post).toHaveBeenLastCalledWith('/routing/cooldown/reset', {
      auth_index: 'auth-index-1',
    });
    await vertexApi.importCredential(new File(['{}'], 'fixture.json'));
    expect(form.mock.calls.at(-1)?.[0]).toBe('/oauth/import?provider=vertex');
    expect(await configFileApi.fetchConfigYaml()).toBe('config: yaml');
    expect(raw.mock.calls.at(-1)?.[0]).toBe('/config.yaml');
    await configFileApi.saveConfigYaml('config: yaml');
    expect(put.mock.calls.at(-1)?.slice(0, 2)).toEqual(['/config.yaml', 'config: yaml']);
  });
});

// The aggregate account view is one row per credential: identity, pool state,
// routing policy, quota snapshot and request heat. Its contract is
// internal/api/handlers/management/account_view.go, and its two non-negotiable
// rules are that an undeterminable value is omitted (never 0/false) and that a
// read never probes upstream.
describe('account view API (GET /v8/management/accounts)', () => {
  const ACCOUNT_VIEW_FIXTURE = {
    provider: 'claude',
    auth_index: 'claude:index-1',
    auth_id: 'claude-primary.json',
    account_id: 'operator@example.test',
    display_name: 'Primary account',
    source_kind: 'email',
    parsed: true,
    enabled: true,
    auth_state: 'active',
    eligible: true,
    manually_disabled: false,
    cooldown_until: '2026-10-15T00:00:00Z',
    failure_class: 'quota',
    failure_reason: 'quota exhausted',
    failure_retryable: false,
    plan_id: 'pro',
    channel: 'start-plan',
    policy: 'only:start-plan',
    channels: [
      { key: 'start-plan', label: 'Start Plan (free)' },
      { key: '  api-key  ', label: 'Coding Plan (paid)' },
      { key: '   ', label: 'unusable' },
    ],
    quota_state: 'exhausted',
    fetched_at: '2026-10-14T23:00:00Z',
    quota: [
      {
        group: 'Claude',
        model: '',
        label: '  Plan credits  ',
        window: 'hourly',
        remaining_fraction: 0,
        remaining: 0,
        total: 40,
        reset_at: '2026-10-15T01:00:00Z',
        description: 'hourly window',
      },
      { window: 'plan', remaining_fraction: 0.5 },
    ],
    request_count: 12,
    success_count: 9,
    failure_count: 3,
    heatmap: [
      { bucket: '2026-10-14T23:00:00Z', success: 4, failed: 0, success_rate: 1 },
      { bucket: '2026-10-15T00:00:00Z', success: 0, failed: 0, success_rate: null },
    ],
  };

  test('reads the aggregate route without repeating the management prefix', async () => {
    const get = mock('get', { status: 'ok', accounts: [], counts: { total: 0 } });
    await accountsApi.list();
    expect(get).toHaveBeenLastCalledWith('/accounts', undefined);
    await accountsApi.list({ provider: 'claude' });
    expect(get).toHaveBeenLastCalledWith('/accounts', { params: { provider: 'claude' } });
    await accountsApi.list({ kind: 'phone' });
    expect(get).toHaveBeenLastCalledWith('/accounts', { params: { kind: 'phone' } });
    await accountsApi.list({ provider: ' claude ', kind: 'email' });
    expect(get).toHaveBeenLastCalledWith('/accounts', {
      params: { provider: 'claude', kind: 'email' },
    });
    await accountsApi.list({ provider: '   ' });
    expect(get).toHaveBeenLastCalledWith('/accounts', undefined);
  });

  test('normalizes identity, pool state, quota buckets, heatmap and counts', async () => {
    mock('get', {
      status: 'ok',
      accounts: [ACCOUNT_VIEW_FIXTURE],
      counts: { total: 1, by_provider: { claude: 1 }, by_state: { active: 1 } },
    });
    const result = await accountsApi.list({ provider: 'claude', kind: 'email' });
    expect(result.status).toBe('ok');
    expect(result.counts).toEqual({
      total: 1,
      byProvider: { claude: 1 },
      byState: { active: 1 },
    });
    const [account] = result.accounts;
    expect(account).toEqual({
      provider: 'claude',
      authIndex: 'claude:index-1',
      authId: 'claude-primary.json',
      accountId: 'operator@example.test',
      displayName: 'Primary account',
      sourceKind: 'email',
      parsed: true,
      enabled: true,
      authState: 'active',
      eligible: true,
      manuallyDisabled: false,
      cooldownUntil: '2026-10-15T00:00:00Z',
      failureClass: 'quota',
      failureReason: 'quota exhausted',
      failureRetryable: false,
      planId: 'pro',
      channel: 'start-plan',
      policy: 'only:start-plan',
      // A padded channel key is trimmed, and a channel without a key is dropped:
      // a policy selects a channel by its key, so a keyless one is not a choice.
      channels: [
        { key: 'start-plan', label: 'Start Plan (free)' },
        { key: 'api-key', label: 'Coding Plan (paid)' },
      ],
      quotaState: 'exhausted',
      fetchedAt: '2026-10-14T23:00:00Z',
      quota: [
        {
          group: 'Claude',
          label: 'Plan credits',
          window: 'hourly',
          remainingFraction: 0,
          remaining: 0,
          total: 40,
          resetAt: '2026-10-15T01:00:00Z',
          description: 'hourly window',
        },
        { window: 'plan', remainingFraction: 0.5 },
      ],
      requestCount: 12,
      successCount: 9,
      failureCount: 3,
      heatmap: [
        { bucket: '2026-10-14T23:00:00Z', success: 4, failed: 0, successRate: 1 },
        { bucket: '2026-10-15T00:00:00Z', success: 0, failed: 0 },
      ],
    });
    // auth_id is the credential's file identity, so it is the key the existing
    // per-file routes (status / fields / refresh / delete) accept.
    expect(account.authId).toBe(ACCOUNT_VIEW_FIXTURE.auth_id);
    // An empty model is "no model scope" and the backend omits it too.
    expect('model' in account.quota[0]).toBe(false);
  });

  test('unwired and null fields stay absent instead of being faked', () => {
    const absent = normalizeAccountView(ACCOUNT_VIEW_FIXTURE);
    // F1 never assigns site / supports_refresh / entitlement (F3 wires them).
    expect('site' in absent).toBe(false);
    expect('supportsRefresh' in absent).toBe(false);
    expect('entitlement' in absent).toBe(false);

    const nulled = normalizeAccountView({
      site: null,
      supports_refresh: null,
      entitlement: null,
      account_id: null,
      policy: null,
      source_kind: null,
    });
    expect('site' in nulled).toBe(false);
    expect('supportsRefresh' in nulled).toBe(false);
    expect('entitlement' in nulled).toBe(false);
    expect('accountId' in nulled).toBe(false);
    expect('policy' in nulled).toBe(false);
    expect('sourceKind' in nulled).toBe(false);

    // A real value still passes through once the backend provides one.
    const wired = normalizeAccountView({
      site: 'ap-southeast-1',
      supports_refresh: true,
      entitlement: 'ent-1',
    });
    expect(wired).toMatchObject({
      site: 'ap-southeast-1',
      supportsRefresh: true,
      entitlement: 'ent-1',
    });
  });

  test('unreported quota and heat values stay absent while real zeros survive', () => {
    const account = normalizeAccountView({
      provider: 'codex',
      auth_index: 'codex:index-1',
      auth_id: 'codex-primary.json',
      display_name: 'Codex account',
      parsed: true,
      enabled: false,
      auth_state: 'error',
      eligible: false,
      manually_disabled: true,
      quota_state: 'query-error',
      quota: [{ remaining_fraction: 1, remaining: 0 }],
      request_count: 0,
      success_count: 0,
      failure_count: 0,
      heatmap: [{ bucket: '2026-10-15T00:00:00Z', success: 0, failed: 7, success_rate: 0 }],
    });
    const [bucket] = account.quota;
    expect(bucket).toEqual({ remainingFraction: 1, remaining: 0 });
    expect(Object.keys(bucket)).toEqual(['remainingFraction', 'remaining']);
    // "all failed" (0) and "no requests" (absent) are different facts.
    expect(account.heatmap).toEqual([
      { bucket: '2026-10-15T00:00:00Z', success: 0, failed: 7, successRate: 0 },
    ]);
    expect(account.enabled).toBe(false);
    expect(account.manuallyDisabled).toBe(true);
    expect(account.quotaState).toBe('query-error');
    expect(account.quota).toHaveLength(1);
    expect(normalizeAccountView({ heatmap: null }).heatmap).toEqual([]);
    expect(normalizeAccountView({}).quota).toEqual([]);
    // A bucket without remaining_fraction is a contract violation: drop it rather than invent 0.
    expect(normalizeAccountView({ quota: [{ window: 'plan' }] }).quota).toEqual([]);
    // An explicit 0 is a real value and must survive.
    expect(normalizeAccountView({ quota: [{ remaining_fraction: 0 }] }).quota).toEqual([
      { remainingFraction: 0 },
    ]);
  });

  /**
   * `label` 是非模型桶（余额、计划总量）的行标题：契约在
   * `sdk/pluginapi/types.go:2098-2103`，`account_view.go:98` 已原样下发，
   * 面板若不认这个字段，读者就会看到一行没有名字的额度。
   */
  test('a bucket row title survives the round trip; empty and blank stay absent', () => {
    const account = normalizeAccountView({
      quota: [
        { label: '  Balance  ', remaining_fraction: 0.25 },
        { label: '   ', remaining_fraction: 0.5 },
        { model: 'glm-5.3', remaining_fraction: 1 },
      ],
    });
    expect(account.quota).toEqual([
      { remainingFraction: 0.25, label: 'Balance' },
      { remainingFraction: 0.5 },
      { remainingFraction: 1, model: 'glm-5.3' },
    ]);
    // 缺省就是缺省：没有标题的桶不造一个空串。
    expect('label' in account.quota[1]).toBe(false);
    // 标题也不能漏进 model —— 余额不是模型。
    expect('model' in account.quota[0]).toBe(false);
  });

  test('quota_state and failure_class keep their source value domains', () => {
    const quotaStates: AccountQuotaState[] = ['unknown', 'query-error', 'exhausted', 'entitled'];
    quotaStates.forEach((state) => {
      expect(normalizeAccountView({ quota_state: state }).quotaState).toBe(state);
    });
    const failureClasses: AccountFailureClass[] = [
      'auth',
      'quota',
      'risk',
      'rate',
      'network',
      'request',
      'upstream',
    ];
    failureClasses.forEach((failureClass) => {
      expect(normalizeAccountView({ failure_class: failureClass }).failureClass).toBe(failureClass);
    });
    // Values outside the vocabulary are not guessed: quota_state falls back to
    // unknown and failure_class stays absent, which is what the backend sends.
    for (const value of ['probing', 'not-entitled', 'future-state', '', null, 42, {}]) {
      const account = normalizeAccountView({ quota_state: value, failure_class: value });
      expect(account.quotaState).toBe('unknown');
      expect(account.failureClass).toBeUndefined();
      expect('failureClass' in account).toBe(false);
    }
    expect(normalizeAccountView({ auth_state: 'disabled' }).authState).toBe('disabled');
    expect(normalizeAccountView({ auth_state: 'probing' }).authState).toBe('unknown');
    expect(normalizeAccountView({ policy: 'future-policy' }).policy).toBeUndefined();
    expect(normalizeAccountView({ source_kind: 'sms' }).sourceKind).toBeUndefined();
  });

  test('empty and malformed payloads yield empty lists instead of a crash', () => {
    // The early-return branch (account_view.go:101) sends counts.total only.
    const earlyReturn = normalizeAccountsResponse({
      status: 'ok',
      accounts: [],
      counts: { total: 0 },
    });
    expect(earlyReturn).toEqual({
      status: 'ok',
      accounts: [],
      counts: { total: 0, byProvider: {}, byState: {} },
    });
    for (const payload of [null, undefined, 'nope', 42, [], { accounts: 'nope' }]) {
      expect(normalizeAccountsResponse(payload)).toEqual({
        status: '',
        accounts: [],
        counts: { total: 0, byProvider: {}, byState: {} },
      });
    }
    const mixed = normalizeAccountsResponse({ accounts: [null, 'nope', 42, {}] });
    expect(mixed.accounts).toHaveLength(1);
    expect(mixed.accounts[0]).toMatchObject({
      authId: '',
      authState: 'unknown',
      quotaState: 'unknown',
      quota: [],
      heatmap: [],
    });
  });
});
