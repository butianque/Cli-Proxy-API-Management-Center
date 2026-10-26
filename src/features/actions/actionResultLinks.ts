/**
 * 结果里的可点链接。
 *
 * 有些动作的产出就是「一个地址」（例如邀请链接），而结果本体是任意形状的 JSON。
 * 页面不去认字段名，只把结果里形如 http(s) 地址的字符串收上来，交给操作者自己
 * 点开 —— 不自动跳转，也不猜测哪个字段才是「主链接」。
 */

import { isRecord } from '@/utils/helpers';

/** 一次最多列这么多：结果里出现更多地址时，说明该看原样 JSON。 */
const MAX_LINKS = 5;

/** 结果可能是深层结构，只看前几层就够，也避免异常深的响应拖住渲染。 */
const MAX_DEPTH = 4;

const LINK_PATTERN = /^https?:\/\/[^\s]+$/i;

/**
 * 结果里的两个当事人。
 *
 * 一条流水线常常先得说清「对谁做」：谁邀请、谁被邀请。这类结果可以带
 * `pair`，页面把两行「称呼 + 账号」和一句提示显示在步骤上方 —— 操作者拿它去
 * 核对浏览器里登录的到底是哪个号，而不是从 JSON 里自己找。
 *
 * 只认形状不认业务：没有 `pair`、或者条目缺称呼/值，就当没有。
 */
export interface ResultPairItem {
  label: string;
  value: string;
}

export interface ResultPair {
  items: ResultPairItem[];
  /** 提示句：为什么这两行必须和浏览器里的账号对得上。 */
  hint?: string;
}

/** 一次最多列这么多：再多就不是「两个当事人」了。 */
const MAX_PAIR_ITEMS = 4;

export function collectResultPair(value: unknown): ResultPair | undefined {
  if (!isRecord(value) || !isRecord(value.pair)) return undefined;
  const rawItems = value.pair.items;
  if (!Array.isArray(rawItems)) return undefined;

  const items: ResultPairItem[] = [];
  for (const item of rawItems) {
    if (items.length >= MAX_PAIR_ITEMS) break;
    if (!isRecord(item)) continue;
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const text = typeof item.value === 'string' ? item.value.trim() : '';
    if (!label || !text) continue;
    items.push({ label, value: text });
  }
  if (items.length === 0) return undefined;

  const hint = typeof value.pair.hint === 'string' ? value.pair.hint.trim() : '';
  return { items, hint: hint || undefined };
}

/**
 * 结果要不要自己刷新。
 *
 * 有些步骤的完成不在本页面里：操作者要去浏览器登录、接受邀请，回来时结果已经
 * 变了。这类结果可以带 `poll`，页面按给定间隔重跑同一个动作、原地更新结果 ——
 * 不做跳转，也不自己判断「算不算完成」，那仍然由动作回答。
 *
 * `poll` 只在还需要等的时候出现，所以结果不再带它，轮询就自然停下。
 */
export interface ResultPoll {
  key: string;
  params: Record<string, unknown>;
  intervalMs: number;
}

/** 最快 5 秒一次：再快就是替后端刷接口，读者也跟不上。 */
const MIN_POLL_MS = 5_000;

/** 最慢 2 分钟一次：更慢的话「自动进入下一步」就不成立了。 */
const MAX_POLL_MS = 120_000;

const DEFAULT_POLL_MS = 15_000;

export function collectResultPoll(value: unknown): ResultPoll | undefined {
  if (!isRecord(value) || !isRecord(value.poll)) return undefined;
  const key = typeof value.poll.key === 'string' ? value.poll.key.trim() : '';
  const params = value.poll.params;
  if (!key || !isRecord(params)) return undefined;
  const raw = typeof value.poll.interval_ms === 'number' ? value.poll.interval_ms : 0;
  const intervalMs = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, raw || DEFAULT_POLL_MS));
  return { key, params, intervalMs };
}

