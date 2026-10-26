/**
 * 结果里的执行步骤清单。
 *
 * 一条流水线动作的产出不止一个值，而是「现在在第几步、每步差什么」。这里按结果
 * 给的顺序渲染：序号、标题、状态徽标、说明、可复制的链接，以及该点就继续的下一
 * 个动作。组件只认 `ResultStep` 这个界面形状，不认任何插件字段。
 */

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconCopy } from '@/components/ui/icons';
import { copyToClipboard } from '@/utils/clipboard';
import { useNotificationStore } from '@/stores';
import type { ResultStep } from './actionResultLinks';
import styles from './PluginActionsPage.module.scss';

interface ResultStepListProps {
  steps: ResultStep[];
  /** 用这一步自带的参数重跑它点名的动作；缺省时不渲染动作按钮。 */
  onRunAction?: (key: string, params: Record<string, unknown>) => void;
}

export function ResultStepList({ steps, onRunAction }: ResultStepListProps) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);

  const copyLink = async (link: string) => {
    const copied = await copyToClipboard(link);
    showNotification(
      copied
        ? t('notification.link_copied', { defaultValue: 'Copied to clipboard' })
        : t('notification.copy_failed', { defaultValue: 'Copy failed' }),
      copied ? 'success' : 'error'
    );
  };

  return (
    <div className={styles.flow}>
      <span className={styles.flowTitle}>{t('plugin_actions.steps_title')}</span>
      <ol className={styles.flowList}>
        {steps.map((step) => (
          <li
            key={step.key}
            className={`${styles.flowStep} ${styles[`flowStep_${step.state}`]}`}
            aria-label={`${step.index}. ${step.title}`}
          >
            <span className={styles.flowIndex} aria-hidden="true">
              {step.index}
            </span>
            <div className={styles.flowBody}>
              <div className={styles.flowHead}>
                <span className={styles.flowStepTitle}>{step.title}</span>
                <span className={`${styles.flowState} ${styles[`flowState_${step.state}`]}`}>
                  {t(`plugin_actions.step_state_${step.state}`)}
                </span>
              </div>
              {step.detail ? <p className={styles.flowDetail}>{step.detail}</p> : null}
              {step.link ? (
                <div className={styles.linkRow}>
                  <code className={styles.linkText}>{step.link}</code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyLink(step.link as string)}
                    aria-label={t('common.copy')}
                  >
                    <span className={styles.copyLabel}>
                      <IconCopy size={13} aria-hidden="true" />
                      {t('common.copy')}
                    </span>
                  </Button>
                </div>
              ) : null}
              {step.action && onRunAction ? (
                <div className={styles.flowActions}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onRunAction(step.action!.key, step.action!.params)}
                  >
                    {step.action.label}
                  </Button>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}