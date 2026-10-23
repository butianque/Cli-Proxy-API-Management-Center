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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import {
  Table,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowGroup,
} from '@/components/ui/Table';
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronUp,
  IconTimer,
} from '@/components/ui/icons';
import { supplyApi } from '@/services/api/supply';
import { formatDateTimeValue } from '@/utils/format';
import { EntryStatus, EntryStatusFact, EntryStatusFacts, EntryStatusGroup } from './EntryStatus';
import {
  NATURE_LABEL,
  identityState,
  latestPoolActivity,
  projectLabel,
  projectSite,
  toPool,
  toProbes,
  toSupplyChannels,
} from './smsMapping';
import type { PoolEntry, SupplyChannel, SupplyKind, SupplyNature, SupplyProbeState } from './types';
import styles from './SmsServicePage.module.scss';

export interface SupplyPoolCardProps {
  /** 只看这一类身份（手机号 / 邮箱）；不传 = 两类一起。 */
  kind?: SupplyKind;
  /**
   * 外部要求重读的计数器（导入完成后 +1）。
   *
   * 台账没有推送，导入发生在别处，所以「刚导进来的号」只能靠父组件叫它重读一次。
   */
  reloadKey?: number;
}

const ALL_KINDS: readonly SupplyKind[] = ['phone', 'email'];

