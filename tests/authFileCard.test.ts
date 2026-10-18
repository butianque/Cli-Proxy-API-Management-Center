import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The quota host binds CSS-module classes at import time, which Bun cannot render.
// Keep these source contracts small; browser checks cover the actual card interactions.
const source = readFileSync(
  new URL('../src/features/authFiles/components/AuthFileCard.tsx', import.meta.url),
  'utf8'
);
const styles = readFileSync(
  new URL('../src/features/authFiles/components/AuthFileCard.module.scss', import.meta.url),
  'utf8'
);

describe('auth file card presentation contract', () => {
  test('uses identity rather than logos or duplicate status badges', () => {
    expect(source).not.toContain('<img');
    expect(source).not.toContain('getAuthFileIcon');
    expect(source).not.toContain('stateBadge');
    expect(source).toContain('<h3');
    expect(source).toContain('{identity.primary}');
    expect(source).toContain('{identity.secondary}');
  });

  test('uses one footer toggle and credential-specific accessible names', () => {
    const header = source.split('<header')[1].split('</header>')[0];
    const footer = source.split('<footer')[1].split('</footer>')[0];
    expect(source.match(/<ToggleSwitch/g)).toHaveLength(1);
    expect(header).not.toContain('<ToggleSwitch');
    expect(header).toContain("ariaLabel={t('auth_files.card_select', { name: file.name })}");
    expect(header).not.toContain('aria-label=');
    expect(footer).toContain('<ToggleSwitch');
    expect(footer).toContain("t('auth_files.card_toggle', { name: file.name })");
    expect(footer).toContain('checked={!file.disabled}');
    expect(footer).toContain('statusUpdating[getAuthFileRefreshKey(file)] === true ||');
    expect(footer).toContain('isManualRefreshing');
    expect(footer).toContain('!isRuntimeOnly &&');
  });

  test('dims disabled card content but keeps the re-enable controls clear', () => {
    expect(source).toContain("file.disabled === true ? styles.cardDisabled : ''");
    expect(styles).toMatch(/\.cardDisabled\s*>\s*:not\(\.actions\)\s*\{\s*opacity:\s*0\.68;/);
    expect(styles).not.toMatch(/\.cardDisabled\s*\{[^}]*opacity:/);
  });

  test('uses a plain-text weight tooltip while preserving the details link', () => {
    expect(source).toContain("title={t('auth_files.weight_tooltip')}");
    expect(source).not.toContain("title={t('auth_files.weight_hint')}");
    const detailsSource = readFileSync(
      new URL('../src/features/authFiles/components/AuthFileDetailsSheet.tsx', import.meta.url),
      'utf8'
    );
    expect(detailsSource).toContain('i18nKey="auth_files.weight_hint"');

    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru']) {
      const { auth_files: messages } = JSON.parse(
        readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8')
      ) as { auth_files: Record<string, string> };
      expect(messages.weight_tooltip).toBeTruthy();
      expect(messages.weight_tooltip).not.toMatch(/<[^>]+>/);
      expect(messages.weight_hint).toContain('<settingsLink>');
      expect(messages.weight_hint).toContain('</settingsLink>');
      expect(messages.weight_tooltip).toBe(messages.weight_hint.replace(/<\/?settingsLink>/g, ''));
    }
  });

  test('retains individual management actions and warning detail', () => {
    for (const handler of [
      'onShowModels(file)',
      'onDownload(file.name)',
      'onManualRefresh(file)',
      'onCooldownReset(file)',
      'onOpenPrefixProxyEditor(file)',
      'onDelete(file.name)',
    ]) {
      expect(source).toContain(handler);
    }
    expect(source).toContain('rawStatusMessage && hasStatusWarning');
    expect(source).toContain('showManualRefreshButton');
    expect(source).toContain('file.disabled ||');
  });

  test('keeps the routing policy control out of the card body', () => {
    expect(source).not.toContain('POLICY_VALUES');
    expect(source).not.toContain('policyBlock');
    expect(source).not.toContain("from '@/components/ui/Select'");
    expect(source).not.toContain('policyOptions');
    expect(source).toContain('showPolicyButton');
    expect(source).toContain('AuthFileRoutingPolicySheet');
    expect(source).toContain("t('auth_files.routing_policy_button')");
  });

  test('orders the action row as refresh, routing policy, download', () => {
    const actions = source.split('<footer')[1].split('</footer>')[0];
    const refresh = actions.indexOf('onManualRefresh(file)');
    const policy = actions.indexOf("t('auth_files.routing_policy_button')");
    const download = actions.indexOf('onDownload(file.name)');
    expect(refresh).toBeGreaterThanOrEqual(0);
    expect(policy).toBeGreaterThan(refresh);
    expect(download).toBeGreaterThan(policy);
  });

  test('offers the policy control only where the account pool knows the credential', () => {
    expect(source).toContain('Boolean(account) && Boolean(onPolicyChange)');
  });

  test('names the routing policy control in every locale', () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko']) {
      const { auth_files: messages } = JSON.parse(
        readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8')
      ) as { auth_files: Record<string, string> };
      expect(messages.routing_policy_button).toBeTruthy();
      expect(messages.routing_policy_saving).toBeTruthy();
    }
  });

  test('splits the plugin note into one identity line plus reading lines', async () => {
    const { splitNoteSegments } = await import('../src/features/authFiles/noteSegments');
    expect(splitNoteSegments('Global · aogna (global)')).toEqual(['Global · aogna (global)']);
    expect(
      splitNoteSegments(
        'Global · aogna (global) · 【用量】(自 2026-10-18) 今日 请求 9 ｜ 该账号暂未解析出额度窗口 ｜ 累计 请求 9'
      )
    ).toEqual([
      'Global · aogna (global) · 【用量】(自 2026-10-18) 今日 请求 9',
      '该账号暂未解析出额度窗口',
      '累计 请求 9',
    ]);
    // 分段符两侧的空段不占一行；超出上限的段只留在悬停全文里。
    expect(splitNoteSegments(' a ｜ ｜ b ｜ c ｜ d ')).toEqual(['a', 'b', 'c']);
    expect(splitNoteSegments('   ')).toEqual([]);
    expect(source).toContain('const noteSegments = splitNoteSegments(noteValue)');
    expect(source).toContain('styles.noteDetail');
    expect(source).toContain('title={noteValue}');
    expect(styles).toMatch(/\.noteDetail\s*\{[^}]*@include text-ellipsis;/);
  });
});
