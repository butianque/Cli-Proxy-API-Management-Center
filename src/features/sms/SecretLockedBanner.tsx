/**
 * 锁定提示条（SecretLockedBanner）。
 *
 * 用户 2026-10-10 拍板：「登录后弹窗 + 常驻未验证提示」。
 * 当主密码未验证（`locked`）时，面板顶部常驻一条提示，点「验证主密码」重新弹框。
 * 已解锁时不渲染任何东西。
 *
 * 文案只讲「当前状态 + 下一步动作」，不讲实现（不提加密库/密钥库/加密数据这类
 * 后端概念，也不解释「什么功能还能用」）——见 AGENTS.md「UI 设计原则」。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Notice } from '@/components/ui/Notice';
import { IconShield } from '@/components/ui/icons';
import { secretStoreApi } from '@/services/api/secretStore';
import { useAuthStore } from '@/stores/useAuthStore';
import { useSecretGateStore } from '@/stores/useSecretGateStore';
import styles from './SecretLockedBanner.module.scss';

export function SecretLockedBanner() {
  const { t } = useTranslation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const phase = useSecretGateStore((state) => state.phase);
  const passphraseSet = useSecretGateStore((state) => state.passphraseSet);
  const storeAvailable = useSecretGateStore((state) => state.storeAvailable);
  const verifyAndUnlock = useSecretGateStore((state) => state.verifyAndUnlock);

  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  // 只在「已登录、已锁定、且确有必要验证」时显示。
  if (!isAuthenticated || phase !== 'locked' || !storeAvailable || !passphraseSet) return null;

  const handleSubmit = async () => {
    if (!value.trim()) return;
    setSubmitting(true);
    setErrorKey(null);
    const ok = await verifyAndUnlock(value, async (passphrase) => {
      const verified = await secretStoreApi.verifyPassphrase(passphrase);
      if (!verified) throw new Error('verify failed');
      await secretStoreApi.unlock(passphrase);
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
      <Notice
        tone="warning"
        className={styles.banner}
        role="status"
        icon={<IconShield size={15} />}
        action={
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            <IconShield size={14} />
            {t('sms_service.gate_reverify')}
          </Button>
        }
      >
        {t('sms_service.gate_locked_banner')}
      </Notice>

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
