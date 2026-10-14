/**
 * 邮箱接码视图（「接码服务」页的「邮箱」类别）。
 *
 * 现阶段只承载**诚实空态**：邮箱供给能力尚未接入，页面不编造任何域名、地址或
 * 收件箱数据，也不摆不能用的控件。文案只讲「现在是什么状态、下一步是什么」，
 * 不讲实现细节（见 AGENTS.md「UI 设计原则」）。
 *
 * 后续接入后，本视图将依次呈现：源清单 → 域名池 + 地址池 → 收件箱 → 提取规则 + webhook。
 */

import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconInbox } from '@/components/ui/icons';
import styles from './SmsServicePage.module.scss';

export function EmailSupplyView() {
  const { t } = useTranslation();

  return (
    <div className={styles.page}>
      <Card
        title={
          <span className={styles.cardTitle}>
            <IconInbox size={17} />
            {t('sms_service.email_title')}
          </span>
        }
      >
        <EmptyState
          title={t('sms_service.email_empty')}
          description={t('sms_service.email_empty_desc')}
        />
      </Card>
    </div>
  );
}