export function collectResultLinks(value: unknown): string[] {
  const links: string[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown, depth: number) => {
    if (depth > MAX_DEPTH || links.length >= MAX_LINKS) return;
    if (typeof node === 'string') {
      const text = node.trim();
      if (!LINK_PATTERN.test(text) || seen.has(text)) return;
      seen.add(text);
      links.push(text);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (isRecord(node)) {
      for (const item of Object.values(node)) walk(item, depth + 1);
    }
  };

  walk(value, 0);
  return links;
}

/** 一次最多列这么多候选：再多就该看原样 JSON 了。 */
const MAX_CHOICES = 8;

/** 结果里的一条「下一步」：点了就用这些参数重跑同一个动作。 */
export interface ResultChoice {
  label: string;
  hint?: string;
  params: Record<string, unknown>;
}

/**
 * 结果里的下一步动作。
 *
 * 有些动作需要先知道「对哪个账号做」才能继续（例如池里有多个候选）。这类结果
 * 可以带 `choices`，每条给出一个可读的名字和一组现成参数；页面把它们渲染成按钮，
 * 点一下就用该参数重跑同一个动作 —— 操作者不必去别处抄一个 id 再回来粘贴。
 *
 * 只认形状不认业务：没有 `choices`、或者条目缺名字/参数，就当没有。
 */
export function collectResultChoices(value: unknown): ResultChoice[] {
  if (!isRecord(value) || !Array.isArray(value.choices)) return [];
  const choices: ResultChoice[] = [];
  for (const item of value.choices) {
    if (choices.length >= MAX_CHOICES) break;
    if (!isRecord(item) || typeof item.label !== 'string' || !isRecord(item.params)) continue;
    const label = item.label.trim();
    if (!label) continue;
    choices.push({
      label,
      hint: typeof item.hint === 'string' && item.hint.trim() ? item.hint.trim() : undefined,
      params: item.params,
    });
  }
  return choices;
}

/** 一次最多列这么多说明：再多就该看原样 JSON 了。 */
const MAX_NOTES = 4;

/**
 * 结果里的说明句。
 *
 * 有些结果把「这个链接对谁有效、做完回哪里点」写成几条句子（`notes`）。这些句子
 * 没有字段名可认，页面照顺序显示；重复的只留一条。步骤已经带着同样的说明时不再
 * 重复列出。
 */
export function collectResultNotes(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.notes)) return [];
  const notes: string[] = [];
  for (const item of value.notes) {
    if (notes.length >= MAX_NOTES) break;
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || notes.includes(text)) continue;
    notes.push(text);
  }
  return notes;
}

/** 一次最多列这么多步：再多就该看原样 JSON 了。 */
const MAX_STEPS = 6;

/** 一步的状态：已完成 / 待做 / 被前一步挡住。 */
export type ResultStepState = 'done' | 'todo' | 'blocked';

/** 一步自带的下一个动作：点了就用这些参数重跑它点名的动作。 */
export interface ResultStepAction {
  key: string;
  label: string;
  params: Record<string, unknown>;
}

/** 结果里的一步：状态、说明、可复制的链接、以及下一步。 */
export interface ResultStep {
  key: string;
  index: number;
  title: string;
  state: ResultStepState;
  detail?: string;
  link?: string;
  action?: ResultStepAction;
}

/**
 * 结果里的执行步骤。
 *
 * 有些动作本身是一条流水线（绑定 → 发消息 → 客户端登录）。这类结果可以带
 * `steps`，每一步给出序号、标题、状态、说明、该打开的链接和下一步动作；页面照
 * 顺序渲染成清单，状态用徽标区分 —— 操作者一眼看到「现在在哪一步、下一步做什么」。
 *
 * 只认形状不认业务：没有 `steps`、或者条目缺 key/标题，就当没有。
 */
export function collectResultSteps(value: unknown): ResultStep[] {
  if (!isRecord(value) || !Array.isArray(value.steps)) return [];
  const steps: ResultStep[] = [];
  for (const item of value.steps) {
    if (steps.length >= MAX_STEPS) break;
    if (!isRecord(item)) continue;
    if (typeof item.key !== 'string' || !item.key.trim()) continue;
    if (typeof item.title !== 'string' || !item.title.trim()) continue;
    const state: ResultStepState =
      item.state === 'done' || item.state === 'blocked' ? item.state : 'todo';
    const rawIndex = typeof item.index === 'number' ? item.index : steps.length + 1;
    let action: ResultStepAction | undefined;
    if (isRecord(item.action) && typeof item.action.key === 'string' && isRecord(item.action.params)) {
      action = {
        key: item.action.key,
        label:
          typeof item.action.label === 'string' && item.action.label.trim()
            ? item.action.label.trim()
            : item.action.key,
        params: item.action.params,
      };
    }
    steps.push({
      key: item.key,
      index: Number.isFinite(rawIndex) ? rawIndex : steps.length + 1,
      title: item.title.trim(),
      state,
      detail: typeof item.detail === 'string' && item.detail.trim() ? item.detail.trim() : undefined,
      link: typeof item.link === 'string' && LINK_PATTERN.test(item.link.trim()) ? item.link.trim() : undefined,
      action,
    });
  }
  return steps.sort((left, right) => left.index - right.index);
}

/** 结果原样展示：动作返回什么就显示什么，面板不替它挑字段。 */
export function formatResultJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}