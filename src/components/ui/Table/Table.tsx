import type {
  HTMLAttributes,
  PropsWithChildren,
  ReactNode,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';
import styles from './Table.module.scss';

interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  className?: string;
  cols?: ReactNode;
}

export function Table({ children, cols, className, ...rest }: PropsWithChildren<TableProps>) {
  const tableCls = [styles.table, className].filter(Boolean).join(' ');
  return (
    <div className={styles.wrap}>
      <div className={styles.scroll}>
        <table className={tableCls} {...rest}>
          {cols ? <colgroup>{cols}</colgroup> : null}
          {children}
        </table>
      </div>
    </div>
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
