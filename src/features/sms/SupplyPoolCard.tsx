/**
 * 池：这一类身份**已经发出去**的记录（手机号与邮箱共用的一张卡）。
 *
 * 池回答一个问题：**哪个身份、从哪条来源来、注册了哪个账号**。自建域名的地址是
 * 自由生成的，正因为它自由，才必须逐个记下来 —— 没有记录就没有追溯。
 *
 * 规矩：后端给什么就显示什么。后端没记时间就是「没有时间」，不拿当前时间顶替；
 * 没有记录就是空态，不摆占位行。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { IconAlertTriangle, IconTimer } from '@/components/ui/icons';
import { formatDateTimeValue } from '@/utils/format';
import { supplyApi } from '@/services/api/supply';
import { toPool } from './smsMapping';
import type { PoolEntry, SupplyKind } from './types';
import styles from './SmsServicePage.module.scss';

export interface SupplyPoolCardProps {
  /** 这一类身份（手机号 / 邮箱）。 */
  kind?: SupplyKind;
}

/** 池里一行状态的着色：已注册=好、待用=中性、失败=警告。 */
const STATE_CLASS: Record<PoolEntry['state'], string> = {
  registered: 'tagGood',
  pending: 'tagMuted',
  released: 'tagMuted',
  failed: 'tagWarning',
};

export function SupplyPoolCard({ kind }: SupplyPoolCardProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<PoolEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    try {
      const kinds = kind ? [kind] : (['phone', 'email'] as const);
      const records = (await Promise.all(kinds.map((item) => supplyApi.listPool(item)))).flat();
      setEntries(toPool(records));
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoaded(true);
    }
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card
      title={
        <span className={styles.cardTitle}>
          <IconTimer size={17} />
          {t('sms_service.pool_title')}
        </span>
      }
      extra={
        loaded ? (
          <span className={styles.statLabel}>
            {t('sms_service.pool_extra', { count: entries.length })}
          </span>
        ) : null
      }
    >
      {loadError && (
        <Notice tone="danger" role="alert" icon={<IconAlertTriangle size={15} />}>
          {t('sms_service.pool_error_load', { message: loadError })}
        </Notice>
      )}

      {/* 加载完成前不画空表头：那是「还没有数据」和「还没读到」混在一起。 */}
      {!loaded ? null : entries.length === 0 ? (
        <EmptyState
          title={t('sms_service.pool_empty')}
          description={t('sms_service.pool_empty_desc')}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('sms_service.pool_col_identity')}</TableHead>
              <TableHead>{t('sms_service.pool_col_source')}</TableHead>
              <TableHead>{t('sms_service.pool_col_account')}</TableHead>
              <TableHead>{t('sms_service.pool_col_state')}</TableHead>
              <TableHead>{t('sms_service.pool_col_last_used')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={`${entry.identity}@${entry.lastUsedAt ?? ''}`}>
                <TableCell className={styles.mono}>{entry.identity}</TableCell>
                <TableCell>{entry.source || '—'}</TableCell>
                <TableCell>
                  {entry.account || '—'}
                  {entry.platform && (
                    <span className={`${styles.tag} ${styles.tagMuted}`}>{entry.platform}</span>
                  )}
                </TableCell>
                <TableCell>
                  <span className={`${styles.tag} ${styles[STATE_CLASS[entry.state]]}`}>
                    {t(`sms_service.pool_state_${entry.state}`)}
                  </span>
                </TableCell>
                <TableCell>
                  {entry.lastUsedAt ? formatDateTimeValue(entry.lastUsedAt) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
