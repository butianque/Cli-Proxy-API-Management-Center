/**
 * 接码服务页 —— 两个视图：**号码池**（默认）与**渠道配置**（覆盖两类身份）。
 *
 * 号码池是统一台账（手机号 + 邮箱同一张 ledger，按 kind 过滤），进来就看到。
 * 右上角「⚙ 配置」切到配置页，左上角「← 返回」切回来。
 *
 * 配置页按身份类别切换，两类各有自己的正文：
 * - 手机号 → `PhoneSupplyView`（凭据 + 平台渠道 + 账本 + 护栏）；
 * - 邮箱 → `SupplyChannelCard`（收信邮箱登记）。
 *
 * 邮箱收到什么**不另开一张卡**：每条渠道的收件情况挂在它自己那一行下面（渠道池表的
 * 状态带）。把多个邮箱合成一个「收件箱」之后，「有 3 封」到底是哪个邮箱的只能靠猜；
 * 而且自动化要的是接口，人要的是「这一条现在要不要管」。
 *
 * 类别切换属于**页面导航**，因此由本文件持有；两个视图各自只渲染正文。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronLeft, IconPlus, IconSettings } from '@/components/ui/icons';
import { ImportMailboxesModal } from './ImportMailboxesModal';
import { PhoneSupplyView } from './PhoneSupplyView';
import { SupplyChannelCard } from './SupplyChannelCard';
import { SupplyPoolCard } from './SupplyPoolCard';
import type { SupplyKind } from './types';
import styles from './SmsServicePage.module.scss';

type PageView = 'pool' | 'config';

export function SmsServicePage() {
  const { t } = useTranslation();
  const [view, setView] = useState<PageView>('pool');
  const [category, setCategory] = useState<SupplyKind>('phone');
  const [importOpen, setImportOpen] = useState(false);
  // 导入写的是台账，而台账只在挂载时读一次：靠这个计数器叫它重读。
  const [poolReloadKey, setPoolReloadKey] = useState(0);

  const categories: { id: SupplyKind; label: string }[] = [
    { id: 'phone', label: t('sms_service.tab_phone') },
    { id: 'email', label: t('sms_service.tab_email') },
  ];

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.headerCopy}>
          {view === 'pool' ? (
            <>
              <h1 className={styles.title}>{t('sms_service.title')}</h1>
              <p className={styles.pageSubtitle}>{t('sms_service.subtitle')}</p>
            </>
          ) : (
            <button type="button" className={styles.ghostAction} onClick={() => setView('pool')}>
              <IconChevronLeft size={14} />
              {t('sms_service.config_back')}
            </button>
          )}
          {view === 'config' && <h1 className={styles.title}>{t('sms_service.config_title')}</h1>}
        </div>
        {view === 'pool' && (
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.ghostAction}
              onClick={() => setImportOpen(true)}
            >
              <IconPlus size={14} />
              {t('sms_service.import_mailboxes')}
            </button>
            <button type="button" className={styles.ghostAction} onClick={() => setView('config')}>
              <IconSettings size={14} />
              {t('sms_service.config_button')}
            </button>
          </div>
        )}
      </header>

      <div key={view} className={styles.viewContent}>
        {view === 'pool' && <SupplyPoolCard reloadKey={poolReloadKey} />}
        {view === 'config' && (
          <>
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
            <div key={category} className={styles.panelTransition}>
              {category === 'phone' ? <PhoneSupplyView /> : <SupplyChannelCard />}
            </div>
          </>
        )}
      </div>

      {/* 导入完成就停在台账：导进来的号就在这一页上，跳到配置页等于让人自己再找回来。 */}
      <ImportMailboxesModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          setView('pool');
          setPoolReloadKey((value) => value + 1);
        }}
      />
    </div>
  );
}
