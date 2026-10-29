import type {
  HTMLAttributes,
  PropsWithChildren,
  ReactNode,
  Ref,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
  UIEventHandler,
} from 'react';
import styles from './Table.module.scss';

interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  className?: string;
  cols?: ReactNode;
  /**
   * 纵向滚动的高度上限。设了之后表头固定在顶端，只有行在下面滚。
   *
   * 长表用它是为了「页面不动」：整页跟着行数长的时候，页头和页面上的动作会被推到
   * 视野外，翻到一半想点上面的按钮就得先滚回去。
   */
  maxHeight?: string;
  /** 真正滚动的那一层的 ref：窗口化渲染要读它的 `scrollTop` 与高度。 */
  scrollRef?: Ref<HTMLDivElement>;
  /** 同上，滚动回调。 */
  onBodyScroll?: UIEventHandler<HTMLDivElement>;
}

export function Table({
  children,
  cols,
  className,
  maxHeight,
  scrollRef,
  onBodyScroll,
  ...rest
}: PropsWithChildren<TableProps>) {
  const tableCls = [styles.table, className].filter(Boolean).join(' ');
  const scrollCls = [styles.scroll, maxHeight ? styles.scrollBody : null].filter(Boolean).join(' ');
  return (
    <div className={styles.wrap}>
      <div
        ref={scrollRef}
        onScroll={onBodyScroll}
        className={scrollCls}
        style={maxHeight ? { maxHeight } : undefined}
      >
        <table className={tableCls} {...rest}>
          {cols ? <colgroup>{cols}</colgroup> : null}
          {children}
        </table>
      </div>
    </div>
  );
}

/**
 * 一行只为撑高度。
 *
 * 窗口化渲染时，没进视口的条目不会渲染，但它们仍占着滚动条上的位置 —— 不占住的话
 * 滚动条会随着「现在渲染了哪几条」忽长忽短，人一拖就落到别处。
 */
export function TableSpacer({ height, colSpan }: { height: number; colSpan: number }) {
  if (height <= 0) return null;
  return (
    <tbody className={styles.spacer} aria-hidden="true">
      <tr>
        <td colSpan={colSpan} style={{ height }} />
      </tr>
    </tbody>
  );
}

export function TableHeader({
  children,
  className,
  ...rest
}: PropsWithChildren<HTMLAttributes<HTMLTableSectionElement>>) {
  return (
    <thead className={[styles.head, className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </thead>
  );
}

export function TableBody({
  children,
  className,
  ...rest
}: PropsWithChildren<HTMLAttributes<HTMLTableSectionElement>>) {
  return (
    <tbody className={[styles.body, className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </tbody>
  );
}

/**
 * 一组行属于同一个条目。
 *
 * 一个条目有时要拆成两行：主数据一行，它下面那条状态带一行。拆开之后悬停只变暗
 * 上面一行，下半截就看起来不属于它 —— 一条记录读成了两条。把这两行放进同一个
 * `<tbody>`，悬停由这一组自己决定：鼠标落在哪一行，整条一起变暗。
 */
export function TableRowGroup({
  children,
  className,
  ...rest
}: PropsWithChildren<HTMLAttributes<HTMLTableSectionElement>>) {
  return (
    <tbody className={[styles.body, styles.group, className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </tbody>
  );
}

interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  selected?: boolean;
}

export function TableRow({
  children,
  className,
  selected,
  ...rest
}: PropsWithChildren<TableRowProps>) {
  const cls = [styles.row, selected ? styles.selected : null, className].filter(Boolean).join(' ');
  return (
    <tr className={cls} {...rest}>
      {children}
    </tr>
  );
}

interface TableHeadProps extends ThHTMLAttributes<HTMLTableCellElement> {
  alignRight?: boolean;
}

export function TableHead({
  children,
  className,
  alignRight,
  ...rest
}: PropsWithChildren<TableHeadProps>) {
  const cls = [alignRight ? styles.alignRight : null, className].filter(Boolean).join(' ');
  return (
    <th className={cls || undefined} {...rest}>
      {children}
    </th>
  );
}

interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  alignRight?: boolean;
}

export function TableCell({
  children,
  className,
  alignRight,
  ...rest
}: PropsWithChildren<TableCellProps>) {
  const cls = [alignRight ? styles.alignRight : null, className].filter(Boolean).join(' ');
  return (
    <td className={cls || undefined} {...rest}>
      {children}
    </td>
  );
}
