/**
 * 分页条：一张长表底部的「现在在哪一段 + 怎么翻」。
 *
 * 只在真的不止一页时出现。只有一页时摆一条页码栏是噪音 —— 它除了说明「你不需要
 * 翻页」什么也没做。
 *
 * 页码窗口固定露头露尾（第一页、最后一页）并跟着当前页走，中间跳过的用省略号代替：
 * 上千条时有几十页，全铺开会把一行撑到换行，反而找不到当前页。
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { pageWindow } from '@/hooks/usePagination';
import { Select } from './Select';
import styles from './Pagination.module.scss';

export interface PaginationProps {
  /** 当前页，1 起算。 */
  page: number;
  totalPages: number;
  /** 全部条目数，用来说「共多少条」。 */
  total: number;
  /** 这一页覆盖第几条到第几条（1 起算）。 */
  from: number;
  to: number;
  onPageChange: (page: number) => void;
  /**
   * 每页条数的可选项。不给就没有容量控件 —— 列表自己已经有别的容量设置时
   * （比如账号池的卡片行数）不该出现第二个说法。
   */
  pageSizeOptions?: readonly number[];
  pageSize?: number;
  onPageSizeChange?: (size: number) => void;
}

/** 页码窗口：首页、末页、当前页及其左右各一页，其余折叠成省略号。 */
export function Pagination({
  page,
  totalPages,
  total,
  from,
  to,
  onPageChange,
  pageSizeOptions,
  pageSize,
  onPageSizeChange,
}: PaginationProps) {
  const { t } = useTranslation();
  const numbers = useMemo(() => pageWindow(page, totalPages), [page, totalPages]);

  const sizeOptions = pageSizeOptions?.map((size) => ({
    value: String(size),
    label: t('pagination.size_option', { count: size }),
  }));
  const showSizeControl = Boolean(sizeOptions && pageSize !== undefined && onPageSizeChange);

  // 只有一页时整条不出现 —— 它除了说明「你不需要翻页」什么也没做。
  // 例外是容量控件已经离开默认值：那时它必须留着，否则换成 100 条之后
  // 一页装下全部，人就再也换不回 20 条了。
  if (total === 0) return null;
  if (totalPages <= 1 && !(showSizeControl && pageSize !== pageSizeOptions?.[0])) return null;

  return (
    <nav className={styles.pagination} aria-label={t('pagination.label')}>
      <span className={styles.range}>{t('pagination.range', { from, to, total })}</span>

      <div className={styles.pages}>
        <button
          type="button"
          className={styles.step}
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          {t('pagination.prev')}
        </button>
        {numbers.map((item, index) =>
          item === 'gap' ? (
            <span key={`gap-${index}`} className={styles.gap} aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={item}
              type="button"
              className={`${styles.page} ${item === page ? styles.pageActive : ''}`}
              onClick={() => onPageChange(item)}
              aria-label={t('pagination.page', { page: item })}
              aria-current={item === page ? 'page' : undefined}
            >
              {item}
            </button>
          )
        )}
        <button
          type="button"
          className={styles.step}
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
        >
          {t('pagination.next')}
        </button>
      </div>

      {showSizeControl ? (
        <span className={styles.size}>
          <span>{t('pagination.size_label')}</span>
          <span className={styles.sizeControl}>
            <Select
              value={String(pageSize)}
              options={sizeOptions ?? []}
              onChange={(value) => onPageSizeChange?.(Number(value))}
              ariaLabel={t('pagination.size_label')}
              size="sm"
            />
          </span>
        </span>
      ) : (
        <span />
      )}
    </nav>
  );
}
