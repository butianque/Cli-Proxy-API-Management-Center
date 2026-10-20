/**
 * 代理池的一份共享读取。
 *
 * 池被四个地方同时看着：网络配置里的池卡片，以及账号池、渠道池、供应出口三处
 * 下拉框。每处各拉一次会得到四个互相矛盾的快照（刚绑完的那一处显示已绑，
 * 另外三处还显示未绑），所以只留一份状态，谁改完谁喊一声重新读。
 *
 * 状态里带 `unsupported`：旧版服务端没有这组接口，那不是错误，是「这版还没有」，
 * 面板要显示空态与下一步，而不是一条红色报错。
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  EgressPoolUnsupportedError,
  egressPoolApi,
  type EgressPoolEntry,
} from '@/services/api/egressPool';

export type EgressPoolStatus = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

export interface EgressPoolSnapshot {
  status: EgressPoolStatus;
  entries: EgressPoolEntry[];
  /** 上次读取失败的原因；成功时为空。 */
  error: string;
}

const EMPTY: EgressPoolSnapshot = { status: 'idle', entries: [], error: '' };

let snapshot: EgressPoolSnapshot = EMPTY;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: EgressPoolSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): EgressPoolSnapshot {
  return snapshot;
}

/**
 * 读一次池。已经在读就复用那次请求：卡片与下拉框同时挂载时只发一次。
 */
export function loadEgressPool(): Promise<void> {
  if (inflight) return inflight;
  if (snapshot.status !== 'ready') {
    publish({ status: 'loading', entries: snapshot.entries, error: '' });
  }
  inflight = egressPoolApi
    .list()
    .then((entries) => {
      publish({ status: 'ready', entries, error: '' });
    })
    .catch((error: unknown) => {
      if (error instanceof EgressPoolUnsupportedError) {
        publish({ status: 'unsupported', entries: [], error: '' });
        return;
      }
      publish({
        status: 'error',
        entries: [],
        error: error instanceof Error && error.message ? error.message : '',
      });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 丢掉手上的快照，下次读取重新开始（切换连接、登出时用）。 */
export function resetEgressPool(): void {
  inflight = null;
  publish(EMPTY);
}

/**
 * 订阅池。
 *
 * 首次挂载时自动读一次；`status === 'idle'` 之外不重复读，所以十个组件挂载
 * 也只发一次请求。
 */
export function useEgressPool(): EgressPoolSnapshot & { reload: () => Promise<void> } {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (snapshot.status === 'idle') void loadEgressPool();
  }, []);

  const reload = useCallback(() => loadEgressPool(), []);
  return { ...state, reload };
}
