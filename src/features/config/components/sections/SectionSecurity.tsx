/**
 * 08 安全管理：面板自身的三把钥匙 —— 管理密钥（登录面板用）、主密码
 * （加密渠道凭据用），以及「无人值守访问」（后端是否要人在场才能读到凭据）。
 *
 * 本分区**没有配置字段**，也不参与「保存配置」的脏值流程：这三项都不是配置树
 * 里的普通字段，各自一次独立后端调用、改完即时生效，故用弹窗/即时开关而非表单。
 *
 * 主密码只在这里讲「设置 / 更换」，不讲实现（不提密钥库、加密数据这类后端概念）；
 * 未启用时整行不出现，不摆不能用的控件。
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconAlertTriangle, IconBot, IconKey, IconShield } from '@/components/ui/icons';
import { secretStoreApi, type SecretStoreStatus } from '@/services/api/secretStore';
import { useSecretGateStore } from '@/stores/useSecretGateStore';
import { CONFIG_TAB_ICONS, SECTION_INDEX_LABELS } from '../../constants';
import type { ConfigSectionProps } from '../../types';
import { SectionCard } from '../SectionCard';
import { FieldStack } from '../fields/FieldPrimitives';
import { ManagementKeyDialog, MasterPassphraseDialog } from './SecurityDialogs';
import styles from './SectionSecurity.module.scss';

const Icon = CONFIG_TAB_ICONS.security;

/** 一行「图标 + 说明 + 动作按钮」。三条钥匙共用，只有文案与图标不同。 */
export function SecurityKeyRow({
  icon,
  title,
  description,
  note,
  actionLabel,
  disabled,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  /** 需要在说明下面单独强调的一行状态（可选）。 */
  note?: string;
  actionLabel: string;
  disabled?: boolean;
  onAction: () => void;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.rowIcon} aria-hidden="true">
        {icon}
      </span>
      <div className={styles.rowMain}>
        <div className={styles.rowTitle}>{title}</div>
        <p className={styles.rowDesc}>{description}</p>
        {note ? <p className={styles.rowNote}>{note}</p> : null}
      </div>
      <Button variant="secondary" size="sm" disabled={disabled} onClick={onAction}>
        {actionLabel}
      </Button>
    </div>
  );
}

export function SectionSecurity({ disabled, animateIn }: ConfigSectionProps) {
  const { t } = useTranslation();
  const [keyOpen, setKeyOpen] = useState(false);
  const [passOpen, setPassOpen] = useState(false);
  const storeEnabled = useSecretGateStore((state) => state.storeEnabled);
  const passphraseSet = useSecretGateStore((state) => state.passphraseSet);
  const phase = useSecretGateStore((state) => state.phase);
  const s = (key: string) => `config_management.visual.sections.security.${key}`;

  // 无人值守访问的状态与切换。
  //
  // 这一行说的是「后端能不能自己读到凭据」，所以它既不能由 `phase` 推断，也不能
  // 只看主密码是否已装：它是一次 GET 的结果。解锁/锁定会改变它（有人解锁时后端
  // 借得到密钥），因此 `phase` 变化时重取一次，而不是只在挂载时取。
  const [access, setAccess] = useState<SecretStoreStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const refreshAccess = useCallback(async () => {
    try {
      setAccess(await secretStoreApi.getStatus());
    } catch {
      // 取不到就当作「没开」：不给按钮编造一个状态。
      setAccess(null);
    }
  }, []);

  useEffect(() => {
    if (!storeEnabled) return;
    void refreshAccess();
  }, [storeEnabled, phase, refreshAccess]);

  const unattended = access?.system_access === 'machine';

  const toggleAccess = async () => {
    setBusy(true);
    setErrorKey(null);
    try {
      const next = unattended
        ? await secretStoreApi.disableUnattendedAccess()
        : await secretStoreApi.enableUnattendedAccess();
      setAccess(next);
    } catch (error) {
      // 409 = 本会话还没验证主密码。那是「先做一件事」，不是故障。
      setErrorKey(
        (error as { status?: number })?.status === 409 ? 'unattended_need_unlock' : 'unattended_failed'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      indexLabel={SECTION_INDEX_LABELS.security}
      icon={<Icon size={16} />}
      title={t(s('title'))}
      description={t(s('description'))}
      animateIn={animateIn}
    >
      <FieldStack>
        <SecurityKeyRow
          icon={<IconKey size={16} />}
          title={t(s('key_title'))}
          description={t(s('key_desc'))}
          actionLabel={t(s('change'))}
          disabled={disabled}
          onAction={() => setKeyOpen(true)}
        />

        {storeEnabled ? (
          <SecurityKeyRow
            icon={<IconShield size={16} />}
            title={t(s('pass_title'))}
            description={passphraseSet ? t(s('pass_desc')) : t(s('pass_desc_unset'))}
            actionLabel={passphraseSet ? t(s('change')) : t(s('set'))}
            disabled={disabled}
            onAction={() => setPassOpen(true)}
          />
        ) : null}

        {storeEnabled && passphraseSet ? (
          <SecurityKeyRow
            icon={<IconBot size={16} />}
            title={t(s('unattended_title'))}
            description={
              unattended ? t(s('unattended_desc_on')) : t(s('unattended_desc_off'))
            }
            note={access?.seal === 'plain' ? t(s('unattended_unsealed')) : undefined}
            actionLabel={
              unattended ? t(s('unattended_disable')) : t(s('unattended_enable'))
            }
            disabled={disabled || busy}
            onAction={() => void toggleAccess()}
          />
        ) : null}

        {errorKey ? (
          <p className={styles.error}>
            <IconAlertTriangle size={14} />
            <span>{t(s(errorKey))}</span>
          </p>
        ) : null}
      </FieldStack>

      <ManagementKeyDialog open={keyOpen} onClose={() => setKeyOpen(false)} />
      <MasterPassphraseDialog
        open={passOpen}
        changing={passphraseSet}
        onClose={() => setPassOpen(false)}
      />
    </SectionCard>
  );
}
