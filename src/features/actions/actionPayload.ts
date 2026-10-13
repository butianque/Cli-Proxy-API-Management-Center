/**
 * 动作入参整理 —— 从表单值得到发给基座的 JSON。
 *
 * 规则：空值不发送。动作方（插件）把「没填」当作「全部 / 默认」，因此把空串
 * 发过去会让它当成一个真实的空账号名，语义就错了。布尔参数只在为真时发送，
 * 缺席即「否」。
 */

import type { PluginAction } from '@/services/api/actions';

/** 表单里一个参数的值：文本，或布尔开关。 */
export type ActionFormValue = string | boolean;

export function buildActionPayload(
  action: PluginAction,
  values: Record<string, ActionFormValue>
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const param of action.params) {
    const value = values[param.name];
    if (typeof value === 'boolean') {
      if (value) payload[param.name] = true;
      continue;
    }
    const text = (value ?? '').trim();
    if (text) payload[param.name] = text;
  }
  return payload;
}
