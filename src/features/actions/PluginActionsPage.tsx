/**
 * 插件动作页 —— 基座聚合的「动作网格」。
 *
 * 插件只声明「有哪些动作」（标题、参数、是否危险、是否长任务），页面负责渲染
 * 通用表单、触发、展示进度。因此换一个插件、加一个动作，面板不用改代码，也不必
 * 嵌入插件自建的 HTML。
 *
 * 长任务不阻塞页面：触发返回 job 后由轮询读取进度，运行中的任务可取消。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { pluginActionsApi } from '@/services/api/actions';
import type { PluginAction, PluginJob } from '@/services/api/actions';
import { getErrorMessage } from '@/utils/helpers';
import { formatDateTimeValue } from '@/utils/format';
import { PluginActionCard } from './PluginActionCard';
import styles from './PluginActionsPage.module.scss';

/** 轮询间隔：动作通常几分钟内完成，2 秒足够且不打扰后端。 */
const JOB_POLL_INTERVAL_MS = 2000;

export function PluginActionsPage() {
  const { t } = useTranslation();
  const [actions, setActions] = useState<PluginAction[]>([]);
  const [jobs, setJobs] = useState<PluginJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, unknown>>({});

  const loadActions = useCallback(async () => {
    try {
      const next = await pluginActionsApi.list();
      setActions(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(getErrorMessage(error, t('plugin_actions.load_failed')));
    }
  }, [t]);

  const loadJobs = useCallback(async () => {
    try {
      setJobs(await pluginActionsApi.listJobs());
    } catch {
      // 任务列表是辅助信息：读失败不覆盖动作本身的可用状态。
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.all([loadActions(), loadJobs()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadActions, loadJobs]);

  const hasRunningJob = useMemo(() => jobs.some((job) => job.state === 'running'), [jobs]);

  // 只在有任务运行时轮询，避免空闲时反复打后端。
  useEffect(() => {
    if (!hasRunningJob) return undefined;
    const timer = window.setInterval(() => {
      void loadJobs();
    }, JOB_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasRunningJob, loadJobs]);

  const trigger = useCallback(
    async (action: PluginAction, values: Record<string, unknown>) => {
      setBusyKey(action.key);
      setActionErrors((prev) => {
        const next = { ...prev };
        delete next[action.key];
        return next;
      });
      try {
        const outcome = await pluginActionsApi.trigger(action.key, values);
        if (outcome.job) {
          await loadJobs();
          return;
        }
        setResults((prev) => ({ ...prev, [action.key]: outcome.result }));
      } catch (error) {
        setActionErrors((prev) => ({
          ...prev,
          [action.key]: getErrorMessage(error, t('plugin_actions.run_failed')),
        }));
      } finally {
        setBusyKey(null);
      }
    },
    [loadJobs, t]
  );

  const cancelJob = useCallback(
    async (id: string) => {
      try {
        await pluginActionsApi.cancelJob(id);
      } finally {
        await loadJobs();
      }
    },
    [loadJobs]
  );

  const grouped = useMemo(() => {
    const byPlugin = new Map<string, PluginAction[]>();
    for (const action of actions) {
      const list = byPlugin.get(action.pluginId) ?? [];
      list.push(action);
      byPlugin.set(action.pluginId, list);
    }
    return Array.from(byPlugin.entries());
  }, [actions]);

  const jobStateLabel = (state: PluginJob['state']) => t(`plugin_actions.job_state_${state}`);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.headerCopy}>
          <h1 className={styles.title}>{t('plugin_actions.title')}</h1>
          <p className={styles.pageSubtitle}>{t('plugin_actions.subtitle')}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void loadActions();
            void loadJobs();
          }}
        >
          {t('plugin_actions.refresh')}
        </Button>
      </header>

      {loadError ? <Notice tone="danger">{loadError}</Notice> : null}

      {loading ? (
        <p className={styles.muted}>{t('plugin_actions.loading')}</p>
      ) : actions.length === 0 ? (
        <EmptyState
          title={t('plugin_actions.empty_title')}
          description={t('plugin_actions.empty_desc')}
        />
      ) : (
        grouped.map(([pluginId, pluginActions]) => (
          <section key={pluginId} className={styles.group}>
            <h2 className={styles.groupTitle}>{pluginId}</h2>
            <div className={styles.grid}>
              {pluginActions.map((action) => (
                <PluginActionCard
                  key={action.key}
                  action={action}
                  busy={busyKey === action.key}
                  error={actionErrors[action.key]}
                  result={results[action.key]}
                  onTrigger={(values) => void trigger(action, values)}
                />
              ))}
            </div>
          </section>
        ))
      )}

      <Card title={t('plugin_actions.jobs_title')}>
        {jobs.length === 0 ? (
          <p className={styles.muted}>{t('plugin_actions.jobs_empty')}</p>
        ) : (
          <ul className={styles.jobs}>
            {jobs.map((job) => (
              <li key={job.id} className={styles.job}>
                <div className={styles.jobHead}>
                  <span className={styles.jobTitle}>{job.title || job.key}</span>
                  <span className={`${styles.tag} ${job.state === 'failed' ? styles.tagWarning : styles.tagMuted}`}>
                    {jobStateLabel(job.state)}
                  </span>
                  {job.state === 'running' ? (
                    <Button variant="ghost" size="sm" onClick={() => void cancelJob(job.id)}>
                      {t('plugin_actions.job_cancel')}
                    </Button>
                  ) : null}
                </div>
                {job.state === 'running' ? (
                  <progress className={styles.jobProgress} value={job.progress} max={1} />
                ) : null}
                <div className={styles.jobMeta}>
                  <span>{formatDateTimeValue(job.startedAt)}</span>
                  {job.message ? <span className={styles.jobMessage}>{job.message}</span> : null}
                  {job.error ? <span className={styles.jobError}>{job.error}</span> : null}
                </div>
                {job.logs.length > 0 ? (
                  <details className={styles.result}>
                    <summary>{t('plugin_actions.job_logs')}</summary>
                    <pre className={styles.resultBody}>{job.logs.join('\n')}</pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
