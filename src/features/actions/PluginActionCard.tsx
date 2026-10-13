/**
 * 一个插件动作的通用卡片：按动作声明的参数渲染表单，触发后展示结果。
 *
 * 卡片只认界面形状（`PluginAction`），不认后端字段 —— 后端字段名在
 * `services/api/actions.ts` 的映射层里就消化掉了。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useNotificationStore } from '@/stores';
import type { PluginAction } from '@/services/api/actions';
import { buildActionPayload, type ActionFormValue } from './actionPayload';
import styles from './PluginActionsPage.module.scss';

interface PluginActionCardProps {
  action: PluginAction;
  busy: boolean;
  error?: string;
  result?: unknown;
  onTrigger: (values: Record<string, unknown>) => void;
}

/** 结果里的 JSON 原样展示，便于通用网格承接任意动作的返回形状。 */
function formatResult(result: unknown): string {
  try {
    return JSON.stringify(result, null, 2) ?? '';
  } catch {
    return String(result);
  }
}

export function PluginActionCard({ action, busy, error, result, onTrigger }: PluginActionCardProps) {
  const { t } = useTranslation();
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const [values, setValues] = useState<Record<string, ActionFormValue>>({});

  const submit = () => {
    const payload = buildActionPayload(action, values);
    if (!action.destructive) {
      onTrigger(payload);
      return;
    }
    showConfirmation({
      title: t('plugin_actions.destructive_confirm_title'),
      message: t('plugin_actions.destructive_confirm_message', { title: action.title }),
      confirmText: t('plugin_actions.run'),
      variant: 'danger',
      onConfirm: () => onTrigger(payload),
    });
  };

  const setValue = (name: string, value: ActionFormValue) =>
    setValues((prev) => ({ ...prev, [name]: value }));

  return (
    <Card
      title={
        <span className={styles.cardTitle}>
          {action.title}
          {action.longRunning ? (
            <span className={`${styles.tag} ${styles.tagMuted}`}>
              {t('plugin_actions.long_running')}
            </span>
          ) : null}
          {action.destructive ? (
            <span className={`${styles.tag} ${styles.tagWarning}`}>
              {t('plugin_actions.destructive')}
            </span>
          ) : null}
        </span>
      }
      extra={<span className={styles.pluginName}>{action.pluginId}</span>}
    >
      <div className={styles.cardBody}>
        {action.description ? <p className={styles.actionDesc}>{action.description}</p> : null}

        {action.params.map((param) => {
          if (param.type === 'bool') {
            return (
              <ToggleSwitch
                key={param.name}
                checked={values[param.name] === true}
                onChange={(next) => setValue(param.name, next)}
                label={param.title}
                labelPosition="left"
              />
            );
          }
          if (param.type === 'select' && param.options.length > 0) {
            return (
              <Select
                key={param.name}
                value={String(values[param.name] ?? '')}
                options={param.options.map((option) => ({ value: option, label: option }))}
                onChange={(next) => setValue(param.name, next)}
                placeholder={param.title}
                ariaLabel={param.title}
                fullWidth
              />
            );
          }
          return (
            <Input
              key={param.name}
              label={param.title}
              value={String(values[param.name] ?? '')}
              onChange={(event) => setValue(param.name, event.target.value)}
              inputMode={param.type === 'int' ? 'numeric' : undefined}
            />
          );
        })}

        {error ? <Notice tone="danger">{error}</Notice> : null}

        <div className={styles.cardActions}>
          <Button variant={action.destructive ? 'danger' : 'primary'} size="sm" loading={busy} onClick={submit}>
            {t('plugin_actions.run')}
          </Button>
        </div>

        {result !== undefined ? (
          <details className={styles.result}>
            <summary>{t('plugin_actions.result_raw')}</summary>
            <pre className={styles.resultBody}>{formatResult(result)}</pre>
          </details>
        ) : null}
      </div>
    </Card>
  );
}
