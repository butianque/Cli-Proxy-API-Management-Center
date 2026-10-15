/**
 * 渠道配置弹窗（选平台 → 选登录方式 → 填连接信息）。
 *
 * 交互契约（用户 2026-10-10 拍板，2026-10-10 二次修正）：
 * - ① 选择平台：预置平台（豪猪）直接可选，另给「自定义」兜底；
 * - ② 登录方式：**两个 Tab 二选一**（同一平台的两种取数方式，不是两组独立数据）——
 *     · **API 登录**：API 账号 + API 密码（+ 可选服务地址）→ 取号/收码；
 *     · **网页登录**：网页账号 + 网页密码 → 一键获取网页会话，用于管理渠道；
 *     Tab 只切换「当前在配哪一种」，保存时**只提交当前 Tab**，不会互相覆盖；
 * - ③ 测试连接：真实调 `/sms/status`，按三态判定（成功 / 失败 / 凭据未就绪）。
 *
 * 保存契约（本轮修正）：
 * - **唯一判据**：当前 Tab 的两个必填框都填了才提交。空提交既不发请求，也不关窗；
 *   只填一个 → 在缺的那个框上说「必填」，两个都空 → 在保存按钮旁说明；
 * - 保存成功后**不自动关窗**，就地显示「已保存」，由使用者自己关；
 * - 后端把「空字段」当「保留旧值」，所以空值绝不会覆盖已存凭据
 *   （历史事故：网页账号覆盖了 API 密钥，见 `docs/ops/07` §11.22）。
 *
 * ⚠️ UI 语汇：面向使用者，不暴露后端字段名（api_user / PHPSESSID / CK 等）。
 * ⚠️ 安全：主密码（`passphrase`）只从 SecretGate 的门取（内存中，登录时验证过的），
 * 本组件不自行收集密码；锁定态下保存会被后端 401 拒绝，此处如实提示。
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { IconAlertTriangle, IconCheckCircle2, IconRefreshCw } from '@/components/ui/icons';
import { smsApi, type CredentialWriteResult } from '@/services/api/sms';
import { useSecretGateStore } from '@/stores/useSecretGateStore';
import { SMS_PLATFORMS } from './smsMapping';
import type { SmsPlatform } from './types';
import styles from './ChannelConfigModal.module.scss';

export interface ChannelConfigModalProps {
  open: boolean;
  onClose: () => void;
  /** 已配置情况（用于回填「已存」角标与占位提示）。 */
  existing?: {
    accountPresent: boolean;
    cookiePresent: boolean;
    webPresent: boolean;
    /** 已存 API 账号的脱敏提示（如 `e3••••f8`）。 */
    apiUserHint?: string;
    /** 已存网页账号的脱敏提示（如 `li••••88`）。 */
    webUserHint?: string;
  } | null;
  /** 保存成功后回调（父组件据此刷新状态）。 */
  onSaved: () => void;
}

/** 登录方式：同一个平台的两条取数路径，用 Tab 切换，不并存。 */
type LoginTab = 'api' | 'web';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; balance?: number }
  | { kind: 'fail'; message: string }
  | { kind: 'unavailable'; message: string };

/** 获取网页会话的状态。 */
type WebLoginState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; channels: number }
  | { kind: 'fail'; message: string };

/** 保存按钮旁的一条提示。 */
type SaveNotice = { tone: 'ok' | 'warn'; text: string };

