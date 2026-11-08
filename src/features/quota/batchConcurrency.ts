/**
 * 额度批量刷新的并发 / 去重 / 退避控制（React-free —— 由测试直接消费）。
 *
 * 背景：一次额度刷新会对每个凭据发一个额度请求；旧实现把这些请求一次性全部发出
 * （`Promise.allSettled(requests)`），单秒上百个请求同时压到后端，触发 nginx 限流
 * 并大量返回 503（自伤式并发滥用）。这里把三件事收敛到一处、可独立测试：
 * - buildQuotaRefreshJobs：一次刷新到底该发哪些请求（解析插件通道 + 去重）；
 * - createConcurrencyLimiter：全批次共享的并发闸门（默认 QUOTA_BATCH_CONCURRENCY 路）；
 * - withQuotaRetry：429/503 的有限次指数退避，绝不死循环。
 *
 * 闸门只限制在途请求数，不改变请求集合本身。
 */

import { findQuotaPluginId } from '@/services/api/accountQuota';
import type { AuthFileItem } from '@/types';
import { getStatusFromError } from '@/utils/quota/formatters';

/** 一次额度刷新同时保持在途的请求上限（可调常量）。 */
export const QUOTA_BATCH_CONCURRENCY = 6;

/** 单条请求的总尝试次数上限（含首次）；重试次数 = 上限 - 1。 */
export const QUOTA_RETRY_MAX_ATTEMPTS = 3;

/** 退避首延迟；之后按 2 的幂增长，并以 QUOTA_RETRY_MAX_DELAY_MS 封顶。 */
export const QUOTA_RETRY_BASE_DELAY_MS = 300;
export const QUOTA_RETRY_MAX_DELAY_MS = 4000;

/** 一条额度刷新请求的身份：插件通道 + 宿主 authIndex。 */
export interface QuotaRefreshJob {
  pluginId: string;
  authIndex: string;
}

/**
 * 解析一次刷新该发哪些额度请求。
 *
 * 候选 provider 键的先后即优先级（`file.provider` 先于 `file.type`）；取不到插件
 * id 或宿主没给 authIndex 的凭据不参与（宿主无处落快照）。同一「插件 + authIndex」
 * 只保留一次 —— 跨 tab 去重需要额外共享状态（BroadcastChannel / localStorage 锁），
 * 代价是可能误伤另一个 tab 的合法刷新，而单页刷新本身已串行化，收益不明确，故只做
 * 单页内去重。
 */
export function buildQuotaRefreshJobs(
  quotaPluginIndex: ReadonlyMap<string, string>,
  files: readonly AuthFileItem[]
): QuotaRefreshJob[] {
  const seen = new Set<string>();
  const jobs: QuotaRefreshJob[] = [];
  for (const file of files) {
    const pluginId = findQuotaPluginId(quotaPluginIndex, [
      String(file.provider ?? ''),
      String(file.type ?? ''),
    ]);
    const authIndex = String(file.authIndex ?? '').trim();
    if (!pluginId || !authIndex) continue;
    const key = `${pluginId}\u0000${authIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({ pluginId, authIndex });
  }
  return jobs;
}

export interface ConcurrencyLimiter {
  /** 取得一个槽位后执行 task；在途任务数永远不超过构造时的 limit。 */
  run: <T>(task: () => Promise<T>) => Promise<T>;
  /** 当前在途任务数（供测试断言）。 */
  activeCount: () => number;
}

/**
 * 建立并发闸门：至多 limit 个 task 同时在途，其余按 FIFO 排队。
 * 同一个实例在整批刷新中共享，因此所有请求合计也不超过 limit。
 */
export function createConcurrencyLimiter(limit: number): ConcurrencyLimiter {
  const max = Math.max(1, Math.floor(limit) || 1);
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < max) {
        active += 1;
        resolve();
        return;
      }
      waiters.push(() => {
        active += 1;
        resolve();
      });
    });

  const release = (): void => {
    if (active > 0) active -= 1;
    waiters.shift()?.();
  };

  return {
    run: async <T>(task: () => Promise<T>): Promise<T> => {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
    activeCount: () => active,
  };
}

/** 429（限流）/ 503（上游不可用）是唯一可重试的瞬时状态。 */
export function isRetryableQuotaStatus(status: number | undefined): boolean {
  return status === 429 || status === 503;
}

/** 第 attempt 次失败后的退避延迟（attempt 从 1 起），指数增长并封顶。 */
export function quotaRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  return Math.min(QUOTA_RETRY_BASE_DELAY_MS * 2 ** exponent, QUOTA_RETRY_MAX_DELAY_MS);
}

export interface QuotaRetryOptions {
  /** 总尝试次数（含首次），默认 QUOTA_RETRY_MAX_ATTEMPTS。 */
  maxAttempts?: number;
  /** 退避等待，默认真实 setTimeout；测试可注入即时实现。 */
  sleep?: (ms: number) => Promise<void>;
  /** 错误 → HTTP 状态码，默认复用额度模块的 getStatusFromError。 */
  getStatus?: (err: unknown) => number | undefined;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 对可能被限流的单次请求做有限次指数退避重试。
 * 只有 429/503 才重试；其余错误立即抛出。尝试次数封顶，绝不死循环。
 */
export async function withQuotaRetry<T>(
  run: () => Promise<T>,
  options: QuotaRetryOptions = {}
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? QUOTA_RETRY_MAX_ATTEMPTS));
  const sleep = options.sleep ?? realSleep;
  const getStatus = options.getStatus ?? getStatusFromError;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await run();
    } catch (err: unknown) {
      lastError = err;
      if (!isRetryableQuotaStatus(getStatus(err))) throw err;
    }
    if (attempt < maxAttempts) await sleep(quotaRetryDelayMs(attempt));
  }
  throw lastError;
}
