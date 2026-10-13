/**
 * 接码服务页 —— 账号供给的入口，承载两个并列类别：**手机号** 与 **邮箱**。
 *
 * 「接码」本身就是「取一个能收码的身份」：手机号取号收短信、邮箱取址收邮件，
 * 数据流同向、只是承接的服务不同。因此页面把两类并列呈现，而不是把邮箱塞进
 * 手机号的页面里借壳。
 *
 * 本文件只做**容器**与该负责的两件事：
 *  - 页头（标题 + 说明）；
 *  - 类别切换（手机号 | 邮箱），并渲染对应视图。
 *
 * 视图各自的职责放在：
 *  - `PhoneSupplyView`：手机号（现状整页内容，逻辑不变）；
 *  - `EmailSupplyView`：邮箱（现阶段诚实空态）。
 *
 * 说明（UI 原则）：页头不做任何开关 —— 后端没有「启停整个接码服务」这条控制，
 * 摆一个开关就是假的。类别切换是**页面导航**，两端都指向真实内容（手机号有内容、
 * 邮箱为空态），因此它是真控件，不是装饰。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmailSupplyView } from './EmailSupplyView';
import { PhoneSupplyView } from './PhoneSupplyView';
import styles from './SmsServicePage.module.scss';

/** 接码服务的两个类别。 */
type SupplyCategory = 'phone' | 'email';

export function SmsServicePage() {
  const { t } = useTranslation();
  const [category, setCategory] = useState<SupplyCategory>('phone');

  const categories: { id: SupplyCategory; label: string }[] = [
    { id: 'phone', label: t('sms_service.tab_phone') },
    { id: 'email', label: t('sms_service.tab_email') },
  ];

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.headerCopy}>
          <h1 className={styles.title}>{t('sms_service.title')}</h1>
          <p className={styles.pageSubtitle}>{t('sms_service.subtitle')}</p>
        </div>
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

      {category === 'phone' ? <PhoneSupplyView /> : <EmailSupplyView />}
    </div>
  );
}