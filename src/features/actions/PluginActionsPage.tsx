/**
 * 插件动作页 —— 左侧插件栏 + 右侧「先选动作、再运行」。
 *
 * 一个插件可能声明五六个动作；把它们平铺成网格会让人无从下手。所以页面按工具
 * 的用法组织：左侧选插件，右侧只显示这个插件的动作，并且分两步 —— 先选要做的
 * 事，再填参数运行。动作的标题、说明、参数仍全部来自插件声明，页面不认任何插件
 * 自己的字段。
 *
 * 长任务不阻塞页面：触发返回 job 后由轮询读取进度，运行中的任务可取消。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { IconCheck, IconPlug } from '@/components/ui/icons';
import { pluginsApi } from '@/services/api';
import { pluginActionsApi } from '@/services/api/actions';
import type { PluginAction, PluginJob } from '@/services/api/actions';
import { useAuthStore } from '@/stores';
import { getErrorMessage } from '@/utils/helpers';
import { formatDateTimeValue } from '@/utils/format';
import { getPluginTitle, resolvePluginAssetURL } from '@/features/plugins/pluginResources';
import { PluginActionCard } from './PluginActionCard';
import { ResultStepList } from './ResultStepList';
import { collectResultChoices, collectResultSteps, formatResultJson } from './actionResultLinks';
import styles from './PluginActionsPage.module.scss';

/** 轮询间隔：动作通常几分钟内完成，2 秒足够且不打扰后端。 */
const JOB_POLL_INTERVAL_MS = 2000;

/** 一个插件在左侧栏里的呈现：名字与图标都来自插件自己的声明。 */
interface PluginSummary {
  title: string;
  logo: string;
}

