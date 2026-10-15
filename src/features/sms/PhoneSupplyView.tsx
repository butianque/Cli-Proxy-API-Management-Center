/**
 * 手机号接码视图（「接码服务」页的「手机号」类别）。
 *
 * 数据来源：基座 `/v8/management/supply/phone/*` —— 凭据是否已配、余额（真实联网）、
 * 渠道列表与账本。接码是**基座**能力（`internal/supply/phone`），面板不再经过任何插件。
 * 后端字段的归一化**全部**在 `smsMapping.ts`（前后端唯一接缝），本文件只见界面类型。
 * **没有占位数据**：后端给什么就显示什么，没有就是空态（不编造，也不拿假数据兜底）。
 * 锁定态下的规则：能显示的真实数据照常显示（渠道列表 / 账本 / 单价上限 / 花费），
 * 只有**凭据相关**的读数（账号、会话、余额）不可读 —— 页面不为整体套一层「锁定」遮罩。
 *
 * 版面约定（遵循仓库 UI 原则 + 对齐 `ConfigHeader` 语汇）：
 * - 页头与「配置面板」同范式：`align-items: flex-end` 两端对齐 + `▍` mono meta + ghost 药丸按钮；
 * - 页头只展示服务状态，**不做开关**（后端没有启停这条控制，摆个开关就是假的）；
 * - 视觉与指标靠拢：渠道健康点 + 单价 + 库存同排一行，扫一眼即知好坏；
 * - 颜色只由数据推导（健康度 / 上限 / 门是否锁定），不做纯装饰色块；
 * - 文案只讲状态与下一步，不讲实现（见 AGENTS.md「UI 设计原则」）。
 *
 * 页面的标题与「手机号 / 邮箱」类别切换由外层 `SmsServicePage` 负责；本视图只渲染
 * 手机号这一类的正文（状态行 + 凭据 + 渠道 + 账本 + 护栏）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import {
  IconAlertTriangle,
  IconCheckCircle2,
  IconDollarSign,
  IconPlus,
  IconRefreshCw,
  IconSettings,
  IconShield,
  IconTimer,
} from '@/components/ui/icons';
import { smsApi } from '@/services/api/sms';
import { useSecretGateStore } from '@/stores/useSecretGateStore';
import { formatDateTimeValue } from '@/utils/format';
import { ChannelConfigModal } from './ChannelConfigModal';
import { EMPTY_SMS_VIEW, isOverCeiling, toChannels, toStatus } from './smsMapping';
import type { ChannelHealth, PhoneLedgerEntry, SmsChannel, SmsStatusView } from './types';
import styles from './SmsServicePage.module.scss';

const healthClass: Record<ChannelHealth, string> = {
  good: styles.healthGood,
  warning: styles.healthWarning,
  critical: styles.healthCritical,
};

const ledgerStatusClass: Record<PhoneLedgerEntry['status'], string> = {
  registered: styles.tagGood,
  pending: styles.tagWarning,
  failed: styles.tagMuted,
};

function formatCny(value: number) {
  return `¥${value.toFixed(2)}`;
}

export function PhoneSupplyView() {
  const { t } = useTranslation();
  const gatePhase = useSecretGateStore((state) => state.phase);
  // 渠道名里要用「号段」这个词，由页面把本地化写法交给映射层（映射层保持纯函数）。
  const prefixLabel = t('sms_service.channel_prefix');

  // 起步就是真实空态；后端返回什么就显示什么，不拿假数据兜底。
  const [view, setView] = useState<SmsStatusView>(EMPTY_SMS_VIEW);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [channelBusy, setChannelBusy] = useState<string | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [guardrailBusy, setGuardrailBusy] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setView(toStatus(await smsApi.getStatus(), prefixLabel));
    } catch (error) {
      setLoadError(
        (error as { message?: string })?.message ?? t('sms_service.load_error_generic')
      );
    } finally {
      setLoading(false);
    }
  }, [prefixLabel, t]);

  useEffect(() => {
    void loadStatus();
    // Re-read when the gate changes state: locking or unlocking the base store
    // flips what the backend can report about the credentials.
  }, [loadStatus, gatePhase]);

  /** 暂停 / 恢复单个渠道：真实写平台，然后刷新渠道表。 */
  const toggleChannel = useCallback(
    async (channel: SmsChannel) => {
      setChannelBusy(channel.id);
      setChannelError(null);
      try {
        const result = await smsApi.setChannel(channel.id, !channel.paused);
        if (!result.ok) {
          setChannelError(result.message);
          return;
        }
        setView((prev) => ({
          ...prev,
          channels: toChannels(result.channels, {
            ceilingCny: prev.ceilingCny,
            prefixLabel,
          }),
        }));
      } catch (error) {
        setChannelError(
          (error as { message?: string })?.message ?? t('sms_service.channel_error_generic')
        );
      } finally {
        setChannelBusy(null);
      }
    },
    [prefixLabel, t]
  );

  const channels = view.channels;

  /**
   * 重新拉取平台的渠道列表（真实联网；需网页会话）。渠道表本身由 `view` 驱动，
   * 这里只负责把平台的最新状态取回来覆盖缓存，不编造任何行。
   */
  const refreshChannels = useCallback(async () => {
    setRefreshBusy(true);
    setChannelError(null);
    try {
      const result = await smsApi.refreshChannels();
      if (!result.ok) {
        setChannelError(result.message);
        return;
      }
      setView((prev) => ({
        ...prev,
        channels: toChannels(result.channels, { ceilingCny: prev.ceilingCny, prefixLabel }),
      }));
    } catch (error) {
      setChannelError(
        (error as { message?: string })?.message ?? t('sms_service.channel_error_generic')
      );
    } finally {
      setRefreshBusy(false);
    }
  }, [prefixLabel, t]);

  // 渠道数 / 超标数都由渠道列表推导，不另存一份（同一件事只有一个来源）。
  const availableChannels = useMemo(
    () => channels.filter((channel) => !channel.paused && channel.stock > 0).length,
    [channels]
  );

  // 「超标」与渠道健康点用**同一个判据**（`isOverCeiling`），上限未配置时两边都是 0。
  const overCeiling = useMemo(
    () =>
      channels.filter(
        (channel) => !channel.paused && isOverCeiling(channel.priceCny, view.ceilingCny)
      ),
    [channels, view.ceilingCny]
  );

  /** 省钱护栏：把超上限 / 无货的渠道暂停，把可用的恢复（真实写平台）。 */
  const runGuardrail = useCallback(async () => {
    setGuardrailBusy(true);
    setChannelError(null);
    try {
      const result = await smsApi.runGuardrail();
      if (!result.ok) {
        setChannelError(result.message);
        return;
      }
      setView((prev) => ({
        ...prev,
        channels: toChannels(result.channels, { ceilingCny: prev.ceilingCny, prefixLabel }),
      }));
    } catch (error) {
      setChannelError(
        (error as { message?: string })?.message ?? t('sms_service.guardrail_error_generic')
      );
    } finally {
      setGuardrailBusy(false);
    }
  }, [prefixLabel, t]);

  const cheapestChannel = useMemo(
    () =>
      channels
        .filter((channel) => !channel.paused && channel.stock > 0)
        .reduce<SmsChannel | null>(
          (best, channel) => (best === null || channel.priceCny < best.priceCny ? channel : best),
          null
        ),
    [channels]
  );

  // 凭据可见的**唯一**判据：本会话验证过主密码（gate unlocked），且后端密钥库确实已解锁。
  // 二者缺一都不可见 —— 否则「跳过验证但后端先前已解锁」会让页面把凭据露出来。
  const credsVisible = gatePhase === 'unlocked' && !view.storeLocked;

  // 累计上限是否真的存在：还没加载、或后端确实没配上限时，都谈不上「用了多少 / 超没超」。
  const capConfigured = view.loaded && view.maxTotalCny > 0;

  // 连接状态词归「渠道池」卡片（页头那行已去重）。凭据不可见时不猜，交给卡片空态与顶部主密码提示。
  const statusLabel = (() => {
    // 后端没配接码平台 = 服务是停的。凭据可能还在，所以这句必须在这儿说，不能只靠空态。
    if (!view.enabled) return t('sms_service.status_disabled');
    switch (view.connection) {
      case 'connected':
        return t('sms_service.status_connected');
      case 'failed':
        return t('sms_service.status_failed');
      case 'unavailable':
        return t('sms_service.status_unavailable');
      default:
        return t('sms_service.status_unknown');
    }
  })();

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.ghostAction}
            onClick={() => void refreshChannels()}
            disabled={refreshBusy || gatePhase === 'locked' || !view.cookiePresent}
            title={view.cookiePresent ? undefined : t('sms_service.action_need_session')}
          >
            <IconRefreshCw size={14} />
            {refreshBusy ? t('sms_service.action_working') : t('sms_service.refresh_channels')}
          </button>
        </div>
      </header>

      {loadError && (
        <Notice tone="danger" role="alert" icon={<IconAlertTriangle size={15} />}>
          {t('sms_service.load_error', { message: loadError })}
        </Notice>
      )}
      {channelError && (
        <Notice tone="danger" role="alert" icon={<IconAlertTriangle size={15} />}>
          {t('sms_service.channel_error', { message: channelError })}
        </Notice>
      )}

      {/* 已配置渠道：L3（两张凭据表 + 真实连接状态）。 */}
      <Card
        title={
          <span className={styles.cardTitle}>
            <IconSettings size={17} />
            {t('sms_service.configured_title')}
          </span>
        }
      >
        {!credsVisible ? (
          <EmptyState
            title={t('sms_service.configured_locked')}
            description={t('sms_service.configured_locked_desc')}
          />
        ) : !view.accountPresent && !view.cookiePresent ? (
          <EmptyState
            title={t('sms_service.configured_empty')}
            description={t('sms_service.configured_empty_desc')}
            action={
              <button
                type="button"
                className={styles.actionPill}
                onClick={() => setModalOpen(true)}
              >
                <IconPlus size={14} />
                {t('sms_service.configure_add')}
              </button>
            }
          />
        ) : (
          <div className={styles.platformRows}>
            <div className={styles.platformRow}>
              <span
                className={`${styles.healthDot} ${
                  view.connection === 'connected' ? styles.healthGood : styles.healthCritical
                }`}
                aria-hidden="true"
              />
              <span className={styles.platformRowText}>
                <span className={styles.platformRowName}>
                  {t('sms_service.platform_haozhuma')}
                  <span
                    className={`${styles.tag} ${
                      view.connection === 'connected' ? styles.tagGood : styles.tagMuted
                    }`}
                  >
                    {statusLabel}
                  </span>
                </span>
                <span className={styles.platformRowMeta}>
                  <span className={view.accountPresent ? styles.metaOk : styles.metaMuted}>
                    {t('sms_service.cred_account')}·{view.accountPresent ? '✓' : '—'}
                  </span>
                  <span className={styles.ledgerDot} aria-hidden="true" />
                  <span className={view.cookiePresent ? styles.metaOk : styles.metaMuted}>
                    {t('sms_service.cred_cookie')}·{view.cookiePresent ? '✓' : '—'}
                  </span>
                  {view.connectionReason && (
                    <>
                      <span className={styles.ledgerDot} aria-hidden="true" />
                      <span className={styles.metaMuted}>{view.connectionReason}</span>
                    </>
                  )}
                </span>
              </span>
              <div className={styles.platformRowActions}>
                <button
                  type="button"
                  className={styles.actionPill}
                  onClick={() => setModalOpen(true)}
                >
                  {t('sms_service.configure_edit')}
                </button>
              </div>
            </div>
          </div>
        )}
      </Card>

      <div className={styles.statusBar}>
        <div className={styles.statPill}>
          <span className={styles.statLabel}>{t('sms_service.stat_balance')}</span>
          <span className={styles.statValue}>
            {view.balanceCny === null || !credsVisible ? '—' : formatCny(view.balanceCny)}
          </span>
        </div>
        <div className={styles.statPill}>
          <span className={styles.statLabel}>{t('sms_service.stat_session_spend')}</span>
          <span className={styles.statValue}>
            {view.loaded ? formatCny(view.spentCny) : '—'}
          </span>
        </div>
        <div className={styles.statPill}>
          <span className={styles.statLabel}>{t('sms_service.stat_price_ceiling')}</span>
          <span className={styles.statValue}>
            {view.ceilingCny > 0 ? formatCny(view.ceilingCny) : '—'}
          </span>
        </div>
        <div className={styles.statPill}>
          <span className={styles.statLabel}>{t('sms_service.stat_channels')}</span>
          <span className={styles.statValue}>
            {view.loaded ? (
              <>
                {availableChannels}
                <span className={styles.statLabel}> / {channels.length}</span>
              </>
            ) : (
              '—'
            )}
          </span>
        </div>
      </div>

      <div className={styles.grid}>
        {/* 左栏（宽）：取号渠道表 + 号码账本 */}
        <div className={styles.column}>
          <Card
            title={
              <span className={styles.cardTitle}>
                <IconDollarSign size={17} />
                {t('sms_service.channels_title')}
              </span>
            }
            extra={
              // 上限没配置就**不说**「几个超标」——没有上限就没有超标，说「N 个高于 ¥0.00」
              // 是拿一个不存在的门槛当读数。
              view.ceilingCny > 0 ? (
                <span className={styles.statLabel}>
                  {t('sms_service.channels_extra', {
                    count: overCeiling.length,
                    ceiling: formatCny(view.ceilingCny),
                  })}
                </span>
              ) : null
            }
          >
            {channels.length === 0 ? (
              <EmptyState
                title={t('sms_service.channels_empty')}
                description={t('sms_service.channels_empty_desc')}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('sms_service.col_channel')}</TableHead>
                    <TableHead>{t('sms_service.col_price')}</TableHead>
                    <TableHead>{t('sms_service.col_stock')}</TableHead>
                    <TableHead alignRight aria-label={t('sms_service.col_actions')} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {channels.map((channel) => (
                    <TableRow key={channel.id} className={channel.paused ? styles.rowMuted : undefined}>
                      <TableCell>
                        <span className={styles.channelName} title={channel.detail || channel.name}>
                          <span
                            className={`${styles.healthDot} ${healthClass[channel.health]}`}
                            aria-hidden="true"
                          />
                          {channel.name}
                          {channel.paused && (
                            <span className={`${styles.tag} ${styles.tagMuted}`}>
                              {t('sms_service.paused')}
                            </span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className={styles.mono}>{formatCny(channel.priceCny)}</TableCell>
                      <TableCell className={styles.mono}>{channel.stock}</TableCell>
                      <TableCell>
                        <div className={styles.channelActions}>
                          <button
                            type="button"
                            className={styles.actionPill}
                            onClick={() => void toggleChannel(channel)}
                            disabled={
                              channelBusy === channel.id ||
                              gatePhase === 'locked' ||
                              !view.cookiePresent
                            }
                            title={
                              view.cookiePresent ? undefined : t('sms_service.action_need_session')
                            }
                          >
                            {channelBusy === channel.id
                              ? t('sms_service.action_working')
                              : channel.paused
                                ? t('sms_service.action_recover')
                                : t('sms_service.action_pause')}
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          <Card
            title={
              <span className={styles.cardTitle}>
                <IconTimer size={17} />
                {t('sms_service.ledger_title')}
              </span>
            }
            extra={
              <span className={styles.statLabel}>
                {t('sms_service.ledger_extra', { count: view.ledger.length })}
              </span>
            }
          >
            {view.ledger.length === 0 ? (
              <EmptyState
                title={t('sms_service.ledger_empty')}
                description={t('sms_service.ledger_empty_desc')}
              />
            ) : (
              <div className={styles.ledger}>
                {view.ledger.map((entry) => (
                  <div key={`${entry.phone}@${entry.takenAt ?? ''}`} className={styles.ledgerRow}>
                    <span className={styles.ledgerPhone}>{entry.phone}</span>
                    <span className={`${styles.tag} ${ledgerStatusClass[entry.status]}`}>
                      {t(`sms_service.ledger_status_${entry.status}`)}
                    </span>
                    <span className={styles.ledgerMeta}>
                      <span>{entry.account}</span>
                      {entry.target && (
                        <>
                          <span className={styles.ledgerDot} aria-hidden="true" />
                          <span className={styles.tag}>{entry.target}</span>
                        </>
                      )}
                      <span className={styles.ledgerDot} aria-hidden="true" />
                      <span>{entry.channel}</span>
                      {entry.costCny !== null && (
                        <>
                          <span className={styles.ledgerDot} aria-hidden="true" />
                          <span className={styles.mono}>{formatCny(entry.costCny)}</span>
                        </>
                      )}
                      {entry.takenAt !== null && (
                        <>
                          <span className={styles.ledgerDot} aria-hidden="true" />
                          <span>{formatDateTimeValue(entry.takenAt)}</span>
                        </>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* 右栏（窄）：护栏 + 推荐渠道 */}
        <div className={styles.column}>
          <Card
            title={
              <span className={styles.cardTitle}>
                <IconShield size={17} />
                {t('sms_service.guardrail_title')}
              </span>
            }
          >
            <div className={styles.guardrailRow}>
              <div className={styles.guardrailText}>
                <div className={styles.guardrailLabel}>{t('sms_service.guardrail_switch')}</div>
                <div className={styles.guardrailHint}>{t('sms_service.guardrail_switch_hint')}</div>
              </div>
              <button
                type="button"
                className={styles.actionPill}
                onClick={() => void runGuardrail()}
                disabled={gatePhase === 'locked' || !view.cookiePresent || guardrailBusy}
                title={view.cookiePresent ? undefined : t('sms_service.action_need_session')}
              >
                {guardrailBusy ? t('sms_service.action_working') : t('sms_service.guardrail_apply')}
              </button>
            </div>

            <div className={styles.guardrailRow}>
              <div className={styles.guardrailText}>
                <div className={styles.guardrailLabel}>{t('sms_service.guardrail_budget')}</div>
                <div className={styles.guardrailHint}>
                  {/* 上限 / 累计额度是配置读数：还没读到就显示「—」，不把空态的 0 当成 ¥0.00。 */}
                  {view.loaded
                    ? t('sms_service.guardrail_ceiling_hint', {
                        ceiling: view.ceilingCny > 0 ? formatCny(view.ceilingCny) : '—',
                        total: view.maxTotalCny > 0 ? formatCny(view.maxTotalCny) : '—',
                      })
                    : t('sms_service.guardrail_ceiling_hint', { ceiling: '—', total: '—' })}
                </div>
              </div>
              {/* 颜色只在**确有累计上限**时给：没有上限就没有「用了多少 / 超没超」可言，
                  给个绿/黄反而是拿不存在的门槛当判据。 */}
              <span
                className={`${styles.statValue} ${
                  capConfigured
                    ? view.spentCny >= view.maxTotalCny
                      ? styles.statValueWarn
                      : styles.statValueGood
                    : ''
                }`}
              >
                {t('sms_service.guardrail_budget_value', {
                  spent: view.loaded ? formatCny(view.spentCny) : '—',
                  total: capConfigured ? formatCny(view.maxTotalCny) : '—',
                })}
              </span>
            </div>

            {cheapestChannel && (
              <div className={styles.recommendBox}>
                <div className={styles.recommendLabel}>{t('sms_service.recommend_label')}</div>
                <div className={styles.recommendValue}>
                  <span className={styles.recommendName}>{cheapestChannel.name}</span>
                  <span className={styles.recommendPrice}>
                    {formatCny(cheapestChannel.priceCny)}
                  </span>
                </div>
                <div className={styles.recommendHint}>
                  {/* 「暂停 N 个就能省钱」只在真有超标渠道时才是句实话。 */}
                  {overCeiling.length > 0
                    ? t('sms_service.recommend_saving', {
                        stock: cheapestChannel.stock,
                        count: overCeiling.length,
                      })
                    : t('sms_service.recommend_stock', { stock: cheapestChannel.stock })}
                </div>
              </div>
            )}
          </Card>

          <Card
            title={
              <span className={styles.cardTitle}>
                <IconCheckCircle2 size={17} />
                {t('sms_service.tips_title')}
              </span>
            }
          >
            <ul className={styles.list}>
              <li>{t('sms_service.tip_selection')}</li>
              <li>{t('sms_service.tip_guardrail')}</li>
              <li>{t('sms_service.tip_ledger')}</li>
            </ul>
          </Card>
        </div>
      </div>

      <div className={styles.statLabel}>
        {t('sms_service.updated_at', { time: formatDateTimeValue(view.updatedAt) })}
        {loading ? ` · ${t('sms_service.loading')}` : ''}
      </div>

      <ChannelConfigModal
        open={modalOpen}
        existing={{
          accountPresent: view.accountPresent,
          cookiePresent: view.cookiePresent,
          webPresent: view.webPresent,
          apiUserHint: view.apiUserHint,
          webUserHint: view.webUserHint,
        }}
        onClose={() => setModalOpen(false)}
        onSaved={() => {
          void loadStatus();
        }}
      />
    </div>
  );
}
