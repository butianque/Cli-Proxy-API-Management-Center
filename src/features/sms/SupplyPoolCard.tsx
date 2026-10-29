/**
 * 台账：这一类身份**已经发出去**的记录（手机号与邮箱共用的一张表）。
 *
 * 它回答一个问题：**这个账号/号码从哪条渠道来、属于哪个类别、怎么连、现在通不通、
 * 拿它注册过什么**。自建域名的地址是自由生成的，正因为它自由，才必须逐个记下来 ——
 * 没有记录就没有追溯。
 *
 * 版面沿用渠道池：一条身份一行，行下面一条状态带，带里列出它注册过的项目
 * （`zcode.z.ai：已注册`）。注册出来的账号 ID 挂在「已注册」的悬浮提示上，默认不占
 * 行宽 —— 一串 UUID 比结果本身还长，摆在行里就把「成没成」挤成了次要信息。状态带
 * 默认只露两行，超出的部分由行尾按钮展开 —— 按钮只在**真的溢出**时出现，否则它
 * 按下去什么都不会变。
 *
 * 规矩：后端给什么就显示什么。后端没记渠道就是「不知道」，不按域名猜；没记注册
 * 就是没有，不摆占位行。
 *
 * 表**自己滚**，而且一次只加载 10 条：台账上千条时，整页跟着长会把页头的「收件箱」
 * 推到视野外，复制一个地址要来回滚两趟；屏外的行也不该占着 DOM。滚到底自动追加下一批，
 * 已加载的行也只渲染看得见的那几段（见 `useRowWindow`）。
 *
 * 探活只探**看得见的那些行**：台账上千条时，一屏之外的行走廊里没人看，为它们各开一条
 * 连接只是白花时间；窗口滚到哪儿就测哪儿，其余的行照实写「未检查」。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
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
  TableSpacer,
} from '@/components/ui/Table';
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronUp,
  IconRefreshCw,
  IconTimer,
  IconTrash2,
} from '@/components/ui/icons';
import { emailApi } from '@/services/api/email';
import { supplyApi } from '@/services/api/supply';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { useSecretGateStore } from '@/stores/useSecretGateStore';
import { formatDateTimeValue } from '@/utils/format';
import { EntryStatus, EntryStatusFact, EntryStatusFacts, EntryStatusGroup } from './EntryStatus';
import { PoolLoadMore } from './PoolLoadMore';
import { SweepOfflineModal } from './SweepOfflineModal';
import { sweepCandidates } from './sweepOffline';
import { rowIndexProps, useRowWindow } from './useRowWindow';
import {
  NATURE_LABEL,
  identityState,
  latestPoolActivity,
  projectLabel,
  projectSite,
  toMailboxProbes,
  toPool,
  toProbes,
  toSupplyChannels,
} from './smsMapping';
import type {
  MailboxProbe,
  PoolEntry,
  SupplyChannel,
  SupplyKind,
  SupplyNature,
  SupplyProbeState,
} from './types';
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
  /**
   * 扫活里选了「重新授权导入」：把地址交回页面，由页面带着它们打开导入弹窗。
   *
   * 授权是一条独立的流程（要等人在微软页面上登录），不属于台账这一张卡片，所以
   * 卡片只负责把「哪些号要救」说清楚。
   */
  onReauthorize?: (addresses: string[]) => void;
}

const ALL_KINDS: readonly SupplyKind[] = ['phone', 'email'];

