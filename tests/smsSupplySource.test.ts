import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { SUPPLY_PHONE_BASE } from '../src/services/api/sms';

/**
 * The phone category used to read the plugin's own routes
 * (`/v0/management/plugins/loomy/sms/*`). It now reads the base's supply
 * routes, because renting a number is base capability, not plugin capability.
 *
 * These checks pin the seam: the panel must reach the base prefix and nothing
 * may quietly fall back to the plugin (the plugin keeps serving until the
 * migration removes it, so a stray call would go unnoticed at runtime).
 */

const read = (path: string) =>
  readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

describe('the phone category reads the base supply routes', () => {
  test('the base prefix matches the backend mount point', () => {
    // Mirrors server_management_v8.go: v8.GET("/supply/phone/status", ...) etc.
    expect(SUPPLY_PHONE_BASE).toBe('/supply/phone');
  });

  test('the api module calls every phone route under the base prefix', () => {
    const api = read('services/api/sms.ts');
    for (const route of ['status', 'refresh', 'guardrail', 'channel', 'api', 'web-credential', 'web-login']) {
      expect(api).toContain('${SUPPLY_PHONE_BASE}/' + route);
    }
    // The plugin route must be gone: no leftover absolute plugin URL, no helper
    // that builds one, no `baseURL: ''` escape hatch that only plugin URLs need.
    expect(api).not.toContain('/v0/management/plugins/loomy/sms');
    expect(api).not.toContain('resolvePluginAssetURL');
    expect(api).not.toContain("baseURL: ''");
  });

  test('the active supply page reaches no plugin sms route', () => {
    for (const name of [
      'SmsServicePage.tsx',
      'PhoneSupplyView.tsx',
      'SupplyChannelCard.tsx',
      'ChannelEditorModal.tsx',
    ]) {
      const source = read(`features/sms/${name}`);
      expect(source).not.toContain('/v0/management/plugins/loomy/sms');
    }
  });

  test('the active supply editor no longer needs the apiBase to build a request', () => {
    // These routes are under the client's own management prefix, so the pages
    // must not thread `apiBase` into the calls any more. The `apiBase` identifier
    // and any `smsApi.*(...)` call carrying it are the regression signals.
    for (const name of [
      'SmsServicePage.tsx',
      'PhoneSupplyView.tsx',
      'SupplyChannelCard.tsx',
      'ChannelEditorModal.tsx',
    ]) {
      const source = read(`features/sms/${name}`);
      expect(source).not.toContain('apiBase');
      expect(source).not.toMatch(/smsApi\.\w+\(\s*apiBase/);
    }
    const page = read('features/sms/SmsServicePage.tsx');
    expect(page).toContain('<SupplyChannelCard');
    expect(page).toContain('<PhoneSupplyView />');
  });
});
