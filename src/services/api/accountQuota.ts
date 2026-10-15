/**
 * 账号额度通道：宿主插件 ABI。
 *
 * 宿主的额度快照只能由插件额度通道写入（`POST /v8/management/plugins/{id}/quota`）。
 * 面板不直接探测上游，也不另存一份额度——刷新后重读 `GET /v8/management/accounts`
 * 即可见。
 */

import type { PluginListEntry } from '@/types';
import { pluginsApi } from './plugins';

/** provider 键（小写）→ 提供额度的插件 id。 */
export type QuotaPluginIndex = Map<string, string>;

/**
 * 由插件清单构建索引。只有同时声明了额度能力与 provider 键的插件才入选；
 * 键冲突时后者覆盖前者——宿主对同一个 provider 也只解析到一个插件。
 */
export function buildQuotaPluginIndex(plugins: readonly PluginListEntry[]): QuotaPluginIndex {
  const index: QuotaPluginIndex = new Map();
  for (const plugin of plugins) {
    if (!plugin.supportsQuota) continue;
    const key = plugin.quotaProvider?.trim().toLowerCase();
    if (!key) continue;
    index.set(key, plugin.id);
  }
  return index;
}

/** 按候选 provider 键查插件 id。候选全不命中即该账号没有额度通道。 */
export function findQuotaPluginId(
  index: ReadonlyMap<string, string>,
  candidates: readonly string[]
): string | undefined {
  for (const candidate of candidates) {
    const id = index.get(candidate.trim().toLowerCase());
    if (id) return id;
  }
  return undefined;
}

/** 拉取插件清单并建索引。宿主不可用时抛错，由调用方决定是否保留上次结果。 */
export async function loadQuotaPluginIndex(): Promise<QuotaPluginIndex> {
  const list = await pluginsApi.list();
  return buildQuotaPluginIndex(list.plugins);
}
