/**
 * 接码服务页 —— 两个视图：**号码池**（默认）与**渠道配置**（覆盖两类身份）。
 *
 * 号码池是统一台账（手机号 + 邮箱同一张 ledger，按 kind 过滤），进来就看到。
 * 右上角「⚙ 配置」切到配置页，左上角「← 返回」切回来；「收件箱」与「导入邮箱」
 * 各开一个弹窗 —— 看信、导号都是当前这一页上的动作，不该换页。
 *
 * 配置页按身份类别切换，两类各有自己的正文：
 * - 手机号 → `PhoneSupplyView`（凭据 + 平台渠道 + 账本 + 护栏）；
 * - 邮箱 → `SupplyChannelCard`（收信邮箱登记）。
 *
 * 渠道只登记「一条连接覆盖多个地址」的服务（自建域、转发服务）；买来的单个邮箱走
 * 「导入邮箱」，直接成为台账里的一个身份，不再是一条渠道 —— 否则渠道表会长成
 * 「一个号一行」。
 *
 * 台账里每个身份下面都有一条状态带：站点 + 结果 + 凭证名，用来回答「这个号注册在
 * 哪个平台」。它和凭据卡片的「站点」行查同一张映射表，否则同一个号在两个页面上会
 * 显示成两个站点。
 *
 * 类别切换属于**页面导航**，因此由本文件持有；两个视图各自只渲染正文。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronLeft, IconInbox, IconPlus, IconSettings } from '@/components/ui/icons';
import { ImportMailboxesModal } from './ImportMailboxesModal';
import { InboxModal } from './InboxModal';
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
  // 收件箱是一个弹窗：来信是「现在到了什么」，看完就关，不是第三个视图。
  const [inboxOpen, setInboxOpen] = useState(false);
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
              onClick={() => setInboxOpen(true)}
            >
              <IconInbox size={14} />
              {t('sms_service.inbox_button')}
            </button>
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

      <InboxModal open={inboxOpen} onClose={() => setInboxOpen(false)} />
    </div>
  );
}
