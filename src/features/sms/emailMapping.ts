/**
 * 邮箱类别：把后端字段归一成页面类型。
 *
 * 后端字段名**只出现在这里**（与 `smsMapping.ts` 同一约定）：组件拿到的永远是
 * `EmailMailbox` / `EmailMessage`，看不到 `received_at` 这类写法。
 */

import type {
  EmailMailboxWire,
  EmailInboxResponse,
  EmailMessageWire,
  EmailStatusResponse,
} from '@/services/api/email';
import { formatInstantShort } from '@/utils/quota/relativeTime';
import type { EmailInboxReading, EmailInboxSummary, EmailMailbox, EmailMessage } from './types';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 用途归一：后端只认 personal / self-domain，其余一律按个人邮箱显示。 */
function toUsage(value: unknown): EmailMailbox['usage'] {
  return text(value) === 'self-domain' ? 'self-domain' : 'personal';
}

export function toMailboxes(list: EmailMailboxWire[] | undefined): EmailMailbox[] {
  if (!Array.isArray(list)) return [];
  return list.map((item) => ({
    channelId: text(item.channel_id),
    label: text(item.label),
    mailbox: text(item.mailbox),
    host: text(item.host),
    domain: text(item.domain),
    usage: toUsage(item.usage),
    secretName: text(item.secret_name),
    hasCredential: item.has_credential === true,
  }));
}

/**
 * 时间归一。
 *
 * 后端给的是 RFC3339；解析不了就返回 `null` —— 页面据此不显示时间，而不是拿
 * 当前时刻冒充收信时刻。
 */
export function toReceivedAt(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

export function toMessages(list: EmailMessageWire[] | undefined): EmailMessage[] {
  if (!Array.isArray(list)) return [];
  return list.map((item) => ({
    channelId: text(item.channel_id),
    mailbox: text(item.mailbox),
    from: text(item.from),
    to: Array.isArray(item.to) ? item.to.map(text).filter((value) => value !== '') : [],
    subject: text(item.subject),
    receivedAt: toReceivedAt(item.received_at),
    code: text(item.code),
    preview: text(item.preview),
  }));
}

/** 收信时间的一句话写法；`null` 给空串，由调用方决定不渲染。 */
export function formatReceivedAt(iso: string | null): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  return formatInstantShort(ms);
}

/**
 * 一次收件箱读取归一：**每条渠道各自**读到了什么。
 *
 * 页面不再把多个信箱合成一个「收件箱」—— 一条渠道的信要归到它自己身上，否则
 * 「有两封信」到底是哪个邮箱的，只能靠人去猜。
 */
export function toInboxReading(result: EmailInboxResponse | undefined): EmailInboxReading {
  const hours = Number(result?.window_hours);
  const mailboxes = Array.isArray(result?.mailboxes)
    ? result.mailboxes.map((item) => ({
        channelId: text(item.channel_id),
        label: text(item.label),
        mailbox: text(item.mailbox),
        domain: text(item.domain),
        count: typeof item.count === 'number' && Number.isFinite(item.count) ? item.count : 0,
        latest: item.latest ? (toMessages([item.latest])[0] ?? null) : null,
        error: text(item.error),
      }))
    : [];
  return {
    mailboxes,
    // 后端没说窗口多长就报 0：页面据此只说「N 封」，不替它假设「近三天」。
    windowHours: Number.isFinite(hours) && hours > 0 ? hours : 0,
  };
}

/** 一次聚合收件箱读取：所有信箱最近的来信，以及这次没读到的信箱。 */
export interface EmailInboxView {
  /** 至少有一个可读的邮箱；`false` = 还没有可读的邮箱，按空态处理而不是错误。 */
  enabled: boolean;
  windowHours: number;
  /** 后端已按最新在前排好；页面不再重排。 */
  messages: EmailMessage[];
  /** 这次没读到的信箱（`error` 非空）。空数组 = 全都读到了。 */
  unread: EmailInboxSummary[];
}

/**
 * 聚合收件箱归一。
 *
 * 读不到的邮箱单独拿出来，而不是并进消息列表：把「没读到」渲染成「没有信」，会让人
 * 去翻一个根本没被打开过的信箱。`enabled: false` 与空邮箱是同一件事（还没开始用），
 * 由页面给出空态与下一步，而不是显示内部原因。
 */
export function toInboxView(result: EmailInboxResponse | undefined): EmailInboxView {
  const reading = toInboxReading(result);
  return {
    enabled: result?.enabled !== false,
    windowHours: reading.windowHours,
    messages: toMessages(result?.messages),
    unread: reading.mailboxes.filter((item) => item.error !== ''),
  };
}

/** 状态接口归一。 */
export function toInboxStatus(status: EmailStatusResponse | undefined): {
  configured: boolean;
  locked: boolean;
  mailboxes: EmailMailbox[];
} {
  const mailboxes = toMailboxes(status?.channels);
  return {
    configured: status?.enabled === true,
    locked: status?.locked === true,
    mailboxes,
  };
}
