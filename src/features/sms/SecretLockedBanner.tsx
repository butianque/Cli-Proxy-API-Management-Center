/**
 * 锁定提示条（SecretLockedBanner）。
 *
 * 用户 2026-10-10 拍板：「登录后弹窗 + 常驻未验证提示」。
 * 当主密码未验证（`locked`）时，面板顶部常驻一条提示，点「验证主密码」重新弹框。
 * 已解锁时不渲染任何东西。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { IconShield } from '@/components/ui/icons';
import { smsApi } from '@/services/api/sms';
import { useSecretGateStore } from '@/stores/useSecretGateStore';
import styles from './SecretLockedBanner.module.scss';

export function SecretLockedBanner() {
  const { t } = useTranslation();
  const phase = useSecretGateStore((state) => state.phase);
  const passphraseSet = useSecretGateStore((state) => state.passphraseSet);
  const storeAvailable = useSecretGateStore((state) => state.storeAvailable);
  const verifyAndUnlock = useSecretGateStore((state) => state.verifyAndUnlock);

  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  // 只在「已锁定且确有必要验证」时显示。
  if (phase !== 'locked' || !storeAvailable || !passphraseSet) return null;

  const handleSubmit = async () => {
    if (!value.trim()) return;
    setSubmitting(true);
    setErrorKey(null);
    const ok = await verifyAndUnlock(value, async (passphrase) => {
      const verified = await smsApi.verifyPassphrase(passphrase);
      if (!verified) throw new Error('verify failed');
      await smsApi.unlockStore(passphrase);
    });
    setSubmitting(false);
    if (!ok) {
      setErrorKey('sms_service.gate_wrong');
      setValue('');
      return;
    }
    setValue('');
    setOpen(false);
  };

  return (
    <>
      <div className={styles.banner} role="status">
        <IconShield size={15} />
        <span className={styles.text}>{t('sms_service.gate_locked_banner')}</span>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          <IconShield size={14} />
          {t('sms_service.gate_reverify')}
        </Button>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        width={420}
        title={t('sms_service.gate_title')}
        footer={
          <div className={styles.footer}>
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
              {t('sms_service.gate_skip')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSubmit}
              disabled={submitting || !value.trim()}
            >
              {t('sms_service.gate_unlock')}
            </Button>
          </div>
        }
      >
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
      </Modal>
    </>
  );
}