export function SupplyPoolCard({ kind, reloadKey = 0, onReauthorize }: SupplyPoolCardProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [entries, setEntries] = useState<PoolEntry[]>([]);
  const [channels, setChannels] = useState<SupplyChannel[]>([]);
  const [probes, setProbes] = useState<
    Map<string, Partial<Record<SupplyNature, SupplyProbeState>>>
  >(new Map());
  // 自带凭据的邮箱的连通状态，按地址查（小写）。没有条目 = 没测过。
  const [mailboxProbes, setMailboxProbes] = useState<Map<string, MailboxProbe>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [overflowing, setOverflowing] = useState<Set<string>>(new Set());
  // 正在移除的那一行（`kind:identity`，与 rowKey 同一口径）：只有它自己的按钮变灰。
  const [busyKey, setBusyKey] = useState('');
  // 扫活弹窗开着没有。它扫的是**整本台账**，不是当前页。
  const [sweepOpen, setSweepOpen] = useState(false);
  // 窗口变窄会让原本一行的状态带折成两行：宽度变了就得重量一次，否则按钮会一直缺席。
  const [, setMeasureTick] = useState(0);
  /**
   * 已经问过的渠道 / 地址。
   *
   * 窗口一滑就会换一批可见的行，如果每次都把看得见的全问一遍，滚动本身就成了请求
   * 放大器。这里只记住「问过谁」，重新读台账（导入、解锁、删完一条）才清空。
   */
  const probedRef = useRef({ channels: new Set<string>(), addresses: new Set<string>() });
  /** 正在问、还没回来的那些：避免窗口连着滑两次时把同一批渠道问两遍。 */
  const askingRef = useRef({ channels: new Set<string>(), addresses: new Set<string>() });
  /**
   * 台账读了几遍。
   *
   * 探活结果只对「读这一遍台账时的渠道」有意义：重新读的时候已经在途的那次探活
   * 说的是上一批渠道，落回来也不能写进新的状态里。
   */
  const probeGeneration = useRef(0);

  const kinds = useMemo(() => (kind ? ([kind] as const) : ALL_KINDS), [kind]);

  /**
   * 能扫活的身份：自带凭据的邮箱。
   *
   * 渠道发出来的地址自己不收信，它的信落在渠道的信箱里 —— 渠道通不通由渠道那一页
   * 回答，这里再问一遍只会得到同一个答案的另一个说法。
   */
  const ownMailboxes = useMemo(() => sweepCandidates(entries), [entries]);

  const load = useCallback(async () => {
    // 重新读一遍台账 = 重新看一遍这些号：问过的记录跟着作废，滚动窗口里会重新测。
    probeGeneration.current += 1;
    probedRef.current.channels.clear();
    probedRef.current.addresses.clear();
    askingRef.current.channels.clear();
    askingRef.current.addresses.clear();
    try {
      const [pools, channelLists] = await Promise.all([
        Promise.all(kinds.map((item) => supplyApi.listPool(item))),
        Promise.all(kinds.map((item) => supplyApi.listChannels(item))),
      ]);
      const list = channelLists.flatMap((result) => toSupplyChannels(result.channels));
      setEntries(toPool(pools.flat()));
      setChannels(list);
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setProbes(new Map());
      setMailboxProbes(new Map());
    } finally {
      setLoaded(true);
    }
  }, [kinds]);

  // 主密码解开后凭据才读得到，所以「锁定 → 解锁」是一次真的状态变化：状态列要跟着
  // 重测一遍，否则「解开了」这件事在台账上什么也没发生。只有这一种转变要重测 ——
  // 页面刚打开时的 idle → unlocked 不是变化，首次加载已经按当时的状态测过了。
  const phase = useSecretGateStore((state) => state.phase);
  const previousPhase = useRef(phase);
  useEffect(() => {
    const wasLocked = previousPhase.current === 'locked';
    previousPhase.current = phase;
    if (wasLocked && phase === 'unlocked') void load();
  }, [phase, load]);

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

  const rows = useRowWindow(entries.length);
  /** 这一屏真正要渲染的那几条。窗口之外的行不进 DOM。 */
  const visible = useMemo(
    () => entries.slice(rows.start, rows.end),
    [entries, rows.start, rows.end]
  );

  /**
   * 探活只问**看得见的那些行**。
   *
   * 台账上千条时，一屏之外的行走廊里没人看；为它们各开一条连接，换来的只是一屏
   * 看不到的结论。窗口滚到哪儿就测哪儿，其余行照实写「未检查」—— 那确实是没测过。
   *
   * 问过谁记在 `probedRef` 里：窗口一滑就换一批可见的行，每次都全问一遍等于把滚动
   * 变成请求放大器。重新读台账才清空，于是那时会重新测一次，结论仍然是新的。
   */
  useEffect(() => {
    if (!loaded) return;
    // 只问「已启用」的渠道：停用的渠道没有连通的义务，问它只会得到一句噪音。
    const ids: string[] = [];
    for (const entry of visible) {
      const channel = resolveChannel(entry);
      if (channel === null || !channelEnabled(channel, kinds)) continue;
      if (probedRef.current.channels.has(channel.id)) continue;
      if (askingRef.current.channels.has(channel.id)) continue;
      askingRef.current.channels.add(channel.id);
      ids.push(channel.id);
    }
    // 自带凭据的邮箱没有渠道可问，只能连它自己的信箱。同一个信箱只连一次，
    // 所以按地址去重 —— catch-all 域下的许多地址共用同一个信箱。
    const addresses: string[] = [];
    for (const entry of visible) {
      if (entry.kind !== 'email' || !entry.mailbox || entry.mailbox.hasCredential === false) {
        continue;
      }
      const address = entry.identity.trim().toLowerCase();
      if (address === '') continue;
      if (probedRef.current.addresses.has(address)) continue;
      if (askingRef.current.addresses.has(address)) continue;
      askingRef.current.addresses.add(address);
      addresses.push(address);
    }
    if (ids.length === 0 && addresses.length === 0) return;

    // 结论按渠道 / 地址记账，与「此刻窗口里是哪几行」无关。所以结果一回来就写进去：
    // 等结果的这几百毫秒里窗口又滑了一次，这一次的结论也不该跟着作废 —— 作废之后
    // 那几行会一直停在「未检查」，而请求其实早就成功过了。
    const generation = probeGeneration.current;
    void Promise.all([
      // 连不上一个信箱不该让整张表报错：拿不到结论就是「没测到」，行上照实显示。
      ids.length > 0 ? supplyApi.probeChannels(ids).catch(() => []) : Promise.resolve([]),
      addresses.length > 0
        ? emailApi.probeAddresses(addresses).catch(() => [])
        : Promise.resolve([]),
    ]).then(([probed, mailboxStates]) => {
      const stale = generation !== probeGeneration.current;
      for (const id of ids) askingRef.current.channels.delete(id);
      for (const address of addresses) askingRef.current.addresses.delete(address);
      // 这一批渠道属于上一遍台账：结论作废，也不记账（新的一遍会重新问）。
      if (stale) return;
      // 问过了：无论答没答上来都不再重复问，重新读台账才重来。
      for (const id of ids) probedRef.current.channels.add(id);
      for (const address of addresses) probedRef.current.addresses.add(address);
      setProbes((current) => {
        const next = new Map(current);
        for (const item of toProbes(probed)) next.set(item.id, item.natures);
        return next;
      });
      setMailboxProbes((current) => {
        const next = new Map(current);
        for (const [address, probe] of toMailboxProbes(mailboxStates)) next.set(address, probe);
        return next;
      });
    });
  }, [loaded, visible, resolveChannel, kinds]);

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

  /**
   * 移除一个身份：先问一次，再让后端删，删成了才重新读一遍。
   *
   * 不在本地把这行抹掉 —— 后端才是事实。先删再报错，等于让操作者以为它已经没了；
   * 失败时这一行留在原处，错因照实报出来。
   */
  const remove = useCallback(
    (entry: PoolEntry) => {
      const rowKey = `${entry.kind}:${entry.identity}`;
      showConfirmation({
        title: t('sms_service.ledger_remove_confirm_title'),
        message: t('sms_service.ledger_remove_confirm', { address: entry.identity }),
        variant: 'danger',
        confirmText: t('common.confirm'),
        cancelText: t('common.cancel'),
        onConfirm: async () => {
          setBusyKey(rowKey);
          try {
            const result = await supplyApi.removePoolAccount(entry.kind, entry.identity);
            if (!result.ok) {
              showNotification(result.message, 'error');
              return;
            }
            await load();
          } finally {
            setBusyKey('');
          }
        },
      });
    },
    [load, showConfirmation, showNotification, t]
  );

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
          <span className={styles.poolExtra}>
            {/* 扫活紧挨着计数：它说的是「这些身份里有多少已经不能用」，
                放在计数左边，读起来是一句话。提示挂在外层，因为禁用的按钮自己
                不会弹出 title —— 而恰好是「没有可检查的号」时最需要这句说明。 */}
            <span title={t('sms_service.pool_sweep_hint')}>
              <button
                type="button"
                className={styles.actionPill}
                onClick={() => setSweepOpen(true)}
                disabled={ownMailboxes.length === 0}
              >
                <IconRefreshCw size={13} />
                {t('sms_service.pool_sweep')}
              </button>
            </span>
            <span className={styles.statLabel}>
              {t('sms_service.pool_extra', { count: entries.length })}
            </span>
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
        <>
          <Table
            maxHeight="var(--sms-pool-max-height)"
            scrollRef={rows.containerRef}
            onBodyScroll={rows.onScroll}
          >
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
                <TableHead alignRight>{t('sms_service.ledger_col_remove')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableSpacer height={rows.topPad} colSpan={8} />
            {visible.map((entry, offset) => {
              const index = rows.start + offset;
              const rowKey = `${entry.kind}:${entry.identity}`;
              const channel = resolveChannel(entry);
              const block = channel
                ? entry.kind === 'phone'
                  ? channel.phone
                  : channel.email
                : null;
              const declared = block?.natures ?? [];
              const mailbox = entry.mailbox;
              const state = identityState(
                mailbox,
                declared,
                channel ? probes.get(channel.id) : undefined,
                // 自带凭据的地址问的是它自己的信箱；渠道发出来的地址没有这一条，
                // 它问的是渠道（上一行）。
                mailboxProbes.get(entry.identity.trim().toLowerCase())
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
              const removeLabel = t('sms_service.ledger_remove_aria', { address: entry.identity });
              // 每个身份下面都有一条状态带：它回答「这个号注册过哪些平台」，
              // 没注册过本身就是答案（「未注册任何平台」），不摆空行也不藏起来 ——
              // 藏起来时，一个刚导进来还没用过的号看起来就像「面板没做这一块」。
              const unused = entry.projects.length === 0;
              // 「更新时间」= 这条记录最后一次动过的时刻（最近使用 / 最近一次注册里较晚的）。
              // 两个时间都没记就是没有 —— 不拿「刚导进来」冒充一次更新。
              const updatedAt = latestPoolActivity(entry);
              const updatedText = updatedAt ? formatDateTimeValue(updatedAt, i18n.language) : '';

              return (
                <TableRowGroup key={rowKey} {...rowIndexProps(index)}>
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
                      <span
                        className={`${styles.tag} ${styles[state.tone]}`}
                        title={state.detail || undefined}
                      >
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
                            isOpen
                              ? t('sms_service.ledger_collapse')
                              : t('sms_service.ledger_expand')
                          }
                          aria-label={
                            isOpen
                              ? t('sms_service.ledger_collapse')
                              : t('sms_service.ledger_expand')
                          }
                          aria-expanded={isOpen}
                        >
                          {isOpen ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
                        </button>
                      ) : null}
                    </TableCell>
                    <TableCell alignRight>
                      <button
                        type="button"
                        className={styles.actionPill}
                        onClick={() => remove(entry)}
                        disabled={busyKey === rowKey}
                        title={removeLabel}
                        aria-label={removeLabel}
                      >
                        <IconTrash2 size={14} />
                      </button>
                    </TableCell>
                  </TableRow>
                  <TableRow className={styles.stripRow}>
                    <TableCell colSpan={8}>
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
                                // 注册出来的账号 ID 是一整串 UUID：铺在行里，它比「成没成」
                                // 还长还亮，读的人第一眼看到的是 ID 而不是结果。它只在
                                // 「这条注册产出了哪份凭证」的时候才需要，所以挂到悬浮提示上，
                                // 默认这一行只留一句状态。
                                const accountTitle = project.account.trim();
                                // 有账号就意味着台账能指到那张凭证。想核对「注册出来的是哪个
                                // 号」的人，下一步一定是去看它，所以状态本身做成入口；没有
                                // 账号的注册不给假入口。
                                const stateLabel = t(`sms_service.pool_state_${project.state}`);
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
                                    {accountTitle === '' ? (
                                      <span className={stateTone}>{stateLabel}</span>
                                    ) : (
                                      <button
                                        type="button"
                                        className={`${stateTone} ${styles.stripStateAction}`}
                                        title={accountTitle}
                                        aria-label={t('sms_service.ledger_open_credential', {
                                          account: accountTitle,
                                        })}
                                        onClick={() =>
                                          navigate(
                                            `/auth-files?focus=${encodeURIComponent(accountTitle)}`
                                          )
                                        }
                                      >
                                        {stateLabel}
                                      </button>
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
            <TableSpacer height={rows.bottomPad} colSpan={8} />
          </Table>

          {/* 翻页换成「已经显示多少」：表格滚到底会自动追加下一批，这里只需要说清
              现在到哪儿了，并给不能滚的人一个按钮。 */}
          <PoolLoadMore
            shown={rows.loaded}
            total={entries.length}
            hasMore={rows.hasMore}
            onLoadMore={rows.loadMore}
          />
        </>
      )}

      {/* 扫活是一个覆盖层：它盖住整页，所以挂在这里只是让「谁打开它」跟着卡片走，
          不进卡片的版面。 */}
      <SweepOfflineModal
        open={sweepOpen}
        onClose={() => setSweepOpen(false)}
        entries={entries}
        onReauthorize={(addresses) => onReauthorize?.(addresses)}
        onRemoved={() => {
          void load();
        }}
      />
    </Card>
  );
}

/** 这条渠道是否在当前这张台账里被启用。 */
function channelEnabled(channel: SupplyChannel, kinds: readonly SupplyKind[]): boolean {
  return kinds.some((item) => (item === 'phone' ? channel.phone : channel.email)?.enabled === true);
}
