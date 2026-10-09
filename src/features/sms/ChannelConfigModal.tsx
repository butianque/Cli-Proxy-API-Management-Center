/**
 * 渠道配置弹窗（L1 选平台 → L3 选模式 + 填连接信息）。
 *
 * 交互契约（用户 2026-10-10 拍板）：
 * - ① 选择平台：预置平台（豪猪）直接可选，另给「自定义」兜底；
 * - ② 选完平台「下方内容改变」——只有选中平台的字段才显示；
 * - ③ 连接模式：账号登录模式（账号 + 密码）/ API 连接模式（API 地址 + 账号 + 密码）；
 * - ④ 测试连接（本轮 mock）/ 保存。
 *
 * ⚠️ 本轮为**前端预览**：`onSubmit` 由父组件决定是否落盘；当前只回传表单值。
 * 不做任何网络请求，「测试连接」返回模拟结果。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { IconCheckCircle2, IconAlertTriangle, IconRefreshCw } from '@/components/ui/icons';
import { SMS_PLATFORMS } from './mockData';
import type { ConfiguredPlatform, ConnectionMode, SmsPlatform } from './types';
import styles from './ChannelConfigModal.module.scss';

export interface ChannelConfigModalProps {
  open: boolean;
  onClose: () => void;
  /** 当前已配置渠道，用于回填编辑（同一平台只允许一条，本轮简化）。 */
  initial?: ConfiguredPlatform | null;
  /** 保存回调：本轮由父组件决定是否持久化（mock 下仅更新本地 state）。 */
  onSubmit: (value: ConfiguredPlatform) => void;
}

type TestState = 'idle' | 'testing' | 'ok' | 'fail';

