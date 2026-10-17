/**
 * 渠道池里每条渠道**自己**的状态：这个邮箱收到了什么、这个平台的余额还剩多少。
 *
 * 一次读全，不逐行读。基座对每个信箱只连一次，逐行去读等于把同一个信箱连 N 次；
 * N 只是渠道数，页面不该为显示 N 行付 N 次握手的代价。
 *
 * 读的顺序是先状态后内容：状态回答「配没配好、能不能读」，内容回答「读到了什么」。
 * 前者失败时不该把后者渲染成「没有信」—— 那会让人去翻一个根本没被打开过的信箱。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { emailApi } from '@/services/api/email';
import { smsApi } from '@/services/api/sms';
import { useSecretGateStore } from '@/stores/useSecretGateStore';
import { toInboxReading, toInboxStatus } from './emailMapping';
import { toStatus } from './smsMapping';
import type { ChannelStatus, EmailInboxReading, SupplyChannel, SupplyKind } from './types';

/** 读多少封：够判定「有没有新信」，又不至于把整个信箱拉一遍。 */
const INBOX_PAGE = 20;

export function useChannelStatus(
  kind: SupplyKind,
  channels: SupplyChannel[],
  reloadKey: number
): Map<string, ChannelStatus> {
  const { t } = useTranslation();
  const gatePhase = useSecretGateStore((state) => state.phase);
  // 渠道名里要用「号段」这个词，由页面把本地化写法交给映射层（映射层保持纯函数）。
  const prefixLabel = t('sms_service.channel_prefix');
  const unknown = t('sms_service.row_status_error_unknown');
  const [statuses, setStatuses] = useState<Map<string, ChannelStatus>>(() => new Map());

  useEffect(() => {
    if (channels.length === 0) {
      setStatuses(new Map());
      return;
    }
    let alive = true;
    setStatuses(new Map(channels.map((channel) => [channel.id, { kind: 'loading' }])));
    void (async () => {
      const next =
        kind === 'email'
          ? await readEmail(channels, unknown)
          : await readPhone(channels, prefixLabel);
      if (alive) setStatuses(next);
    })();
    return () => {
      alive = false;
    };
    // 上锁 / 解锁会改变基座能报什么：授权码读不到时，信也就读不到。
  }, [channels, kind, prefixLabel, unknown, reloadKey, gatePhase]);

  return statuses;
}

/** 邮箱这一类：先看配没配好，再看每个信箱收到了什么。 */
async function readEmail(
  channels: SupplyChannel[],
  unknown: string
): Promise<Map<string, ChannelStatus>> {
  const next = new Map<string, ChannelStatus>();
  /** 一个状态铺满全表，但**关掉的那一类**仍然显示「已停用」—— 那是它真实的状态。 */
  const fill = (status: ChannelStatus) => {
    for (const channel of channels) {
      next.set(channel.id, channel.email?.enabled ? status : { kind: 'disabled' });
    }
    return next;
  };

  let status;
  try {
    status = toInboxStatus(await emailApi.getStatus());
  } catch (error) {
    return fill({ kind: 'error', message: emailApi.describeError(error, unknown) });
  }
  if (status.locked) return fill({ kind: 'locked' });
  if (!status.configured) return fill({ kind: 'unready' });

  const byId = new Map(status.mailboxes.map((box) => [box.channelId, box]));
  let reading: EmailInboxReading | null = null;
  let readError = '';
  try {
    reading = toInboxReading(await emailApi.getInbox({ limit: INBOX_PAGE }));
  } catch (error) {
    // 「还没有可读的邮箱」不是错误，是还没开始用。
    if (emailApi.isUnavailable(error)) return fill({ kind: 'unready' });
    readError = emailApi.describeError(error, unknown);
  }

  for (const channel of channels) {
    const block = channel.email;
    if (!block?.enabled) {
      next.set(channel.id, { kind: 'disabled' });
      continue;
    }
    const box = byId.get(channel.id);
    if (box && !box.hasCredential) {
      next.set(channel.id, { kind: 'unready' });
      continue;
    }
    if (readError) {
      next.set(channel.id, { kind: 'error', message: readError });
      continue;
    }
    const summary = reading?.mailboxes.find((item) => item.channelId === channel.id);
    // 没有这一条的小结 = 基座没有把它当成可读信箱（账号或服务器没填全）。
    if (!summary) {
      next.set(channel.id, { kind: 'unready' });
      continue;
    }
    if (summary.error) {
      next.set(channel.id, { kind: 'error', message: summary.error });
      continue;
    }
    next.set(channel.id, {
      kind: 'email',
      mailbox: summary.mailbox || box?.mailbox || '',
      domain: summary.domain || box?.domain || '',
      count: summary.count,
      windowHours: reading?.windowHours ?? 0,
      latest: summary.latest,
    });
  }
  return next;
}

/**
 * 手机号这一类：余额与取号数都是**平台级**的。
 *
 * 这不是偷懒 —— 号码池里那条记录带的是**平台自己的渠道 uid**（`21614-a` 这种），
 * 不是这里的渠道 id（`haozhuma`）；按渠道 id 去数永远数出 0，那是编数据。手机号这一
 * 类只有**一份**平台凭据，所以平台读数对每条渠道都是同一组事实，文案里明说是平台的。
 */
async function readPhone(
  channels: SupplyChannel[],
  prefixLabel: string
): Promise<Map<string, ChannelStatus>> {
  const next = new Map<string, ChannelStatus>();
  const fill = (status: ChannelStatus) => {
    for (const channel of channels) {
      next.set(channel.id, channel.phone?.enabled ? status : { kind: 'disabled' });
    }
    return next;
  };

  let view;
  try {
    view = toStatus(await smsApi.getStatus(), prefixLabel);
  } catch (error) {
    return fill({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (view.storeLocked) return fill({ kind: 'locked' });
  if (!view.enabled) return fill({ kind: 'unready' });

  const times = view.ledger
    .map((entry) => entry.takenAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  for (const channel of channels) {
    if (!channel.phone?.enabled) {
      next.set(channel.id, { kind: 'disabled' });
      continue;
    }
    next.set(channel.id, {
      kind: 'phone',
      balanceCny: view.balanceCny,
      // 余额读不到时把原因留着：页面只说「读不到」，悬停才看到为什么。
      balanceError: view.balanceCny === null ? (view.connectionReason ?? '') : '',
      taken: view.ledger.length,
      latestAt: times.length > 0 ? times[times.length - 1] : null,
    });
  }
  return next;
}