export function SupplyPoolCard({ kind, reloadKey = 0 }: SupplyPoolCardProps) {
  const { t, i18n } = useTranslation();
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
      const ids = list
        .filter((channel) => channelEnabled(channel, kinds))
        .map((channel) => channel.id);
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
  }, [load, reloadKey]);

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
   *
   * 手机号还有一条退路：这一类只有**一份**平台凭据，所以当渠道池里正好只有一条
   * 手机号渠道时，那个号就是它发出来的。有第二条时无从判断，宁可不写。
   */
  const resolveChannel = useCallback(
    (entry: PoolEntry): SupplyChannel | null => {
      const wanted = entry.channelId.trim().toLowerCase();
      if (wanted) {
        const direct = channelById.get(entry.channelId);
        if (direct) return direct;
        for (const channel of channels) {
          const block = entry.kind === 'phone' ? channel.phone : channel.email;
          const connections = block?.connections ?? {};
          for (const connection of Object.values(connections)) {
            if ((connection?.secret ?? '').trim().toLowerCase() === wanted) return channel;
          }
        }
      }
      if (entry.kind === 'phone') {
        const phoneChannels = channels.filter((channel) => channel.phone !== null);
        return phoneChannels.length === 1 ? phoneChannels[0] : null;
      }
      return null;
    },
    [channelById, channels]
  );

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
              <TableHead>{t('sms_service.ledger_col_category')}</TableHead>
              <TableHead>{t('sms_service.ledger_col_channel')}</TableHead>
              <TableHead>{t('sms_service.ledger_col_source')}</TableHead>
              <TableHead>{t('sms_service.ledger_col_natures')}</TableHead>
              <TableHead>{t('sms_service.ledger_col_state')}</TableHead>
              <TableHead alignRight>
                <span className={styles.srOnly}>{t('sms_service.ledger_expand')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          {entries.map((entry) => {
            const rowKey = `${entry.kind}:${entry.identity}`;
            const channel = resolveChannel(entry);
            const block = channel ? (entry.kind === 'phone' ? channel.phone : channel.email) : null;
            const declared = block?.natures ?? [];
            const mailbox = entry.mailbox;
            const state = identityState(
              mailbox,
              declared,
              channel ? probes.get(channel.id) : undefined
            );
            /**
             * 类别说的是**这是哪一类身份**（手机号 / 邮箱），不是渠道的性质。
             *
             * 一张表里两类的列一样，只有这一列说得出「这一行是号码还是地址」；
             * 渠道的性质（第三方 / 自建域）属于渠道那一页，在这里再写一遍只会
             * 让同一个词在一行里出现两次、意思还不一样。
             */
            const kindLabel = t(
              entry.kind === 'phone' ? 'sms_service.tab_phone' : 'sms_service.tab_email'
            );
            /**
             * 域 / 平台：这个身份**在哪收信**，或者由哪个平台给号。
             *
             * 邮箱看的是地址里最后一个 `@` 之后的那一段 —— 买来的 `@outlook.com` 和自建
             * catch-all 的 `@ormnes.com` 是同一件事：一个地址，域就是它收信的地方。所以
             * 邮箱这一格说得出来，不是「不知道」。
             *
             * 手机号没有「收信的域」，它来自哪个平台就是这一格的事实。
             */
            const domainLabel =
              entry.kind === 'email'
                ? entry.domain
                  ? `@${entry.domain}`
                  : '—'
                : channel?.label || '—';
            /**
             * 来源：这个身份是**谁给的**。域已经在上一格说过了，这一格不再说一遍。
             *
             * 自带凭据的邮箱是直接买进来入池的，它的来源就是「导入」；渠道发出来的邮箱
             * 写那条渠道。手机号写渠道内部**具体哪一条线**（对接码）—— 同一个平台下有
             * 好几条线，只有它说得清这个号从哪条来。
             */
            const sourceLabel =
              entry.kind === 'email'
                ? mailbox
                  ? t('sms_service.pool_origin_import')
                  : channel?.label || '—'
                : entry.sourceDetail || '—';
            const naturesLabel = mailbox
              ? t(NATURE_LABEL[mailbox.nature])
              : declared.map((nature) => t(NATURE_LABEL[nature])).join(' + ');
            const isOpen = expanded.has(rowKey);
            const canExpand = overflowing.has(rowKey);
            // 每个身份下面都有一条状态带：它回答「这个号注册过哪些平台」，
            // 没注册过本身就是答案（「未注册任何平台」），不摆空行也不藏起来 ——
            // 藏起来时，一个刚导进来还没用过的号看起来就像「面板没做这一块」。
            const unused = entry.projects.length === 0;
            // 「更新时间」= 这条记录最后一次动过的时刻（最近使用 / 最近一次注册里较晚的）。
            // 两个时间都没记就是没有 —— 不拿「刚导进来」冒充一次更新。
            const updatedAt = latestPoolActivity(entry);
            const updatedText = updatedAt ? formatDateTimeValue(updatedAt, i18n.language) : '';

            return (
              <TableRowGroup key={rowKey}>
                <TableRow className={styles.stripLead}>
                  <TableCell>
                    <span className={styles.mono}>{entry.identity || '—'}</span>
                  </TableCell>
                  <TableCell>
                    <span className={`${styles.tag} ${styles.tagMuted}`}>{kindLabel}</span>
                  </TableCell>
                  <TableCell>{domainLabel}</TableCell>
                  <TableCell>{sourceLabel}</TableCell>
                  <TableCell>{naturesLabel || '—'}</TableCell>
                  <TableCell>
                    <span className={`${styles.tag} ${styles[state.tone]}`}>
                      {t(state.key, state.params)}
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
                <TableRow className={styles.stripRow}>
                  <TableCell colSpan={7}>
                    <EntryStatus>
                      <EntryStatusFacts>
                        <EntryStatusFact
                          label={t('sms_service.ledger_fact_registrations')}
                          tone={unused ? 'muted' : 'plain'}
                        >
                          {unused
                            ? t('sms_service.ledger_unused')
                            : t('sms_service.ledger_registered_count', {
                                count: entry.projects.length,
                              })}
                        </EntryStatusFact>
                        {updatedText !== '' && (
                          <EntryStatusFact label={t('sms_service.ledger_fact_updated')}>
                            {updatedText}
                          </EntryStatusFact>
                        )}
                      </EntryStatusFacts>
                      {unused ? null : (
                        <EntryStatusGroup>
                          <div
                            ref={(node) => {
                              // 展开时量的是「不裁剪」的高度，量出来永远不会溢出，所以只在
                              // 收起状态下测量 —— 否则按钮会在展开的瞬间自己消失。
                              if (!isOpen) measure(rowKey, node);
                            }}
                            className={`${styles.stripProjects} ${isOpen ? '' : styles.stripClamp}`}
                          >
                            {entry.projects.map((project) => {
                              const site = projectSite(project.target);
                              // 结果只有三种语气：成了、没成、还在等/已释放。这一行
                              // 里只有它带颜色，扫一眼就知道哪条要处理。
                              const stateTone =
                                project.state === 'registered'
                                  ? styles.stripStateGood
                                  : project.state === 'failed'
                                    ? styles.stripStateBad
                                    : styles.stripState;
                              return (
                                <div
                                  className={styles.registrationRow}
                                  key={`${project.target}@${project.account}`}
                                >
                                  {/* 站点与凭证卡片「站点」行同一套读法：域名是事实，
                                        国内/国际是它的限定语。没有映射就只说品牌名，
                                        不拿别的平台的域名凑。 */}
                                  <span className={styles.stripSite}>
                                    {site ? (
                                      <>
                                        <span className={styles.stripRegion}>
                                          {t(`auth_files.region_${site.region}`)}
                                        </span>
                                        <span className={styles.stripDomain}>{site.domain}</span>
                                      </>
                                    ) : (
                                      <span className={styles.stripDomain}>
                                        {projectName(project.target)}
                                      </span>
                                    )}
                                  </span>
                                  <span className={stateTone}>
                                    {t(`sms_service.pool_state_${project.state}`)}
                                  </span>
                                  {project.account !== '' && (
                                    <span className={styles.mono}>{project.account}</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </EntryStatusGroup>
                      )}
                    </EntryStatus>
                  </TableCell>
                </TableRow>
              </TableRowGroup>
            );
          })}
        </Table>
      )}
    </Card>
  );
}

/** 这条渠道是否在当前这张台账里被启用。 */
function channelEnabled(channel: SupplyChannel, kinds: readonly SupplyKind[]): boolean {
  return kinds.some((item) => (item === 'phone' ? channel.phone : channel.email)?.enabled === true);
}
