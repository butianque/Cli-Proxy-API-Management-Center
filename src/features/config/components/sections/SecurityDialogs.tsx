/**
 * 安全管理的两个弹窗：更换管理密钥、设置 / 更换主密码。
 *
 * 为什么不走配置表单：这两项都不是配置树里的普通字段 —— 管理密钥改的是运行中
 * 的登录口令，主密码改的是加密库，各自是一次独立的后端调用；主密码明文更不能
 * 落进配置文档。故用独立弹窗，改完即时生效，各自给结果反馈。
 *
 * 两处细节不能省：
 * - 管理密钥换成功后，当前会话还带着旧密钥，必须同步换成新值（否则下一个请求
 *   就 401 被登出）；
 * - 主密码换成功后，门的密码也要换成新值（否则后续写凭据还在送旧密码）。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { IconAlertTriangle } from '@/components/ui/icons';
import { configApi } from '@/services/api/config';
import { secretStoreApi } from '@/services/api/secretStore';
import { useAuthStore } from '@/stores/useAuthStore';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { useSecretGateStore } from '@/stores/useSecretGateStore';
import styles from './SectionSecurity.module.scss';

/**
 * 后端返回的状态码。只用来区分「主密码不对」（401）与其它失败——文案一律走
 * 本地化词条，不把后端错误串直接摆给使用者（UI 只讲状态与下一步）。
 */
function statusOf(error: unknown): number | undefined {
  return (error as { status?: number })?.status;
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p className={styles.error} role="alert">
      <IconAlertTriangle size={15} />
      <span>{text}</span>
    </p>
  );
}

/** 更换管理密钥（面板登录口令）。 */
export function ManagementKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNext('');
    setConfirm('');
    setError(null);
    setSubmitting(false);
  }, [open]);

  const submit = async () => {
    const value = next.trim();
    if (!value) {
      setError(t('config_management.visual.sections.security.key_required'));
      return;
    }
    if (value !== confirm.trim()) {
      setError(t('config_management.visual.sections.security.key_mismatch'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await configApi.changeManagementKey(value);
      // 当前会话仍持有旧密钥，同步换掉，否则下一个请求就 401 被登出。
      useAuthStore.getState().updateManagementKey(value);
      showNotification(
        t('config_management.visual.sections.security.key_changed'),
        'success'
      );
      onClose();
    } catch {
      setError(t('config_management.visual.sections.security.key_failed'));
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={480}
      title={t('config_management.visual.sections.security.key_dialog_title')}
      footer={
        <div className={styles.footer}>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            {t('config_management.visual.sections.security.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={submitting}>
            {t('config_management.visual.sections.security.change')}
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        <p className={styles.lead}>{t('config_management.visual.sections.security.key_lead')}</p>
        <Input
          label={t('config_management.visual.sections.security.key_new')}
          type="password"
          autoComplete="new-password"
          autoFocus
          value={next}
          onChange={(event) => setNext(event.target.value)}
        />
        <Input
          label={t('config_management.visual.sections.security.key_confirm')}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />
        {error ? <ErrorLine text={error} /> : null}
      </div>
    </Modal>
  );
}

/** 设置 / 更换主密码（加密凭据用）。 */
export function MasterPassphraseDialog({
  open,
  changing,
  onClose,
}: {
  open: boolean;
  /** true = 已安装主密码，需先填当前主密码；false = 首次安装。 */
  changing: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
    setSubmitting(false);
  }, [open]);

  const submit = async () => {
    const value = next.trim();
    if (changing && !current) {
      setError(t('config_management.visual.sections.security.pass_current_required'));
      return;
    }
    if (!value) {
      setError(t('config_management.visual.sections.security.pass_required'));
      return;
    }
    if (value !== confirm.trim()) {
      setError(t('config_management.visual.sections.security.pass_mismatch'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (changing) {
        await secretStoreApi.setPassphrase(current, value);
      } else {
        await secretStoreApi.initialize(value);
      }
      // 门采用新密码：本会话解着锁继续用，后续写凭据才会带对新值。
      useSecretGateStore.getState().adoptPassphrase(value);
      showNotification(
        changing
          ? t('config_management.visual.sections.security.pass_changed')
          : t('config_management.visual.sections.security.pass_set'),
        'success'
      );
      onClose();
    } catch (err) {
      setError(
        statusOf(err) === 401
          ? t('config_management.visual.sections.security.pass_wrong')
          : t('config_management.visual.sections.security.pass_failed')
      );
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={480}
      title={
        changing
          ? t('config_management.visual.sections.security.pass_dialog_change_title')
          : t('config_management.visual.sections.security.pass_dialog_set_title')
      }
      footer={
        <div className={styles.footer}>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            {t('config_management.visual.sections.security.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={submitting}>
            {changing
              ? t('config_management.visual.sections.security.change')
              : t('config_management.visual.sections.security.set')}
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        <p className={styles.lead}>
          {changing
            ? t('config_management.visual.sections.security.pass_lead_change')
            : t('config_management.visual.sections.security.pass_lead_set')}
        </p>
        {changing ? (
          <Input
            label={t('config_management.visual.sections.security.pass_current')}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        ) : null}
        <Input
          label={t('config_management.visual.sections.security.pass_new')}
          type="password"
          autoComplete="new-password"
          autoFocus={!changing}
          value={next}
          onChange={(event) => setNext(event.target.value)}
        />
        <Input
          label={t('config_management.visual.sections.security.pass_confirm')}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />
        {error ? <ErrorLine text={error} /> : null}
      </div>
    </Modal>
  );
}
