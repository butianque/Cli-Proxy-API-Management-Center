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