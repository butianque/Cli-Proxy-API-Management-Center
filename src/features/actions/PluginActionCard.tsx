/**
 * 一个插件动作的通用面板：按动作声明的参数渲染表单，触发后展示结果。
 *
 * 面板只认界面形状（`PluginAction`），不认后端字段 —— 后端字段名在
 * `services/api/actions.ts` 的映射层里就消化掉了。
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { IconCopy } from '@/components/ui/icons';
import { copyToClipboard } from '@/utils/clipboard';
import { useNotificationStore } from '@/stores';
import type { PluginAction } from '@/services/api/actions';
import { buildActionPayload, type ActionFormValue } from './actionPayload';
import {
  collectResultChoices,
  collectResultLinks,
  collectResultNotes,
  collectResultPair,
  collectResultPoll,
  collectResultSteps,
  formatResultJson,
} from './actionResultLinks';
import { ResultStepList } from './ResultStepList';
import styles from './PluginActionsPage.module.scss';

interface PluginActionCardProps {
  action: PluginAction;
  busy: boolean;
  error?: string;
  result?: unknown;
  /** 运行中提示（由页面按任务状态推导），不是由本组件记住状态。 */
  notice?: string;
  onTrigger: (values: Record<string, unknown>) => void;
  /** 结果里的步骤可以点名另一个动作；由页面按动作 key 重跑。 */
  onRunAction?: (key: string, params: Record<string, unknown>) => void;
  /** 结果要求自动刷新时，由页面静默重跑同一动作；不置忙、不覆盖错误。 */
  onPoll?: (key: string, params: Record<string, unknown>) => void;
}

/**
 * 自动刷新的上限：等的是操作者在浏览器里完成的一步，页面可能一直开着没人动。
 * 到这个次数就停下，改成手动刷新；不做没有尽头的后台请求。
 */
const MAX_POLL_ATTEMPTS = 80;

export function PluginActionCard({
  action,
  busy,
  error,
  result,
  notice,
  onTrigger,
  onRunAction,
  onPoll,
}: PluginActionCardProps) {
  const { t } = useTranslation();
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [values, setValues] = useState<Record<string, ActionFormValue>>({});
  const links = result === undefined ? [] : collectResultLinks(result);
  const choices = result === undefined ? [] : collectResultChoices(result);
  const steps = result === undefined ? [] : collectResultSteps(result);
  const notes = result === undefined ? [] : collectResultNotes(result);
  const pair = result === undefined ? undefined : collectResultPair(result);
  const poll = result === undefined ? undefined : collectResultPoll(result);

  // 轮询的身份只由「重跑哪个动作、带什么参数」决定：结果每刷新一次都是新对象，
  // 拿对象本身当依赖会把计时器一直重启。
  const pollSignature = poll ? `${poll.key}:${poll.intervalMs}:${JSON.stringify(poll.params)}` : '';
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const onPollRef = useRef(onPoll);
  onPollRef.current = onPoll;

  useEffect(() => {
    if (!pollSignature || busy) return undefined;
    let attempts = 0;
    const timer = window.setInterval(() => {
      const current = pollRef.current;
      const runPoll = onPollRef.current;
      if (!current || !runPoll) return;
      attempts += 1;
      if (attempts > MAX_POLL_ATTEMPTS) {
        window.clearInterval(timer);
        return;
      }
      runPoll(current.key, current.params);
    }, pollRef.current?.intervalMs ?? 15_000);
    return () => window.clearInterval(timer);
  }, [pollSignature, busy]);

  const copyLink = async (link: string) => {
    const copied = await copyToClipboard(link);
    showNotification(
      copied
        ? t('notification.link_copied', { defaultValue: 'Copied to clipboard' })
        : t('notification.copy_failed', { defaultValue: 'Copy failed' }),
      copied ? 'success' : 'error'
    );
  };

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
    >
      <div className={styles.cardBody}>
        {action.description ? <p className={styles.actionDesc}>{action.description}</p> : null}

        {action.params.length === 0 ? (
          <p className={styles.hint}>{t('plugin_actions.no_params')}</p>
        ) : null}

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

        {notice ? <Notice tone="info">{notice}</Notice> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}

        <div className={styles.cardActions}>
          <Button
            variant={action.destructive ? 'danger' : 'primary'}
            size="sm"
            loading={busy}
            onClick={submit}
          >
            {t('plugin_actions.run')}
          </Button>
        </div>

        {/* 谁邀请、谁被邀请，先说在步骤前面：操作者拿这两行去核对浏览器里登录的
            到底是哪个号，而不是从 JSON 里自己找。 */}
        {pair ? (
          <div className={styles.pair}>
            {pair.items.map((item) => (
              <div key={item.label} className={styles.pairRow}>
                <span className={styles.pairLabel}>{item.label}</span>
                <span className={styles.pairValue}>{item.value}</span>
              </div>
            ))}
            {pair.hint ? <p className={styles.pairHint}>{pair.hint}</p> : null}
          </div>
        ) : null}

        {steps.length > 0 ? <ResultStepList steps={steps} onRunAction={onRunAction} /> : null}

        {/* 步骤已经逐条说过的话不再重复；没有步骤时，这几句就是全部的说明。 */}
        {steps.length === 0 && notes.length > 0 ? (
          <ul className={styles.notes}>
            {notes.map((note) => (
              <li key={note} className={styles.note}>
                {note}
              </li>
            ))}
          </ul>
        ) : null}

        {/* 步骤里已经带着自己的链接，再列一遍同样的地址只是噪音。 */}
        {steps.length === 0 && links.length > 0 ? (
          <div className={styles.links}>
            <span className={styles.linksTitle}>{t('plugin_actions.result_links')}</span>
            {links.map((link) => (
              <div key={link} className={styles.linkRow}>
                <code className={styles.linkText}>{link}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void copyLink(link)}
                  aria-label={t('common.copy')}
                >
                  <span className={styles.copyLabel}>
                    <IconCopy size={13} aria-hidden="true" />
                    {t('common.copy')}
                  </span>
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        {/* 结果点名了候选时，选一个就等于用它的参数重跑本动作。标题必须说清楚
            「这些是给你点的」，否则一排孤立按钮看不出是下一步。 */}
        {choices.length > 0 ? (
          <div className={styles.links}>
            <span className={styles.linksTitle}>{t('plugin_actions.choices_title')}</span>
            <div className={styles.choices}>
              {choices.map((choice) => (
                <div
                  key={`${choice.label}:${JSON.stringify(choice.params)}`}
                  className={styles.choice}
                >
                  <Button variant="secondary" size="sm" onClick={() => onTrigger(choice.params)}>
                    {choice.label}
                  </Button>
                  {choice.hint ? <span className={styles.choiceHint}>{choice.hint}</span> : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {result !== undefined ? (
          <details className={styles.result}>
            <summary>{t('plugin_actions.result_raw')}</summary>
            <pre className={styles.resultBody}>{formatResultJson(result)}</pre>
          </details>
        ) : null}
      </div>
    </Card>
  );
}