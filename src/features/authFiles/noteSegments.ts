/**
 * 卡片备注的分段。备注由插件写成，全角竖线是它自己的分段符：第一段是账号身份
 * （`Global · aogna`），后面各段是紧随其后的读数（额度窗口、累计请求）。
 *
 * 面板按它拆行显示，避免把六七件事挤进同一行；拆不出分段时原样返回一条，
 * 调用方的渲染路径不需要区分这两种情况。
 */

/** 插件在备注里使用的分段符（全角竖线，不是半角 `|`）。 */
const NOTE_SEGMENT_SEPARATOR = '｜';

/**
 * @param note 插件写入的备注原文
 * @param limit 最多返回几条；超出的段只保留在悬停全文里，不在卡片上继续加高
 */
export const splitNoteSegments = (note: string, limit = 3): string[] => {
  const trimmed = note.trim();
  if (!trimmed) return [];
  const segments = trimmed
    .split(NOTE_SEGMENT_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
  return segments.slice(0, limit);
};
