/**
 * 插件动作与任务 API（基座 `/v8/management/actions`、`/v8/management/jobs`）。
 *
 * 动作是插件声明的「有名字、有参数的操作」（例如 loomy 的扫描积分、绑定邀请码）。
 * 基座把各插件的动作聚合起来，面板据此渲染通用表单，因此面板既不需要知道动作
 * 属于哪个插件，也不必嵌入插件自建的 HTML。
 *
 * 长任务不同步等待：触发后基座立刻返回 job，面板轮询 `/jobs/:id` 读取进度。
 */

import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';

/** 动作的入参描述，用于渲染表单。 */
export interface PluginActionParam {
  name: string;
  title: string;
  type: string;
  required: boolean;
  options: string[];
}

/** 一个可触发的动作。 */
export interface PluginAction {
  pluginId: string;
  key: string;
  title: string;
  description: string;
  method: string;
  params: PluginActionParam[];
  /** 不可逆操作，触发前需二次确认。 */
  destructive: boolean;
  /** 长任务：触发返回 job，进度靠轮询。 */
  longRunning: boolean;
}

export type PluginJobState = 'running' | 'done' | 'failed' | 'cancelled';

/** 一次动作执行的实例。 */
export interface PluginJob {
  id: string;
  pluginId: string;
  key: string;
  title: string;
  state: PluginJobState;
  progress: number;
  message: string;
  startedAt: number;
  endedAt?: number;
  result?: unknown;
  error?: string;
  logs: string[];
}

/**
 * 触发动作的结果：长任务给 job，同步动作给插件自己的响应。
 *
 * 两者形状由基座保证 —— 长任务必定是 `{status, job}`，同步动作是插件原样响应，
 * 因此以「响应里有没有 job 对象」区分。
 */
export interface ActionTriggerResult {
  job?: PluginJob;
  result?: unknown;
}

const asString = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  return String(value);
};

const asNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
};

const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => asString(item).trim()).filter(Boolean) : [];

const normalizeParam = (value: unknown): PluginActionParam | null => {
  if (!isRecord(value)) return null;
  const name = asString(value.name).trim();
  if (!name) return null;
  return {
    name,
    title: asString(value.title).trim() || name,
    type: asString(value.type).trim().toLowerCase() || 'string',
    required: value.required === true,
    options: asStringList(value.options),
  };
};

const normalizeAction = (value: unknown): PluginAction | null => {
  if (!isRecord(value)) return null;
  const key = asString(value.key).trim();
  if (!key) return null;
  return {
    pluginId: asString(value.plugin_id).trim(),
    key,
    title: asString(value.title).trim() || key,
    description: asString(value.description).trim(),
    method: asString(value.method).trim(),
    params: Array.isArray(value.params)
      ? (value.params.map((item) => normalizeParam(item)).filter(Boolean) as PluginActionParam[])
      : [],
    destructive: value.destructive === true,
    longRunning: value.long_running === true,
  };
};

const normalizeJobState = (value: unknown): PluginJobState => {
  const state = asString(value).trim();
  if (state === 'done' || state === 'failed' || state === 'cancelled') return state;
  return 'running';
};

const normalizeJob = (value: unknown): PluginJob | null => {
  if (!isRecord(value)) return null;
  const id = asString(value.id).trim();
  if (!id) return null;
  return {
    id,
    pluginId: asString(value.plugin_id).trim(),
    key: asString(value.key).trim(),
    title: asString(value.title).trim(),
    state: normalizeJobState(value.state),
    progress: asNumber(value.progress),
    message: asString(value.message).trim(),
    startedAt: asNumber(value.started_at),
    endedAt: value.ended_at === undefined ? undefined : asNumber(value.ended_at),
    result: value.result,
    error: asString(value.error).trim() || undefined,
    logs: asStringList(value.logs),
  };
};

export const pluginActionsApi = {
  async list(): Promise<PluginAction[]> {
    const data = await apiClient.get('/actions');
    if (!isRecord(data) || !Array.isArray(data.actions)) return [];
    return data.actions.map((item) => normalizeAction(item)).filter(Boolean) as PluginAction[];
  },

  async trigger(key: string, payload: Record<string, unknown>): Promise<ActionTriggerResult> {
    const data = await apiClient.post(`/actions/${encodeURIComponent(key)}`, payload);
    const job = isRecord(data) ? normalizeJob(data.job) : null;
    if (job) return { job };
    return { result: data };
  },

  async listJobs(): Promise<PluginJob[]> {
    const data = await apiClient.get('/jobs');
    if (!isRecord(data) || !Array.isArray(data.jobs)) return [];
    return data.jobs.map((item) => normalizeJob(item)).filter(Boolean) as PluginJob[];
  },

  async getJob(id: string): Promise<PluginJob | null> {
    const data = await apiClient.get(`/jobs/${encodeURIComponent(id)}`);
    return isRecord(data) ? normalizeJob(data.job) : null;
  },

  cancelJob: (id: string) => apiClient.delete(`/jobs/${encodeURIComponent(id)}`),
};
