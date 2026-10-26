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

/** 结果原样展示：动作返回什么就显示什么，面板不替它挑字段。 */
export function formatResultJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}