import type { HTMLAttributes, PropsWithChildren, ReactNode } from 'react';
import styles from './Notice.module.scss';

/** 提示条的语气：决定边框与文字颜色。 */
export type NoticeTone = 'info' | 'warning' | 'danger';

const toneClass: Record<NoticeTone, string> = {
  info: styles.info,
  warning: styles.warning,
  danger: styles.danger,
};

interface NoticeProps extends HTMLAttributes<HTMLDivElement> {
  tone?: NoticeTone;
  /** 行首图标（一般用 `IconAlertTriangle` 一类）。 */
  icon?: ReactNode;
  /** 行尾动作（如一个按钮）。 */
  action?: ReactNode;
}

/**
 * 一行提示条：图标 + 说明 +（可选）动作。
 *
 * 用于页面内的告知（读数据失败、成本提醒、锁定提醒等）。**不承担布局边距** ——
 * 由使用方用自己的间距把提示条摆到合适的位置，这样同一个组件既能在页面顶部，
 * 也能在卡片里。
 */
export function Notice({
  tone = 'info',
  icon,
  action,
  children,
  className,
  ...rest
}: PropsWithChildren<NoticeProps>) {
  const cls = [styles.notice, toneClass[tone], className].filter(Boolean).join(' ');
  return (
    <div className={cls} {...rest}>
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      <span className={styles.text}>{children}</span>
      {action ? <span className={styles.action}>{action}</span> : null}
    </div>
  );
}
