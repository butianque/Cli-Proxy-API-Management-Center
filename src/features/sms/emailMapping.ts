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
import type { SupplyLedgerWire } from '@/services/api/supply';
import { formatInstantShort } from '@/utils/quota/relativeTime';
import type { EmailInboxReading, EmailMailbox, EmailMessage } from './types';

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
    links: Array.isArray(item.links) ? item.links.map(text).filter((value) => value !== '') : [],
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

/**
 * 一个邮箱这次读到了什么。
 *
 * 三栏里「中间那栏」就是它：这个邮箱的信，以及它最新一封的时间（侧边栏按这个时间
 * 排序）。读不到时 `error` 非空、`messages` 为空 —— 两者必须分得开，否则「没打开过」
 * 会被画成「没有信」。
 */
export interface EmailMailboxReading {
  messages: EmailMessage[];
  /** 最新一封信的时间；`null` = 没有信，或后端没拿到日期。 */
  latestAt: string | null;
  /** 读不到的原因；`''` = 读到了。 */
  error: string;
}

/** 单个邮箱的归一。一次只查一个地址，所以 `mailboxes` 里那一行就是它的答案。 */
export function toMailboxReading(result: EmailInboxResponse | undefined): EmailMailboxReading {
  const messages = toMessages(result?.messages);
  const box = Array.isArray(result?.mailboxes) ? result.mailboxes[0] : undefined;
  const latest = box?.latest ? (toMessages([box.latest])[0] ?? null) : null;
  return {
    messages,
    latestAt: latest?.receivedAt ?? messages[0]?.receivedAt ?? null,
    error: text(box?.error),
  };
}

/** 侧边栏一行读到哪儿了。`reading === null` = 还没读过。 */
export interface EmailMailboxSlot {
  loading: boolean;
  reading: EmailMailboxReading | null;
}

/**
 * 侧边栏顺序：有信的按最新来信倒序在前，读到但没信的居中，其余垫底。
 *
 * 「其余」包含还没读、正在读、读取失败三种 —— 它们都是**不知道**，而不知道的邮箱不能
 * 混进「最新的在上面」里冒充已知。这一档保留池子顺序，让用户点过的那几个不会因为一次
 * 重排跳走。
 */
export function orderMailboxAddresses(
  addresses: string[],
  slots: Record<string, EmailMailboxSlot>
): string[] {
  const withMail: string[] = [];
  const readEmpty: string[] = [];
  const unknown: string[] = [];
  for (const address of addresses) {
    const reading = slots[address]?.reading ?? null;
    if (reading === null) {
      unknown.push(address);
      continue;
    }
    if (reading.latestAt !== null) {
      withMail.push(address);
      continue;
    }
    // 一次失败但一个字都没读到，才是「不知道」。已知有信、只是这次没刷新成功的不沉底。
    (reading.error === '' ? readEmpty : unknown).push(address);
  }
  const latestMs = new Map<string, number>();
  for (const address of withMail) {
    const latest = slots[address]?.reading?.latestAt;
    const ms = latest ? new Date(latest).getTime() : 0;
    latestMs.set(address, Number.isNaN(ms) ? 0 : ms);
  }
  withMail.sort((left, right) => (latestMs.get(right) ?? 0) - (latestMs.get(left) ?? 0));
  return [...withMail, ...readEmpty, ...unknown];
}

/**
 * 默认选中哪个邮箱：最新来信的那个；都没有信时退回第一个读到的空邮箱。
 *
 * 一个都没读到时给 `''` —— 此时还没有任何真实答案可选，先让人看到「未读取」，而不是
 * 随手挑一个空的顶上。
 */
export function pickDefaultMailbox(
  addresses: string[],
  slots: Record<string, EmailMailboxSlot>
): string {
  const ordered = orderMailboxAddresses(addresses, slots);
  for (const address of ordered) {
    if ((slots[address]?.reading?.latestAt ?? null) !== null) return address;
  }
  for (const address of ordered) {
    const reading = slots[address]?.reading ?? null;
    if (reading !== null && reading.error === '') return address;
  }
  return '';
}

/**
 * 一封信在右栏里作为 JSON 展示的内容。
 *
 * 基座在 HTTP 上只给元数据与 240 字节摘录（全文只走插件通道），所以这里就是**全部拿
 * 得到的**字段，不多不少。键名用页面自己的写法 —— 后端字段名留在本文件里。
 */
export interface EmailMessageDocument {
  /** 在哪个池内邮箱收到的。 */
  receivedBy: string;
  /** 它在邮箱里的哪个文件夹（INBOX / 垃圾邮件）。 */
  folder: string;
  from: string;
  to: string[];
  subject: string;
  receivedAt: string | null;
  code: string;
  preview: string;
  links: string[];
}

export function toMessageDocument(address: string, mail: EmailMessage): EmailMessageDocument {
  return {
    receivedBy: address,
    folder: mail.mailbox,
    from: mail.from,
    to: mail.to,
    subject: mail.subject,
    receivedAt: mail.receivedAt,
    code: mail.code,
    preview: mail.preview,
    links: mail.links,
  };
}

/**
 * 供应池里**能读信**的邮箱地址。
 *
 * 只有自带读信配置的身份才有 `mailbox` 块：渠道发出来的地址靠渠道那条连接读，不在这里
 * 列 —— 列了也读不到，只会让人以为池子里有一批打不开的信箱。
 */
export function toPoolAddresses(records: SupplyLedgerWire[] | undefined): string[] {
  if (!Array.isArray(records)) return [];
  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const record of records) {
    const address = text(record.address);
    if (address === '' || record.mailbox == null) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(address);
  }
  return addresses;
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