export function ChannelConfigModal({ open, onClose, existing, onSaved }: ChannelConfigModalProps) {
  const { t } = useTranslation();
  const passphrase = useSecretGateStore((state) => state.passphrase);
  const gatePhase = useSecretGateStore((state) => state.phase);

  const [platformId, setPlatformId] = useState<string>(SMS_PLATFORMS[0].id);
  const [tab, setTab] = useState<LoginTab>('api');
  // API 登录
  const [apiUser, setApiUser] = useState('');
  const [apiPass, setApiPass] = useState('');
  // 仅「自定义」平台用：内置平台地址由后端固定，不采集。
  const [endpoint, setEndpoint] = useState('');
  // 网页登录
  const [webUser, setWebUser] = useState('');
  const [webPass, setWebPass] = useState('');
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [webLogin, setWebLogin] = useState<WebLoginState>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const platform = useMemo(
    () => SMS_PLATFORMS.find((item) => item.id === platformId) ?? SMS_PLATFORMS[0],
    [platformId]
  );
  // 内置平台的地址由后端固定（`haozhumaDefaultEndpoint`），界面只读展示；
  // 自定义平台才让使用者自己填。
  const endpointLocked = Boolean(platform.defaultEndpoint);

  // 打开时重置表单为「只显示已存状态」。
  useEffect(() => {
    if (!open) return;
    setPlatformId(SMS_PLATFORMS[0].id);
    setTab('api');
    setApiUser('');
    setApiPass('');
    setEndpoint('');
    setWebUser('');
    setWebPass('');
    setTest({ kind: 'idle' });
    setWebLogin({ kind: 'idle' });
    setSubmitAttempted(false);
    setSaveError(null);
    setSaved(false);
  }, [open]);

  // 上一次的测试结果、保存结果与提示，都随输入变化失效。
  const resetFeedback = () => {
    setTest({ kind: 'idle' });
    setWebLogin({ kind: 'idle' });
    setSaveError(null);
    setSaved(false);
  };

  const handlePlatformChange = (next: SmsPlatform) => {
    setPlatformId(next.id);
    setEndpoint('');
    setSubmitAttempted(false);
    resetFeedback();
  };

  const switchTab = (next: LoginTab) => {
    setTab(next);
    setSubmitAttempted(false);
    resetFeedback();
  };

  // 当前 Tab 的两个必填框。**唯一判据**：两个都填了才提交。
  // 只填一个不写库（缺哪个就在哪个框上说），两个都空更不写——
  // 后端把空字段当「保留旧值」，空提交只会看起来像保存成功。
  const accountInput = tab === 'api' ? apiUser : webUser;
  const passwordInput = tab === 'api' ? apiPass : webPass;
  const accountFilled = accountInput.trim() !== '';
  const passwordFilled = passwordInput.trim() !== '';
  const complete = accountFilled && passwordFilled;
  const anyInput = accountFilled || passwordFilled;

  // 点保存后的反馈只讲一件事：一个框空 → 就在那个框上说「必填」；
  // 两个都空 → 在保存按钮旁说清楚要先填什么。
  const showFieldErrors = submitAttempted && !complete && anyInput;
  const showNeedCredentials = submitAttempted && !complete && !anyInput;

  // 保存按钮旁同时只出现一条提示，按优先级取第一条成立的。
  let saveNotice: SaveNotice | null = null;
  if (gatePhase === 'locked') {
    saveNotice = { tone: 'warn', text: t('sms_service.config_gate_locked_hint') };
  } else if (saveError) {
    saveNotice = { tone: 'warn', text: saveError };
  } else if (saved) {
    saveNotice = { tone: 'ok', text: t('sms_service.config_saved') };
  } else if (showNeedCredentials) {
    saveNotice = { tone: 'warn', text: t('sms_service.config_need_credentials') };
  }

  const applySaveResults = (results: CredentialWriteResult[]) => {
    const failure = results.find((item) => !item.ok);
    if (!failure || failure.ok) return true;
    if (failure.reason === 'wrong-passphrase') {
      setSaveError(t('sms_service.config_err_passphrase'));
    } else if (failure.reason === 'locked') {
      setSaveError(t('sms_service.config_err_locked'));
    } else {
      setSaveError(failure.message || t('sms_service.config_err_generic'));
    }
    return false;
  };

  /**
   * 保存：只提交当前 Tab，避免另一条路径被空值覆盖。
   * 两个必填框没填齐就不发请求，只给提示——不静默关窗，也不假装成功。
   */
  const handleSave = async () => {
    if (!complete) {
      setSubmitAttempted(true);
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      if (tab === 'api') {
        const input: { api_user: string; api_pass: string; endpoint?: string } = {
          api_user: apiUser.trim(),
          api_pass: apiPass.trim(),
        };
        // 自定义平台：填了地址才带上；空串在后端是「保留旧值」，会把自定义地址静默吃掉。
        if (!endpointLocked && endpoint.trim() !== '') input.endpoint = endpoint.trim();
        const result = await smsApi.saveApiCredential(input, passphrase);
        if (!applySaveResults([result])) return;
      } else {
        const result = await smsApi.saveWebCredential(
          { username: webUser.trim(), password: webPass.trim() },
          passphrase
        );
        if (!applySaveResults([result])) return;
      }
      setSubmitAttempted(false);
      setSaved(true);
      // 成功后不关窗：让使用者自己确认结果再关（父组件据此刷新已存状态）。
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  /** 真实测试连接：调基座状态路由，按其三态判定。 */
  const handleTest = async () => {
    setTest({ kind: 'testing' });
    try {
      const status = await smsApi.getStatus();
      if (typeof status.balance_cny === 'number') {
        setTest({ kind: 'ok', balance: status.balance_cny });
      } else if (status.status === 'unavailable') {
        // 凭据未就绪（锁着/没存）——不能当成「连接失败」。
        setTest({
          kind: 'unavailable',
          message: status.error ?? t('sms_service.config_test_need_creds'),
        });
      } else {
        setTest({
          kind: 'fail',
          message: status.balance_error ?? t('sms_service.config_test_fail'),
        });
      }
    } catch (error) {
      setTest({
        kind: 'fail',
        message: (error as { message?: string })?.message ?? t('sms_service.config_test_fail'),
      });
    }
  };

  /**
   * 获取网页会话：后端取验证码 → 解点选顺序 → 提交登录 → 存会话。
   * 登录失败不落库；账号/密码留空则复用已存值。
   */
  const handleWebLogin = async () => {
    setWebLogin({ kind: 'busy' });
    setSaveError(null);
    setSaved(false);
    try {
      const result = await smsApi.webLogin(
        { username: webUser.trim(), password: webPass.trim() },
        passphrase
      );
      if (result.ok) {
        setWebLogin({ kind: 'ok', channels: result.channels });
      } else {
        setWebLogin({ kind: 'fail', message: result.message });
      }
    } finally {
      // 无论成败都刷新一次，父组件能反映最新凭据状态。
      onSaved();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title={t('sms_service.config_modal_title')}
      footer={
        <div className={styles.footer}>
          <div className={styles.footerStatus} role="status" aria-live="polite">
            {saveNotice?.tone === 'ok' && (
              <span className={styles.noticeOk}>
                <IconCheckCircle2 size={14} />
                {saveNotice.text}
              </span>
            )}
            {saveNotice?.tone === 'warn' && (
              <span className={styles.noticeWarn}>
                <IconAlertTriangle size={14} />
                {saveNotice.text}
              </span>
            )}
          </div>
          <div className={styles.footerActions}>
            <Button variant="secondary" size="sm" onClick={onClose}>
              {saved ? t('common.close') : t('sms_service.config_cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={saving || gatePhase === 'locked'}
            >
              {saving ? t('sms_service.config_saving') : t('sms_service.config_save')}
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.body}>
        {/* ① 选择平台 */}
        <section className={styles.section}>
          <div className={styles.sectionLabel}>{t('sms_service.config_step_platform')}</div>
          <div className={styles.platformList}>
            {SMS_PLATFORMS.map((item) => {
              const active = item.id === platformId;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`${styles.platformCard} ${active ? styles.platformCardActive : ''}`}
                  onClick={() => handlePlatformChange(item)}
                  aria-pressed={active}
                >
                  <span className={styles.platformRadio} aria-hidden="true" />
                  <span className={styles.platformText}>
                    <span className={styles.platformName}>
                      {t(item.nameKey)}
                      {item.preset && (
                        <span className={styles.platformTag}>{t('sms_service.config_preset')}</span>
                      )}
                    </span>
                    <span className={styles.platformSummary}>{t(item.summaryKey)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* ② 登录方式（Tab） + 连接信息 */}
        <section className={styles.section}>
          <div className={styles.sectionLabel}>{t('sms_service.config_step_credentials')}</div>

          <div
            className={styles.tabs}
            role="tablist"
            aria-label={t('sms_service.config_tabs_label')}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'api'}
              className={`${styles.tab} ${tab === 'api' ? styles.tabActive : ''}`}
              onClick={() => switchTab('api')}
            >
              {t('sms_service.config_tab_api')}
              {existing?.accountPresent && <span className={styles.tabDot} aria-hidden="true" />}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'web'}
              className={`${styles.tab} ${tab === 'web' ? styles.tabActive : ''}`}
              onClick={() => switchTab('web')}
            >
              {t('sms_service.config_tab_web')}
              {(existing?.webPresent || existing?.cookiePresent) && (
                <span className={styles.tabDot} aria-hidden="true" />
              )}
            </button>
          </div>

          {tab === 'api' ? (
            <div className={styles.tabPanel} role="tabpanel">
              <p className={styles.tabHint}>{t('sms_service.config_api_lead')}</p>
              <div className={styles.credGrid}>
                <Input
                  label={t('sms_service.config_field_api_account')}
                  placeholder={existing?.apiUserHint || t('sms_service.config_ph_api_account')}
                  value={apiUser}
                  onChange={(event) => {
                    setApiUser(event.target.value);
                    resetFeedback();
                  }}
                  hint={existing?.accountPresent ? t('sms_service.config_keep_blank') : undefined}
                  error={
                    showFieldErrors && !accountFilled
                      ? t('sms_service.config_required')
                      : undefined
                  }
                />
                <Input
                  label={t('sms_service.config_field_api_secret')}
                  type="password"
                  placeholder="••••••••"
                  value={apiPass}
                  onChange={(event) => {
                    setApiPass(event.target.value);
                    resetFeedback();
                  }}
                  hint={existing?.accountPresent ? t('sms_service.config_keep_blank') : undefined}
                  error={
                    showFieldErrors && !passwordFilled
                      ? t('sms_service.config_required')
                      : undefined
                  }
                />
              </div>
              {/* 内置平台地址只读展示（真值，非提示）；自定义平台才可填。 */}
              {endpointLocked ? (
                <div className={styles.readonlyField}>
                  <span className={styles.readonlyLabel}>
                    {t('sms_service.config_field_endpoint')}
                  </span>
                  <span className={styles.readonlyValue}>{platform.defaultEndpoint}</span>
                  <span className={styles.readonlyHint}>
                    {t('sms_service.config_endpoint_builtin')}
                  </span>
                </div>
              ) : (
                <Input
                  label={t('sms_service.config_field_endpoint')}
                  placeholder="https://api.example.com"
                  value={endpoint}
                  onChange={(event) => {
                    setEndpoint(event.target.value);
                    resetFeedback();
                  }}
                  hint={t('sms_service.config_field_endpoint_opt')}
                />
              )}
            </div>
          ) : (
            <div className={styles.tabPanel} role="tabpanel">
              <p className={styles.tabHint}>{t('sms_service.config_web_lead')}</p>
              <div className={styles.credGrid}>
                <Input
                  label={t('sms_service.config_field_web_user')}
                  placeholder={existing?.webUserHint || t('sms_service.config_ph_web_user')}
                  value={webUser}
                  onChange={(event) => {
                    setWebUser(event.target.value);
                    resetFeedback();
                  }}
                  hint={existing?.webPresent ? t('sms_service.config_keep_blank') : undefined}
                  error={
                    showFieldErrors && !accountFilled
                      ? t('sms_service.config_required')
                      : undefined
                  }
                />
                <Input
                  label={t('sms_service.config_field_web_pass')}
                  type="password"
                  placeholder="••••••••"
                  value={webPass}
                  onChange={(event) => {
                    setWebPass(event.target.value);
                    resetFeedback();
                  }}
                  hint={existing?.webPresent ? t('sms_service.config_keep_blank') : undefined}
                  error={
                    showFieldErrors && !passwordFilled
                      ? t('sms_service.config_required')
                      : undefined
                  }
                />
              </div>
              <div className={styles.webLoginRow}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleWebLogin}
                  disabled={webLogin.kind === 'busy' || gatePhase === 'locked'}
                >
                  <IconRefreshCw size={14} />
                  {webLogin.kind === 'busy'
                    ? t('sms_service.config_web_login_busy')
                    : t('sms_service.config_web_login')}
                </Button>
                {webLogin.kind === 'ok' && (
                  <span className={`${styles.testResult} ${styles.testOk}`}>
                    <IconCheckCircle2 size={15} />
                    {t('sms_service.config_web_login_ok', { count: webLogin.channels })}
                  </span>
                )}
                {webLogin.kind === 'fail' && (
                  <span className={`${styles.testResult} ${styles.testFail}`}>
                    <IconAlertTriangle size={15} />
                    {webLogin.message}
                  </span>
                )}
                {webLogin.kind !== 'busy' && (
                  <span className={styles.testNote}>{t('sms_service.config_web_login_note')}</span>
                )}
              </div>
            </div>
          )}
        </section>

        {/* ③ 测试连接：验的是**已保存**的凭据，与当前填了什么无关，所以不属于任何 Tab。 */}
        <section className={styles.testRow}>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleTest}
            disabled={test.kind === 'testing' || gatePhase === 'locked'}
          >
            <IconRefreshCw size={14} />
            {t('sms_service.config_test')}
          </Button>
          {test.kind === 'ok' && (
            <span className={`${styles.testResult} ${styles.testOk}`}>
              <IconCheckCircle2 size={15} />
              {typeof test.balance === 'number'
                ? t('sms_service.config_test_ok_balance', { balance: test.balance.toFixed(2) })
                : t('sms_service.config_test_ok')}
            </span>
          )}
          {test.kind === 'fail' && (
            <span className={`${styles.testResult} ${styles.testFail}`}>
              <IconAlertTriangle size={15} />
              {test.message}
            </span>
          )}
          {test.kind === 'unavailable' && (
            <span className={`${styles.testResult} ${styles.testWarn}`}>
              <IconAlertTriangle size={15} />
              {test.message}
            </span>
          )}
          {test.kind !== 'testing' && (
            <span className={styles.testNote}>{t('sms_service.config_test_note')}</span>
          )}
        </section>
      </div>
    </Modal>
  );
}
