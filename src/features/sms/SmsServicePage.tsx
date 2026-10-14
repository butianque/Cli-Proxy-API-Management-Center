/**
 * 接码服务页 —— 两个视图：**号码池**（默认）与**渠道配置**（覆盖）。
 *
 * 号码池是统一台账（手机号 + 邮箱同一张 ledger，按 kind 过滤），进来就看到。
 * 右上角「⚙ 配置」切到渠道配置页（来源登记），左上角「← 返回」切回。
 *
 * 手机号的凭据弹窗（ChannelConfigModal）在配置页里打开，因为凭据属于配置。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronLeft, IconSettings } from '@/components/ui/icons';
import { ChannelConfigModal } from './ChannelConfigModal';
import { SupplyChannelCard } from './SupplyChannelCard';
import { SupplyPoolCard } from './SupplyPoolCard';
import type { SupplyKind } from './types';
import styles from './SmsServicePage.module.scss';

type PageView = 'pool' | 'config';

export function SmsServicePage() {
  const { t } = useTranslation();
  const [view, setView] = useState<PageView>('pool');
  const [category, setCategory] = useState<SupplyKind>('phone');
  const [modalOpen, setModalOpen] = useState(false);

  const categories: { id: SupplyKind; label: string }[] = [
    { id: 'phone', label: t('sms_service.tab_phone') },
    { id: 'email', label: t('sms_service.tab_email') },
  ];

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.headerCopy}>
          {view === 'config' ? (
            <button
              type="button"
              className={styles.ghostAction}
              onClick={() => setView('pool')}
            >
              <IconChevronLeft size={14} />
              {t('sms_service.config_back')}
            </button>
          ) : (
            <>
              <h1 className={styles.title}>{t('sms_service.title')}</h1>
              <p className={styles.pageSubtitle}>{t('sms_service.subtitle')}</p>
            </>
          )}
          {view === 'config' && (
            <h1 className={styles.title}>{t('sms_service.config_title')}</h1>
          )}
        </div>
        {view === 'pool' && (
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.ghostAction}
              onClick={() => setView('config')}
            >
              <IconSettings size={14} />
              {t('sms_service.config_button')}
            </button>
          </div>
        )}
      </header>

      <div className={styles.tabs} role="tablist" aria-label={t('sms_service.tabs_label')}>
        {categories.map((item) => {
          const active = item.id === category;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`${styles.tab} ${active ? styles.tabActive : ''}`}
              onClick={() => setCategory(item.id)}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {view === 'pool' ? (
        <SupplyPoolCard kind={category} />
      ) : (
        <>
          <SupplyChannelCard
            onEditCredential={
              category === 'phone' ? () => setModalOpen(true) : undefined
            }
          />
          {category === 'phone' && (
            <ChannelConfigModal
              open={modalOpen}
              existing={null}
              onClose={() => setModalOpen(false)}
              onSaved={() => setModalOpen(false)}
            />
          )}
        </>
      )}
    </div>
  );
}
