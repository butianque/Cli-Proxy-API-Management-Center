/**
 * 08 安全管理：面板自身的两把钥匙 —— 管理密钥（登录面板用）与主密码
 * （加密渠道凭据用）。
 *
 * 本分区**没有配置字段**，也不参与「保存配置」的脏值流程：这两项都不是配置树
 * 里的普通字段，各自一次独立后端调用、改完即时生效，故用弹窗而非表单。
 *
 * 主密码只在这里讲「设置 / 更换」，不讲实现（不提密钥库、加密数据这类后端概念）；
 * 未启用时整行不出现，不摆不能用的控件。
 */

import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconKey, IconShield } from '@/components/ui/icons';
import { useSecretGateStore } from '@/stores/useSecretGateStore';
import { CONFIG_TAB_ICONS, SECTION_INDEX_LABELS } from '../../constants';
import type { ConfigSectionProps } from '../../types';
import { SectionCard } from '../SectionCard';
import { FieldStack } from '../fields/FieldPrimitives';
import { ManagementKeyDialog, MasterPassphraseDialog } from './SecurityDialogs';
import styles from './SectionSecurity.module.scss';

const Icon = CONFIG_TAB_ICONS.security;

/** 一行「图标 + 说明 + 动作按钮」。两条钥匙共用，只有文案与图标不同。 */
export function SecurityKeyRow({
  icon,
  title,
  description,
  actionLabel,
  disabled,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  description: string;
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
  const s = (key: string) => `config_management.visual.sections.security.${key}`;

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
