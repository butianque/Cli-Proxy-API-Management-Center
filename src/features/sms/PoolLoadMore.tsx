/**
 * 池子表格底部那条：已经显示了多少条，还有多少没显示。
 *
 * 它替代了页码栏。表格是**滚到底自动追加**的，所以这里没有「下一页」——只有一句
 * 现状，加一个按钮。按钮不是多余的：键盘用户、触屏用户，以及「不知道这一块还能往下
 * 滚」的人都走它，而且它说的和自动加载是同一件事。
 */

import { useTranslation } from 'react-i18next';
import styles from './PoolLoadMore.module.scss';

export interface PoolLoadMoreProps {
  /** 已经显示了多少条。 */
  shown: number;
  /** 一共多少条。 */
  total: number;
  hasMore: boolean;
  onLoadMore: () => void;
}

export function PoolLoadMore({ shown, total, hasMore, onLoadMore }: PoolLoadMoreProps) {
  const { t } = useTranslation();
  if (total === 0) return null;

  return (
    <div className={styles.bar}>
      <span className={styles.range}>{t('sms_service.pool_shown', { shown, total })}</span>
      {hasMore ? (
        <button type="button" className={styles.more} onClick={onLoadMore}>
          {t('sms_service.pool_load_more')}
        </button>
      ) : (
        <span className={styles.done}>{t('sms_service.pool_all_shown')}</span>
      )}
    </div>
  );
}
