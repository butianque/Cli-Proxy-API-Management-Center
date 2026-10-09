/**
 * 渠道配置弹窗（L1 选平台 → L3 两张凭据表 → 真实保存 / 真实测试连接）。
 *
 * 交互契约（用户 2026-10-10 拍板）：
 * - ① 选择平台：预置平台（豪猪）直接可选，另给「自定义」兜底；
 * - ② 凭据：**两张表并存**（不是二选一）——
 *     · **账密表**：账号 + 密码（+ 可选 API 地址）→ 取号；
 *     · **CK 表**：Cookie（网页会话）→ 管渠道；
 * - ③ 测试连接：真实调 `/sms/status`，按三态判定（成功 / 失败 / 凭据未就绪）；
 * - ④ 保存：真实写入宿主加密库（`/sms/api`、`/sms/cookie`）。
 *
 * ⚠️ 安全：主密码（`passphrase`）只从 SecretGate 的门取（内存中，登录时验证过的），
 * 本组件不自行收集密码；锁定态下保存会被后端 401 拒绝，此处如实提示。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { IconAlertTriangle, IconCheckCircle2, IconRefreshCw } from '@/components/ui/icons';
import { smsApi, type CredentialWriteResult } from '@/services/api/sms';
import { useAuthStore } from '@/stores/useAuthStore';
import { useSecretGateStore } from '@/stores/useSecretGateStore';
import { SMS_PLATFORMS } from './mockData';
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
    accountHint: string;
  } | null;
  /** 保存成功后回调（父组件据此刷新状态）。 */
  onSaved: () => void;
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; balance?: number }
  | { kind: 'fail'; message: string }
  | { kind: 'unavailable'; message: string };

/** 自动获取 CK 的状态。 */
type WebLoginState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; channels: number }
  | { kind: 'fail'; message: string };

/** Cookie 长度粗略校验：豪猪 PHPSESSID 形如 32 位 hex，这里只做「看着像」的软校验。 */
const looksLikeCookie = (value: string) => value.trim().length >= 16;

