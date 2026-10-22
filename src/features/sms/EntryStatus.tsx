/**
 * 列表条目下面的状态块：一行主数据下面那一块「这条东西现在什么样」。
 *
 * 渠道池与供应池共用它，所以它只说形状、不认识任何业务字段 —— 一格说什么由调用方
 * 决定。它由三样东西组成：
 *
 * - `EntryStatus`：一块浅底细边的面板，把状态和上面的主数据分开；
 * - `EntryStatusFact`：一个「标签在上、值在下」的事实，横向排开，放不下就换行；
 * - `EntryStatusGroup`：一条分割线 + 一个可选的小标题，用来放同一类的多条明细。
 *
 * 标签在上、值在下，而不是「标签在左、值在右」：这里的值是域名、账号、下拉框，
 * 长度差得很远，右对齐会让每一行的值起点都不一样，扫起来反而更慢。
 *
 * 面板本身不可点，所以它不跟着行悬停变色 —— 会亮的地方看起来就能点。
 */

import type { ReactNode } from 'react';
import styles from './EntryStatus.module.scss';

export type EntryStatusTone = 'plain' | 'good' | 'warn' | 'muted';

const TONE_CLASS: Record<EntryStatusTone, string> = {
  plain: styles.tonePlain,
  good: styles.toneGood,
  warn: styles.toneWarn,
  muted: styles.toneMuted,
};

export interface EntryStatusProps {
  children: ReactNode;
  className?: string;
}

export function EntryStatus({ children, className }: EntryStatusProps) {
  return <div className={[styles.panel, className].filter(Boolean).join(' ')}>{children}</div>;
}

export function EntryStatusFacts({ children }: { children: ReactNode }) {
  return <div className={styles.facts}>{children}</div>;
}

export interface EntryStatusFactProps {
  /** 这一格说的是什么（「入池」「平台余额」「更新时间」）。 */
  label: string;
  /** 值的语气；默认是正文色。 */
  tone?: EntryStatusTone;
  /** 值是机器标识（地址、账号、编号）时用等宽字体。 */
  mono?: boolean;
  /** 悬停补充（例如取不到这个值的原因）；没有就不挂。 */
  title?: string;
  children: ReactNode;
}

export function EntryStatusFact({
  label,
  tone = 'plain',
  mono = false,
  title,
  children,
}: EntryStatusFactProps) {
  const valueClass = [styles.factValue, TONE_CLASS[tone], mono ? styles.mono : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={styles.fact}>
      <span className={styles.factLabel}>{label}</span>
      <span className={valueClass} title={title}>
        {children}
      </span>
    </div>
  );
}

export interface EntryStatusGroupProps {
  /** 小标题；省略就只有一条分割线。 */
  label?: string;
  children: ReactNode;
}

export function EntryStatusGroup({ label, children }: EntryStatusGroupProps) {
  return (
    <div className={styles.group}>
      {label !== undefined && <span className={styles.groupLabel}>{label}</span>}
      {children}
    </div>
  );
}

export interface EntryStatusNoteProps {
  tone?: 'muted' | 'warn';
  /** 悬停补充；句子里已经说清原因时不要再挂一遍。 */
  title?: string;
  children: ReactNode;
}

/**
 * 一句解释：为什么这一格没有数字可说。
 *
 * 它和事实同处一块面板里，但不是一个「值」—— 给它配标签会造出一个新的字段名，
 * 而它本来只是一句话。
 */
export function EntryStatusNote({ tone = 'muted', title, children }: EntryStatusNoteProps) {
  const className = [styles.note, tone === 'warn' ? styles.toneWarn : styles.toneMuted].join(' ');
  return (
    <div className={className} title={title}>
      {children}
    </div>
  );
}
