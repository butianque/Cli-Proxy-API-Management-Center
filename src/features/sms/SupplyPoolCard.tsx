/**
 * 台账：这一类身份**已经发出去**的记录（手机号与邮箱共用的一张表）。
 *
 * 它回答一个问题：**这个账号/号码从哪条渠道来、属于哪个类别、怎么连、现在通不通、
 * 拿它注册过什么**。自建域名的地址是自由生成的，正因为它自由，才必须逐个记下来 ——
 * 没有记录就没有追溯。
 *
 * 版面沿用渠道池：一条身份一行，行下面一条状态带，带里列出它注册过的项目
 * （`Loomy：已使用 · loomy-16723433586`）。状态带默认只露两行，超出的部分由行尾
 * 按钮展开 —— 按钮只在**真的溢出**时出现，否则它按下去什么都不会变。
 *
 * 规矩：后端给什么就显示什么。后端没记渠道就是「不知道」，不按域名猜；没记注册
 * 就是没有，不摆占位行。
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
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
import { IconAlertTriangle, IconChevronDown, IconChevronUp, IconTimer } from '@/components/ui/icons';
import { supplyApi } from '@/services/api/supply';
import {
  CATEGORY_LABEL,
  NATURE_LABEL,
  connectionState,
  projectLabel,
  toPool,
  toProbes,
  toSupplyChannels,
} from './smsMapping';
import type { PoolEntry, SupplyChannel, SupplyKind, SupplyNature, SupplyProbeState } from './types';
import styles from './SmsServicePage.module.scss';

export interface SupplyPoolCardProps {
  /** 只看这一类身份（手机号 / 邮箱）；不传 = 两类一起。 */
  kind?: SupplyKind;
}

const ALL_KINDS: readonly SupplyKind[] = ['phone', 'email'];

