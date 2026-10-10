/**
 * 主密码验证弹窗（SecretGateModal）。
 *
 * 用户 2026-10-10 拍板：
 * - 登录 CPA 后弹出，要求验证主密码；
 * - **可不填 / 可填错 / 可关闭** → 一律进入锁定态（加密数据不可访问，非加密功能照常）；
 * - 验证通过 → `verify + unlock` 真实解锁密钥库。
 *
 * 弹窗只在 `phase === 'idle'`（刚登录、尚未询问）时出现；`locked` 态不再弹，
 * 改由常驻的「锁定提示条」（SecretLockedBanner）提供重新验证入口。
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { IconKey, IconShield } from '@/components/ui/icons';
import { smsApi } from '@/services/api/sms';
import { useAuthStore } from '@/stores/useAuthStore';
import { useSecretGateStore } from '@/stores/useSecretGateStore';
import styles from './SecretGateModal.module.scss';

export function SecretGateModal() {
  const { t } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const phase = useSecretGateStore((state) => state.phase);
  const passphraseSet = useSecretGateStore((state) => state.passphraseSet);
  const storeAvailable = useSecretGateStore((state) => state.storeAvailable);
  const refreshStoreState = useSecretGateStore((state) => state.refreshStoreState);
  const verifyAndUnlock = useSecretGateStore((state) => state.verifyAndUnlock);
  const skip = useSecretGateStore((state) => state.skip);

  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const probedRef = useRef(false);

  // Reset the once-per-login probe when authentication changes, so a new login
  // re-examines the store instead of being skipped by the previous attempt.
  useEffect(() => {
    probedRef.current = false;
  }, [isAuthenticated]);

  // The dialog is mounted for the whole app lifetime, so its local input and
  // error must be cleared when the gate leaves the asking states — otherwise a
  // stale "wrong password" (or typed value) leaks into the next session.
  useEffect(() => {
    if (phase !== 'idle' && phase !== 'verifying') {
      setValue('');
      setErrorKey(null);
    }
  }, [phase]);

  // 登录后拉一次密钥库状态：决定「要不要问」以及问的措辞。
  // 必须等 isAuthenticated：登录页在会话恢复期间可能短暂有 apiBase，但 apiClient
  // 尚未拿到管理密钥，此时探测会 401，进而把门误判为锁定。
  useEffect(() => {
    if (phase !== 'idle' || !isAuthenticated || !apiBase || probedRef.current) return;
    probedRef.current = true;
    let cancelled = false;
    smsApi
      .getSecretStatus()
      .then((status) => {
        if (cancelled) return;
        refreshStoreState(status);
        // 密钥库不可用，或压根没装主密码 → 无需验证，直接放行（无密可锁）。
        if (!status.enabled || !status.initialized || !status.passphrase) {
          useSecretGateStore.setState({ phase: 'unlocked', errorKey: null });
        }
      })
      .catch(() => {
        if (!cancelled) skip();
      });
    return () => {
      cancelled = true;
    };
  }, [phase, isAuthenticated, apiBase, refreshStoreState, skip]);

  // The gate is answerable only inside an authenticated session. The probe above
  // already waits for `isAuthenticated`; the render guard must too, or a stale
  // storeAvailable/passphraseSet from a previous session would stack the dialog
  // on top of the login page before anyone has signed in.
  //
  // `verifying` keeps the dialog up: the submit is an async round-trip, and
  // closing on click would blank the form mid-flight (and let a stray click hit
  // whatever is underneath). A failed attempt returns to `idle` with an error.
  const open =
    (phase === 'idle' || phase === 'verifying') &&
    isAuthenticated &&
    storeAvailable &&
    passphraseSet;

  const handleSubmit = async () => {
    if (!value.trim()) {
      // 空提交等同「跳过」——用户可继续用面板，但看不到加密数据。
      skip();
      return;
    }
    setSubmitting(true);
    setErrorKey(null);
    const result = await verifyAndUnlock(value, async (passphrase) => {
      // verify 只验口令、不解锁；真正让密钥库可读必须再 unlock。
      const verified = await smsApi.verifyPassphrase(passphrase);
      if (!verified) throw new Error('verify failed');
      await smsApi.unlockStore(passphrase);
    });
    setSubmitting(false);
    if (!result) {
      setErrorKey('sms_service.gate_wrong');
      setValue('');
    }
  };

  return (
    <Modal
      open={open}
      onClose={skip}
      width={460}
      title={t('sms_service.gate_title')}
      footer={
        <div className={styles.footer}>
          <Button variant="secondary" size="sm" onClick={skip}>
            {t('sms_service.gate_skip')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleSubmit} disabled={submitting}>
            {t('sms_service.gate_unlock')}
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        <div className={styles.lead}>
          <IconKey size={18} />
          <span>{t('sms_service.gate_lead')}</span>
        </div>
        <Input
          label={t('sms_service.gate_label')}
          type="password"
          autoFocus
          placeholder="••••••••"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void handleSubmit();
          }}
          error={errorKey ? t(errorKey) : undefined}
        />
        <p className={styles.hint}>
          <IconShield size={14} />
          <span>{t('sms_service.gate_hint')}</span>
        </p>
      </div>
    </Modal>
  );
}