export function ChannelConfigModal({ open, onClose, existing, onSaved }: ChannelConfigModalProps) {
  const { t } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const passphrase = useSecretGateStore((state) => state.passphrase);
  const gatePhase = useSecretGateStore((state) => state.phase);

  const [platformId, setPlatformId] = useState<string>(SMS_PLATFORMS[0].id);
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [cookie, setCookie] = useState('');
  const [clearCookie, setClearCookie] = useState(false);
  const [webUser, setWebUser] = useState('');
  const [webPass, setWebPass] = useState('');
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [webLogin, setWebLogin] = useState<WebLoginState>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const testTimerRef = useRef<number | null>(null);

  const platform = useMemo(
    () => SMS_PLATFORMS.find((item) => item.id === platformId) ?? SMS_PLATFORMS[0],
    [platformId]
  );

  const accountDirty = account.trim() !== '' || password.trim() !== '' || endpoint.trim() !== '';
  const cookieDirty = clearCookie || cookie.trim() !== '';

  // 打开时重置表单为「只显示已存状态」。
  useEffect(() => {
    if (!open) return;
    setPlatformId(SMS_PLATFORMS[0].id);
    setAccount('');
    setPassword('');
    setEndpoint('');
    setCookie('');
    setClearCookie(false);
    setWebUser('');
    setWebPass('');
    setTest({ kind: 'idle' });
    setWebLogin({ kind: 'idle' });
    setSubmitAttempted(false);
    setSaveError(null);
  }, [open]);

  useEffect(
    () => () => {
      if (testTimerRef.current !== null) window.clearTimeout(testTimerRef.current);
    },
    []
  );

  const resetTest = () => {
    setTest({ kind: 'idle' });
    setWebLogin({ kind: 'idle' });
    setSaveError(null);
  };

  const handlePlatformChange = (next: SmsPlatform) => {
    setPlatformId(next.id);
    setEndpoint('');
    resetTest();
  };

  // 校验：至少有一种改动；账密表改了就必须账号+密码齐。
  const accountPairIncomplete = accountDirty && (account.trim() === '' || password.trim() === '');
  const cookieInvalid = cookieDirty && !clearCookie && !looksLikeCookie(cookie);
  const nothingToSave = !accountDirty && !cookieDirty;
  const canSubmit = !accountPairIncomplete && !cookieInvalid && !nothingToSave;
  const showErrors = submitAttempted;

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

  const handleSave = async () => {
    if (!canSubmit) {
      setSubmitAttempted(true);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const results: CredentialWriteResult[] = [];
      if (accountDirty) {
        results.push(
          await smsApi.saveApiCredential(
            apiBase,
            {
              api_user: account.trim(),
              api_pass: password.trim(),
              endpoint: endpoint.trim(),
            },
            passphrase
          )
        );
      }
      if (cookieDirty) {
        results.push(
          await smsApi.saveCookie(apiBase, clearCookie ? '' : cookie.trim(), passphrase)
        );
      }
      if (!applySaveResults(results)) return;
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  /** 真实测试连接：调 /sms/status，按其三态判定。 */
  const handleTest = async () => {
    setTest({ kind: 'testing' });
    try {
      const status = await smsApi.getStatus(apiBase);
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
   * 自动获取 CK：后端取验证码 → 解点选顺序 → 提交登录 → 存 CK。
   * 登录失败不落库；账号/密码留空则复用已存值。
   */
  const handleWebLogin = async () => {
    setWebLogin({ kind: 'busy' });
    setSaveError(null);
    try {
      const result = await smsApi.webLogin(
        apiBase,
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
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('sms_service.config_cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
            {saving ? t('sms_service.config_saving') : t('sms_service.config_save')}
          </Button>
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
                      {item.name}
                      {item.preset && (
                        <span className={styles.platformTag}>{t('sms_service.config_preset')}</span>
                      )}
                    </span>
                    <span className={styles.platformSummary}>{item.summary}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* ② 凭据：两张表并存 */}
        <section className={styles.section}>
          <div className={styles.sectionLabel}>{t('sms_service.config_step_credentials')}</div>

          {/* 账密表 */}
          <div className={styles.credCard}>
            <div className={styles.credHead}>
              <span className={styles.credTitle}>{t('sms_service.config_account_title')}</span>
              <span className={styles.credRole}>{t('sms_service.config_account_role')}</span>
              {existing?.accountPresent && (
                <span className={styles.credBadge}>{t('sms_service.config_stored')}</span>
              )}
            </div>
            <div className={styles.credGrid}>
              <Input
                label={t('sms_service.config_field_account')}
                placeholder={existing?.accountHint || 'api_user'}
                value={account}
                onChange={(event) => {
                  setAccount(event.target.value);
                  resetTest();
                }}
                error={
                  showErrors && accountDirty && account.trim() === ''
                    ? t('sms_service.config_required')
                    : undefined
                }
              />
              <Input
                label={t('sms_service.config_field_secret')}
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  resetTest();
                }}
                hint={existing?.accountPresent ? t('sms_service.config_keep_blank') : undefined}
                error={
                  showErrors && accountDirty && password.trim() === ''
                    ? t('sms_service.config_required')
                    : undefined
                }
              />
            </div>
            <Input
              label={t('sms_service.config_field_endpoint')}
              placeholder={platform.defaultEndpoint ?? 'https://api.example.com'}
              value={endpoint}
              onChange={(event) => {
                setEndpoint(event.target.value);
                resetTest();
              }}
              hint={t('sms_service.config_field_endpoint_opt')}
            />
          </div>

          {/* CK 表 */}
          <div className={styles.credCard}>
            <div className={styles.credHead}>
              <span className={styles.credTitle}>{t('sms_service.config_cookie_title')}</span>
              <span className={styles.credRole}>{t('sms_service.config_cookie_role')}</span>
              {existing?.cookiePresent && !clearCookie && (
                <span className={styles.credBadge}>{t('sms_service.config_stored')}</span>
              )}
            </div>
            <div className={styles.credGrid}>
              <Input
                label={t('sms_service.config_field_web_user')}
                placeholder="linhua888"
                value={webUser}
                onChange={(event) => {
                  setWebUser(event.target.value);
                  resetTest();
                }}
                hint={t('sms_service.config_field_web_hint')}
              />
              <Input
                label={t('sms_service.config_field_web_pass')}
                type="password"
                placeholder="••••••••"
                value={webPass}
                onChange={(event) => {
                  setWebPass(event.target.value);
                  resetTest();
                }}
                hint={existing?.webPresent ? t('sms_service.config_keep_blank') : undefined}
              />
            </div>
            <Input
              label={t('sms_service.config_field_cookie')}
              placeholder="PHPSESSID=..."
              value={cookie}
              disabled={clearCookie}
              onChange={(event) => {
                setCookie(event.target.value);
                resetTest();
              }}
              onFocus={() => setClearCookie(false)}
              hint={t('sms_service.config_field_cookie_hint')}
              error={
                showErrors && cookieInvalid ? t('sms_service.config_cookie_invalid') : undefined
              }
            />
            {existing?.cookiePresent && (
              <label className={styles.clearRow}>
                <input
                  type="checkbox"
                  checked={clearCookie}
                  onChange={(event) => {
                    setClearCookie(event.target.checked);
                    setCookie('');
                    resetTest();
                  }}
                />
                {t('sms_service.config_clear_cookie')}
              </label>
            )}
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
        </section>

        {/* ③ 测试连接 + 错误 */}
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

        {gatePhase === 'locked' && (
          <p className={styles.gateWarn}>
            <IconAlertTriangle size={14} />
            {t('sms_service.config_gate_locked_hint')}
          </p>
        )}
        {saveError && (
          <p className={styles.gateWarn}>
            <IconAlertTriangle size={14} />
            {saveError}
          </p>
        )}
      </div>
    </Modal>
  );
}