export function SupplyPoolCard({ kind }: SupplyPoolCardProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<PoolEntry[]>([]);
  const [channels, setChannels] = useState<SupplyChannel[]>([]);
  const [probes, setProbes] = useState<
    Map<string, Partial<Record<SupplyNature, SupplyProbeState>>>
  >(new Map());
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [overflowing, setOverflowing] = useState<Set<string>>(new Set());
  // 窗口变窄会让原本一行的状态带折成两行：宽度变了就得重量一次，否则按钮会一直缺席。
  const [, setMeasureTick] = useState(0);

  const kinds = useMemo(() => (kind ? ([kind] as const) : ALL_KINDS), [kind]);

  const load = useCallback(async () => {
    try {
      const [pools, channelLists] = await Promise.all([
        Promise.all(kinds.map((item) => supplyApi.listPool(item))),
        Promise.all(kinds.map((item) => supplyApi.listChannels(item))),
      ]);
      const list = channelLists.flatMap((result) => toSupplyChannels(result.channels));
      setEntries(toPool(pools.flat()));
      setChannels(list);
      // 探活只问「已启用」的渠道：停用的渠道没有连通的义务，问它只会得到一句噪音。
      const ids = list.filter((channel) => channelEnabled(channel, kinds)).map((channel) => channel.id);
      const probed = ids.length > 0 ? toProbes(await supplyApi.probeChannels(ids)) : [];
      setProbes(new Map(probed.map((item) => [item.id, item.natures])));
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setProbes(new Map());
    } finally {
      setLoaded(true);
    }
  }, [kinds]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const remeasure = () => setMeasureTick((value) => value + 1);
    window.addEventListener('resize', remeasure);
    return () => window.removeEventListener('resize', remeasure);
  }, []);

  const channelById = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel])),
    [channels]
  );

  /**
   * 记录里的 `channel_id` → 供应池里的那条渠道。
   *
   * 邮箱记的是渠道 id，直接命中。手机号记的是平台自己的渠道 uid（号码来自平台，
   * 不是来自某条渠道），所以按「凭据条目名」再找一次；仍然找不到就是找不到 ——
   * 不按平台名猜一条渠道出来，那是编造归属。
   */
  const resolveChannel = useCallback(
    (entry: PoolEntry): SupplyChannel | null => {
      const wanted = entry.channelId.trim().toLowerCase();
      if (!wanted) return null;
      const direct = channelById.get(entry.channelId);
      if (direct) return direct;
      for (const channel of channels) {
        const block = entry.kind === 'phone' ? channel.phone : channel.email;
        const connections = block?.connections ?? {};
        for (const connection of Object.values(connections)) {
          if ((connection?.secret ?? '').trim().toLowerCase() === wanted) return channel;
        }
      }
      return null;
    },
    [channelById, channels]
  );

  const natureLabel = useCallback((nature: SupplyNature) => t(NATURE_LABEL[nature]), [t]);

  /**
   * 平台显示名：与凭据列表共用一份标签，查不到就用原始 id，不另编一个。
   */
  const projectName = useCallback((target: string) => projectLabel(target, t), [t]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** 只有真的溢出两行才记下「这里需要按钮」；不溢出的行不该出现按了没反应的按钮。 */
  const measure = useCallback((id: string, node: HTMLDivElement | null) => {
    if (!node) return;
    const over = node.scrollHeight > node.clientHeight + 1;
    setOverflowing((current) => {
      if (current.has(id) === over) return current;
      const next = new Set(current);
      if (over) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

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
              <TableHead>{t('sms_service.ledger_col_account')}</TableHead>
              <TableHead>{t('sms_service.ledger_col_channel')}</TableHead>
              <TableHead>{t('sms_service.ledger_col_category')}</TableHead>
              <TableHead>{t('sms_service.ledger_col_natures')}</TableHead>
              <TableHead>{t('sms_service.ledger_col_state')}</TableHead>
              <TableHead alignRight>
                <span className={styles.srOnly}>{t('sms_service.ledger_expand')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => {
              const rowKey = `${entry.kind}:${entry.identity}`;
              const channel = resolveChannel(entry);
              const block = channel
                ? entry.kind === 'phone'
                  ? channel.phone
                  : channel.email
                : null;
              const connection = connectionState(
                block?.natures ?? [],
                channel ? probes.get(channel.id) : undefined,
                natureLabel
              );
              const categoryLabel = channel?.category ? CATEGORY_LABEL[channel.category] : '';
              const isOpen = expanded.has(rowKey);
              const canExpand = overflowing.has(rowKey);
              // 只有真的带状态带的那一行才去掉下边框：没有项目的一行下面什么都没有，
              // 跟着去掉边框会让它看起来「后面还有东西」。
              const hasStrip = entry.projects.length > 0;

              return (
                <Fragment key={rowKey}>
                  <TableRow className={hasStrip ? styles.stripLead : undefined}>
                    <TableCell>
                      <span className={styles.mono}>{entry.identity || '—'}</span>
                    </TableCell>
                    <TableCell>{channel?.label || '—'}</TableCell>
                    <TableCell>
                      {categoryLabel ? (
                        <span className={`${styles.tag} ${styles.tagMuted}`}>
                          {t(categoryLabel)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>
                      {(block?.natures ?? []).length > 0
                        ? (block?.natures ?? []).map((nature) => t(NATURE_LABEL[nature])).join(' + ')
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <span className={`${styles.tag} ${styles[connection.tone]}`}>
                        {t(connection.key, connection.params)}
                      </span>
                    </TableCell>
                    <TableCell alignRight>
                      {canExpand ? (
                        <button
                          type="button"
                          className={styles.actionPill}
                          onClick={() => toggleExpanded(rowKey)}
                          title={
                            isOpen ? t('sms_service.ledger_collapse') : t('sms_service.ledger_expand')
                          }
                          aria-label={
                            isOpen ? t('sms_service.ledger_collapse') : t('sms_service.ledger_expand')
                          }
                          aria-expanded={isOpen}
                        >
                          {isOpen ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
                        </button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                  {/* 没注册过任何平台就没有这一行：空状态不摆一条空带。 */}
                  {hasStrip ? (
                    <TableRow className={styles.stripRow}>
                      <TableCell colSpan={6}>
                        <div
                          ref={(node) => {
                            // 展开时量的是「不裁剪」的高度，量出来永远不会溢出，所以只在
                            // 收起状态下测量 —— 否则按钮会在展开的瞬间自己消失。
                            if (!isOpen) measure(rowKey, node);
                          }}
                          className={`${styles.strip} ${styles.stripProjects} ${
                            isOpen ? '' : styles.stripClamp
                          }`}
                        >
                          {entry.projects.map((project) => (
                            <span
                              className={styles.stripItem}
                              key={`${project.target}@${project.account}`}
                            >
                              <span>
                                {t('sms_service.ledger_project', {
                                  project: projectName(project.target),
                                  state: t(`sms_service.pool_state_${project.state}`),
                                })}
                              </span>
                              {project.account ? (
                                <span className={styles.stripAccount}>
                                  <span className={styles.mono}>{project.account}</span>
                                </span>
                              ) : null}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

/** 这条渠道是否在当前这张台账里被启用。 */
function channelEnabled(channel: SupplyChannel, kinds: readonly SupplyKind[]): boolean {
  return kinds.some((item) => (item === 'phone' ? channel.phone : channel.email)?.enabled === true);
}