export function ChannelConfigModal({ open, onClose, initial, onSubmit }: ChannelConfigModalProps) {
  const { t } = useTranslation();

  const [platformId, setPlatformId] = useState<string>(SMS_PLATFORMS[0].id);
  const [mode, setMode] = useState<ConnectionMode>('account');
  const [endpoint, setEndpoint] = useState('');
  const [account, setAccount] = useState('');
  const [secret, setSecret] = useState('');
  const [test, setTest] = useState<TestState>('idle');
  // 提交尝试过才显示必填错误，避免一打开就满屏红字（pristine 表单不该报错）。
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const testTimerRef = useRef<number | null>(null);

  const platform = useMemo(
    () => SMS_PLATFORMS.find((item) => item.id === platformId) ?? SMS_PLATFORMS[0],
    [platformId]
  );

  // 任何字段变化都让上一次「测试连接」结果失效（避免改了账号仍显示已连接）。
  const resetTest = () => setTest('idle');

  // 打开时把 initial 回填进表单；无 initial 则用平台默认。
  useEffect(() => {
    if (!open) return;
    setSubmitAttempted(false);
    if (initial) {
      setPlatformId(initial.platformId);
      setMode(initial.mode);
      setEndpoint(initial.endpoint);
      setAccount(initial.account);
      setSecret('');
      setTest(initial.connected ? 'ok' : 'idle');
      return;
    }
    const first = SMS_PLATFORMS[0];
    const firstMode = first.modes[0];
    setPlatformId(first.id);
    setMode(firstMode);
    setEndpoint(firstMode === 'api' ? (first.defaultEndpoint ?? '') : '');
    setAccount('');
    setSecret('');
    setTest('idle');
  }, [open, initial]);

  // 卸载/关闭时清掉测试连接定时器，避免悬空 setState。
  useEffect(() => {
    return () => {
      if (testTimerRef.current !== null) window.clearTimeout(testTimerRef.current);
    };
  }, []);

  // 平台切换：模式收敛到该平台支持的第一种，字段随之重置（「选择后下方内容改变」）。
  const handlePlatformChange = (next: SmsPlatform) => {
    setPlatformId(next.id);
    const nextMode = next.modes[0];
    setMode(nextMode);
    setEndpoint(nextMode === 'api' ? (next.defaultEndpoint ?? '') : '');
    setAccount('');
    setSecret('');
    setSubmitAttempted(false);
    resetTest();
  };

  // 模式切换：清掉不适用的字段，避免把 A 模式的值带到 B 模式。
  const handleModeChange = (next: ConnectionMode) => {
    setMode(next);
    setEndpoint(next === 'api' ? (platform.defaultEndpoint ?? '') : '');
    setAccount('');
    setSecret('');
    setSubmitAttempted(false);
    resetTest();
  };

  const needsEndpoint = mode === 'api';
  const endpointMissing = needsEndpoint && endpoint.trim() === '';
  const accountMissing = account.trim() === '';
  const secretMissing = secret.trim() === '';
  const canSubmit = !endpointMissing && !accountMissing && !secretMissing;
  // 只在「提交尝试过」后展示必填错误。
  const showErrors = submitAttempted;

  const handleTest = () => {
    if (!canSubmit) return;
    setTest('testing');
    // 本轮 mock：延迟后固定返回成功；不做任何网络请求。
    if (testTimerRef.current !== null) window.clearTimeout(testTimerRef.current);
    testTimerRef.current = window.setTimeout(() => {
      setTest('ok');
      testTimerRef.current = null;
    }, 600);
  };

  const handleSubmit = () => {
    if (!canSubmit) {
      setSubmitAttempted(true);
      return;
    }
    onSubmit({
      platformId: platform.id,
      platformName: platform.name,
      mode,
      endpoint: needsEndpoint ? endpoint.trim() : (platform.defaultEndpoint ?? ''),
      account: account.trim(),
      enabled: initial?.enabled ?? true,
      connected: test === 'ok',
    });
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
          <Button variant="primary" size="sm" onClick={handleSubmit}>
            {t('sms_service.config_save')}
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

        {/* ② 连接模式（随平台变化） */}
        <section className={styles.section}>
          <div className={styles.sectionLabel}>{t('sms_service.config_step_mode')}</div>
          <div className={styles.modeRow} role="radiogroup">
            {(['account', 'api'] as ConnectionMode[]).map((value) => {
              const supported = platform.modes.includes(value);
              const active = mode === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`${styles.modeCard} ${active ? styles.modeCardActive : ''}`}
                  onClick={() => supported && handleModeChange(value)}
                  disabled={!supported}
                >
                  <span className={styles.modeTitle}>
                    {value === 'account'
                      ? t('sms_service.config_mode_account')
                      : t('sms_service.config_mode_api')}
                  </span>
                  <span className={styles.modeHint}>
                    {value === 'account'
                      ? t('sms_service.config_mode_account_hint')
                      : t('sms_service.config_mode_api_hint')}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* ③ 连接信息（随模式变化） */}
        <section className={styles.section}>
          <div className={styles.sectionLabel}>{t('sms_service.config_step_credentials')}</div>
          {needsEndpoint && (
            <Input
              label={t('sms_service.config_field_endpoint')}
              placeholder="https://api.example.com"
              value={endpoint}
              onChange={(event) => {
                setEndpoint(event.target.value);
                resetTest();
              }}
              hint={t('sms_service.config_field_endpoint_hint')}
              error={showErrors && endpointMissing ? t('sms_service.config_required') : undefined}
            />
          )}
          <Input
            label={
              needsEndpoint
                ? t('sms_service.config_field_api_account')
                : t('sms_service.config_field_account')
            }
            placeholder={needsEndpoint ? 'api_user' : t('sms_service.config_field_account_ph')}
            value={account}
            onChange={(event) => {
              setAccount(event.target.value);
              resetTest();
            }}
            error={showErrors && accountMissing ? t('sms_service.config_required') : undefined}
          />
          <Input
            label={
              needsEndpoint
                ? t('sms_service.config_field_api_secret')
                : t('sms_service.config_field_secret')
            }
            type="password"
            placeholder="••••••••"
            value={secret}
            onChange={(event) => {
              setSecret(event.target.value);
              resetTest();
            }}
            hint={needsEndpoint ? undefined : t('sms_service.config_field_secret_hint')}
            error={showErrors && secretMissing ? t('sms_service.config_required') : undefined}
          />
        </section>

        {/* ④ 测试连接（本轮 mock） */}
        <section className={styles.testRow}>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleTest}
            disabled={!canSubmit || test === 'testing'}
          >
            <IconRefreshCw size={14} />
            {t('sms_service.config_test')}
          </Button>
          {test === 'ok' && (
            <span className={`${styles.testResult} ${styles.testOk}`}>
              <IconCheckCircle2 size={15} />
              {t('sms_service.config_test_ok')}
            </span>
          )}
          {test === 'fail' && (
            <span className={`${styles.testResult} ${styles.testFail}`}>
              <IconAlertTriangle size={15} />
              {t('sms_service.config_test_fail')}
            </span>
          )}
          <span className={styles.testHint}>{t('sms_service.config_test_hint')}</span>
        </section>
      </div>
    </Modal>
  );
}