function PluginMark({ logo }: { logo: string }) {
  const [failed, setFailed] = useState(false);
  if (logo && !failed) {
    return (
      <img
        className={styles.pluginMark}
        src={logo}
        alt=""
        aria-hidden="true"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className={`${styles.pluginMark} ${styles.pluginMarkFallback}`} aria-hidden="true">
      <IconPlug size={15} />
    </span>
  );
}

/** 已收尾的任务默认只露最近 5 条，点一次多露 5 条。 */
const FINISHED_JOB_BATCH = 5;

/** 一条任务：标题、状态、进度、时间与可展开日志；运行中的多一个取消。 */
function JobItem({
  job,
  onCancel,
  onRunChoice,
}: {
  job: PluginJob;
  onCancel: (id: string) => void;
  onRunChoice: (key: string, params: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const choices = collectResultChoices(job.result);
  const steps = collectResultSteps(job.result);
  return (
    <li className={styles.job}>
      <div className={styles.jobHead}>
        <span className={styles.jobTitle}>{job.title || job.key}</span>
        <span
          className={`${styles.tag} ${job.state === 'failed' ? styles.tagWarning : styles.tagMuted}`}
        >
          {t(`plugin_actions.job_state_${job.state}`)}
        </span>
        {job.state === 'running' ? (
          <Button variant="ghost" size="sm" onClick={() => onCancel(job.id)}>
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
      {/* 一条流水线的结果先给步骤清单：现在在哪一步、每步差什么。 */}
      {steps.length > 0 ? (
        <ResultStepList
          steps={steps}
          onRunAction={(key, params) => onRunChoice(key, params)}
        />
      ) : null}
      {/* 结果里点名了候选账号时，下一步就是选一个再跑一次，不该让人去抄标识。
          没有标题的一排按钮看不出是下一步，所以和动作卡一样先给一句话。 */}
      {choices.length > 0 ? (
        <div className={styles.links}>
          <span className={styles.linksTitle}>{t('plugin_actions.choices_title')}</span>
          <div className={styles.choices}>
            {choices.map((choice) => (
              <div
                key={`${choice.label}:${JSON.stringify(choice.params)}`}
                className={styles.choice}
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onRunChoice(job.key, choice.params)}
                >
                  {choice.label}
                </Button>
                {choice.hint ? <span className={styles.choiceHint}>{choice.hint}</span> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {job.result !== undefined ? (
        <details className={styles.result}>
          <summary>{t('plugin_actions.job_result')}</summary>
          <pre className={styles.resultBody}>{formatResultJson(job.result)}</pre>
        </details>
      ) : null}
      {job.logs.length > 0 ? (
        <details className={styles.result}>
          <summary>{t('plugin_actions.job_logs')}</summary>
          <pre className={styles.resultBody}>{job.logs.join('\n')}</pre>
        </details>
      ) : null}
    </li>
  );
}

interface PluginJobListProps {
  jobs: PluginJob[];
  onCancel: (id: string) => void;
  onRunChoice: (key: string, params: Record<string, unknown>) => void;
}

/**
 * 任务列表：运行中的全部显示，已收尾的只显示最近几条，更早的按批展开。
 *
 * 单独导出是为了让静态渲染测试能直接喂数据 —— 页面组件自己会去拉任务。
 */
export function PluginJobList({ jobs, onCancel, onRunChoice }: PluginJobListProps) {
  const { t } = useTranslation();
  const [visibleFinished, setVisibleFinished] = useState(FINISHED_JOB_BATCH);

  const running = jobs.filter((job) => job.state === 'running');
  // 后端按新→旧下发，这里保持原顺序，切片即「最近 N 条」。
  const finished = jobs.filter((job) => job.state !== 'running');
  const shownFinished = finished.slice(0, visibleFinished);
  const hasEarlier = finished.length > shownFinished.length;

  return (
    <div className={styles.jobGroups}>
      {running.length > 0 ? (
        <section className={styles.jobGroup}>
          <h3 className={styles.jobGroupTitle}>{t('plugin_actions.jobs_running')}</h3>
          <ul className={styles.jobs}>
            {running.map((job) => (
              <JobItem key={job.id} job={job} onCancel={onCancel} onRunChoice={onRunChoice} />
            ))}
          </ul>
        </section>
      ) : null}

      {finished.length > 0 ? (
        <section className={styles.jobGroup}>
          <h3 className={styles.jobGroupTitle}>{t('plugin_actions.jobs_finished')}</h3>
          <ul
            className={
              shownFinished.length > FINISHED_JOB_BATCH
                ? `${styles.jobs} ${styles.jobsExpanded}`
                : styles.jobs
            }
          >
            {shownFinished.map((job) => (
              <JobItem key={job.id} job={job} onCancel={onCancel} onRunChoice={onRunChoice} />
            ))}
          </ul>
          {hasEarlier ? (
            <Button
              variant="ghost"
              size="sm"
              className={styles.jobMore}
              onClick={() => setVisibleFinished((count) => count + FINISHED_JOB_BATCH)}
            >
              {`${t('plugin_actions.jobs_show_earlier')} · ${t('plugin_actions.jobs_total', {
                count: finished.length,
              })}`}
            </Button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export function PluginActionsPage() {
  const { t } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const [actions, setActions] = useState<PluginAction[]>([]);
  const [jobs, setJobs] = useState<PluginJob[]>([]);
  const [pluginSummaries, setPluginSummaries] = useState<Record<string, PluginSummary>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, unknown>>({});
  const [selectedPluginId, setSelectedPluginId] = useState('');
  const [selectedKey, setSelectedKey] = useState('');

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

  // 插件名与图标是展示信息：读不到就退回插件 id，不影响动作本身。
  useEffect(() => {
    let cancelled = false;
    void pluginsApi.list().then(
      (response) => {
        if (cancelled) return;
        const next: Record<string, PluginSummary> = {};
        for (const plugin of response.plugins) {
          next[plugin.id] = {
            title: getPluginTitle(plugin),
            logo: plugin.logo || plugin.metadata?.logo || '',
          };
        }
        setPluginSummaries(next);
      },
      () => {
        // 名字读不到时用 id 代替，不是错误状态。
      }
    );
    return () => {
      cancelled = true;
    };
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

  // 候选按钮来自某个任务的结果：先把动作切到那一条，再带着结果给的参数跑，
  // 这样「选账号」就是一次点击，而不是抄一串标识回到表单里粘贴。
  const runChoice = useCallback(
    (key: string, values: Record<string, unknown>) => {
      const action = actions.find((item) => item.key === key);
      if (!action) return;
      setSelectedPluginId(action.pluginId);
      setSelectedKey(action.key);
      void trigger(action, values);
    },
    [actions, trigger]
  );

  // 结果要求自动刷新时重跑同一个动作，原地更新结果：不置忙、不弹错、不切面板。
  // 失败就保留上一次读到的真实状态，等下一次刷新。
  const pollAction = useCallback(
    async (key: string, values: Record<string, unknown>) => {
      if (!actions.some((item) => item.key === key)) return;
      try {
        const outcome = await pluginActionsApi.trigger(key, values);
        if (outcome.job) {
          await loadJobs();
          return;
        }
        setResults((prev) => ({ ...prev, [key]: outcome.result }));
      } catch {
        // 自动刷新不是用户操作，失败不该变成一条醒目的错误。
      }
    },
    [actions, loadJobs]
  );

  const groups = useMemo(() => {
    const byPlugin = new Map<string, PluginAction[]>();
    for (const action of actions) {
      const list = byPlugin.get(action.pluginId) ?? [];
      list.push(action);
      byPlugin.set(action.pluginId, list);
    }
    return Array.from(byPlugin.entries())
      .map(([pluginId, pluginActions]) => ({
        pluginId,
        title: pluginSummaries[pluginId]?.title || pluginId,
        logo: resolvePluginAssetURL(pluginSummaries[pluginId]?.logo ?? '', apiBase),
        actions: pluginActions,
      }))
      .sort((left, right) => left.title.localeCompare(right.title));
  }, [actions, pluginSummaries, apiBase]);

  // 选择是「插件 + 动作」，两者都允许回落到第一项：这样加载完成、插件被移除、
  // 或者动作下架都不会留下一个空的面板，也不需要额外的同步 effect。
  const activeGroup = groups.find((group) => group.pluginId === selectedPluginId) ?? groups[0];
  const activeAction =
    activeGroup?.actions.find((action) => action.key === selectedKey) ?? activeGroup?.actions[0];

  // 运行中的任务由任务列表推导，而不是记住「刚点过」，这样任务结束后提示会自己消失。
  const runningJob = activeAction
    ? jobs.find((job) => job.key === activeAction.key && job.state === 'running')
    : undefined;

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
        <div className={styles.workspace}>
          <nav className={styles.rail} aria-label={t('plugin_actions.rail_title')}>
            <p className={styles.railLabel}>{t('plugin_actions.rail_title')}</p>
            {groups.map((group) => {
              const current = group.pluginId === activeGroup?.pluginId;
              return (
                <button
                  key={group.pluginId}
                  type="button"
                  className={current ? `${styles.railItem} ${styles.railItemActive}` : styles.railItem}
                  aria-current={current ? 'page' : undefined}
                  onClick={() => {
                    setSelectedPluginId(group.pluginId);
                    setSelectedKey('');
                  }}
                >
                  <PluginMark logo={group.logo} />
                  <span className={styles.railText}>
                    <span className={styles.railName}>{group.title}</span>
                    <span className={styles.railMeta}>
                      {t('plugin_actions.action_count', { count: group.actions.length })}
                    </span>
                  </span>
                </button>
              );
            })}
          </nav>

          <div className={styles.detail}>
            <div className={styles.detailHead}>
              <PluginMark logo={activeGroup.logo} />
              <div className={styles.detailIdentity}>
                <h2 className={styles.detailName}>{activeGroup.title}</h2>
                <span className={styles.detailMeta}>
                  {t('plugin_actions.action_count', { count: activeGroup.actions.length })}
                </span>
              </div>
            </div>

            <section className={styles.step} aria-labelledby="plugin-actions-step-pick">
              <div className={styles.stepHead}>
                <span className={styles.stepIndex} aria-hidden="true">
                  1
                </span>
                <h3 className={styles.stepTitle} id="plugin-actions-step-pick">
                  {t('plugin_actions.step_pick')}
                </h3>
              </div>
              <div className={styles.picker}>
                {activeGroup.actions.map((action) => {
                  const current = action.key === activeAction?.key;
                  return (
                    <button
                      key={action.key}
                      type="button"
                      className={
                        current ? `${styles.pickerItem} ${styles.pickerItemActive}` : styles.pickerItem
                      }
                      aria-pressed={current}
                      onClick={() => setSelectedKey(action.key)}
                    >
                      <span className={styles.pickerName}>{action.title}</span>
                      {action.description ? (
                        <span className={styles.pickerDesc}>{action.description}</span>
                      ) : null}
                      <span className={styles.pickerMark} aria-hidden="true">
                        {current ? <IconCheck size={15} /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {activeAction ? (
              <section className={styles.step} aria-labelledby="plugin-actions-step-run">
                <div className={styles.stepHead}>
                  <span className={styles.stepIndex} aria-hidden="true">
                    2
                  </span>
                  <h3 className={styles.stepTitle} id="plugin-actions-step-run">
                    {t('plugin_actions.step_run')}
                  </h3>
                </div>
                <PluginActionCard
                  key={activeAction.key}
                  action={activeAction}
                  busy={busyKey === activeAction.key}
                  error={actionErrors[activeAction.key]}
                  result={results[activeAction.key]}
                  notice={runningJob ? t('plugin_actions.running_notice') : undefined}
                  onTrigger={(values) => void trigger(activeAction, values)}
                  onRunAction={runChoice}
                  onPoll={(key, params) => void pollAction(key, params)}
                />
              </section>
            ) : null}
          </div>
        </div>
      )}

      {/* 没有任务时整块不出现：空卡片除了占地方没有别的用处。 */}
      {jobs.length > 0 ? (
        <Card title={t('plugin_actions.jobs_title')}>
          <PluginJobList jobs={jobs} onCancel={(id) => void cancelJob(id)} onRunChoice={runChoice} />
        </Card>
      ) : null}
    </div>
  );
}