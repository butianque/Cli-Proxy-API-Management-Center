import { describe, expect, test } from 'bun:test';
import type { AuthFileItem } from '@/types';
import {
  QUOTA_BATCH_CONCURRENCY,
  QUOTA_RETRY_BASE_DELAY_MS,
  QUOTA_RETRY_MAX_ATTEMPTS,
  QUOTA_RETRY_MAX_DELAY_MS,
  buildQuotaRefreshJobs,
  createConcurrencyLimiter,
  isRetryableQuotaStatus,
  quotaRetryDelayMs,
  withQuotaRetry,
} from '@/features/quota/batchConcurrency';

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const statusError = (message: string, status: number): Error & { status: number } =>
  Object.assign(new Error(message), { status });

const file = (name: string, provider: string, extra: Partial<AuthFileItem> = {}): AuthFileItem =>
  ({ name, provider, ...extra }) as AuthFileItem;

describe('createConcurrencyLimiter', () => {
  test('caps in-flight tasks at the limit and drains the queue', async () => {
    const limit = 3;
    const limiter = createConcurrencyLimiter(limit);
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const tasks = Array.from({ length: 10 }, () =>
      limiter.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      })
    );

    await flushMicrotasks();
    expect(peak).toBe(limit);
    expect(releases).toHaveLength(limit);

    // Releasing a slot admits exactly one queued task.
    releases.shift()?.();
    await flushMicrotasks();
    expect(releases).toHaveLength(limit);

    while (releases.length > 0) {
      releases.shift()?.();
      await flushMicrotasks();
    }
    await Promise.all(tasks);

    expect(peak).toBeLessThanOrEqual(limit);
    expect(limiter.activeCount()).toBe(0);
  });

  test('never exceeds the limit across a batch of 200 requests', async () => {
    const limiter = createConcurrencyLimiter(QUOTA_BATCH_CONCURRENCY);
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 200 }, (_, index) =>
      limiter.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return index;
      })
    );

    const results = await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(QUOTA_BATCH_CONCURRENCY);
    expect(results).toHaveLength(200);
    expect(results[199]).toBe(199);
  });

  test('treats non-positive or invalid limits as a single slot', async () => {
    expect(createConcurrencyLimiter(0).activeCount()).toBe(0);
    const limiter = createConcurrencyLimiter(Number.NaN);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        limiter.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await Promise.resolve();
          active -= 1;
        })
      )
    );
    expect(peak).toBe(1);
  });
});

describe('buildQuotaRefreshJobs', () => {
  test('resolves the plugin per credential and drops ones with no channel or authIndex', () => {
    const index = new Map([['codex', 'plugin-codex']]);
    const jobs = buildQuotaRefreshJobs(index, [
      file('a.json', 'codex', { authIndex: 1 }),
      file('b.json', 'codex', { authIndex: 2 }),
      file('c.json', 'unknown-provider', { authIndex: 3 }),
      file('d.json', 'codex', { authIndex: '' }),
    ]);
    expect(jobs).toEqual([
      { pluginId: 'plugin-codex', authIndex: '1' },
      { pluginId: 'plugin-codex', authIndex: '2' },
    ]);
  });

  test('sends each plugin + authIndex at most once per refresh', () => {
    const index = new Map([['codex', 'plugin-codex']]);
    const jobs = buildQuotaRefreshJobs(index, [
      file('a.json', 'codex', { authIndex: 7 }),
      file('a-copy.json', 'codex', { authIndex: 7 }),
      file('b.json', 'codex', { authIndex: 8 }),
    ]);
    expect(jobs).toEqual([
      { pluginId: 'plugin-codex', authIndex: '7' },
      { pluginId: 'plugin-codex', authIndex: '8' },
    ]);
  });

  test('prefers the provider key over the type key', () => {
    const index = new Map([
      ['codex', 'plugin-codex'],
      ['openai', 'plugin-openai'],
    ]);
    const jobs = buildQuotaRefreshJobs(index, [
      file('a.json', 'codex', { type: 'openai', authIndex: 1 }),
    ]);
    expect(jobs).toEqual([{ pluginId: 'plugin-codex', authIndex: '1' }]);
  });
});

describe('quota retry policy', () => {
  test('treats only 429 and 503 as retryable', () => {
    expect(isRetryableQuotaStatus(429)).toBe(true);
    expect(isRetryableQuotaStatus(503)).toBe(true);
    expect(isRetryableQuotaStatus(500)).toBe(false);
    expect(isRetryableQuotaStatus(404)).toBe(false);
    expect(isRetryableQuotaStatus(undefined)).toBe(false);
  });

  test('backs off exponentially and caps the delay', () => {
    expect(quotaRetryDelayMs(1)).toBe(QUOTA_RETRY_BASE_DELAY_MS);
    expect(quotaRetryDelayMs(2)).toBe(QUOTA_RETRY_BASE_DELAY_MS * 2);
    expect(quotaRetryDelayMs(3)).toBe(QUOTA_RETRY_BASE_DELAY_MS * 4);
    expect(quotaRetryDelayMs(50)).toBe(QUOTA_RETRY_MAX_DELAY_MS);
  });
});

describe('withQuotaRetry', () => {
  test('retries a transient 503 and then succeeds', async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await withQuotaRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw statusError('busy', 503);
        return 'ok';
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
      }
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(delays).toEqual([QUOTA_RETRY_BASE_DELAY_MS, QUOTA_RETRY_BASE_DELAY_MS * 2]);
  });

  test('surfaces a non-transient error without retrying', async () => {
    let calls = 0;
    await expect(
      withQuotaRetry(
        async () => {
          calls += 1;
          throw statusError('nope', 500);
        },
        { sleep: async () => {} }
      )
    ).rejects.toThrow('nope');
    expect(calls).toBe(1);
  });

  test('stops after the attempt cap on a persistent 429', async () => {
    let calls = 0;
    await expect(
      withQuotaRetry(
        async () => {
          calls += 1;
          throw statusError('rate limited', 429);
        },
        { sleep: async () => {} }
      )
    ).rejects.toThrow('rate limited');
    expect(calls).toBe(QUOTA_RETRY_MAX_ATTEMPTS);
  });

  test('honours a custom attempt cap', async () => {
    let calls = 0;
    await expect(
      withQuotaRetry(
        async () => {
          calls += 1;
          throw statusError('rate limited', 429);
        },
        { maxAttempts: 2, sleep: async () => {} }
      )
    ).rejects.toThrow('rate limited');
    expect(calls).toBe(2);
  });
});

describe('QUOTA_BATCH_CONCURRENCY', () => {
  test('defaults to 6 concurrent requests', () => {
    expect(QUOTA_BATCH_CONCURRENCY).toBe(6);
  });
});
