/**
 * 接码服务页：聚合渠道的配置与运行总览。
 *
 * 数据来源：插件 `/sms/status` —— 凭据是否已配、余额（真实联网）、渠道列表与账本。
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
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  IconAlertTriangle,
  IconCheckCircle2,
  IconDollarSign,
  IconPlus,
  IconSettings,
  IconShield,
  IconTimer,
} from '@/components/ui/icons';
import { smsApi } from '@/services/api/sms';
import { useAuthStore } from '@/stores/useAuthStore';
import { useSecretGateStore } from '@/stores/useSecretGateStore';
import { formatDateTimeValue } from '@/utils/format';
import { ChannelConfigModal } from './ChannelConfigModal';
import { EMPTY_SMS_STATUS, toChannel, toLedger } from './smsMapping';
import type {
  ChannelHealth,
  PhoneLedgerEntry,
  PlatformCredentials,
  SmsChannel,
  SmsStatus,
} from './types';
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

export function SmsServicePage() {
  const { t } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const gatePhase = useSecretGateStore((state) => state.phase);

  // 起步就是真实空态；后端返回什么就显示什么，不拿假数据兜底。
  const [status, setStatus] = useState<SmsStatus>(EMPTY_SMS_STATUS);
  const [creds, setCreds] = useState<PlatformCredentials | null>(null);
  const [storeLocked, setStoreLocked] = useState(false);
  const [webPresent, setWebPresent] = useState(false);
  const [userHints, setUserHints] = useState({ apiUser: '', webUser: '' });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [channelBusy, setChannelBusy] = useState<string | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [guardrailBusy, setGuardrailBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    if (!apiBase) return;
    setLoading(true);
    setLoadError(null);
    try {
      const raw = await smsApi.getStatus(apiBase);
      // While the store is locked the plugin cannot read the credential names, so
      // api_present/cookie_present come back false even though they exist. Keep
      // that distinct from "nothing configured", or the page would claim the
      // operator never configured anything.
      const storeLocked = raw.store_available === false;
      const accountPresent = raw.api_present === true;
      const cookiePresent = raw.cookie_present === true;
      const webPresent = raw.web_present === true;
      let statusKind: PlatformCredentials['status'] = 'unchecked';
      let statusReason: string | undefined;
      if (storeLocked) {
        statusKind = 'unavailable';
        statusReason = raw.error;
      } else if (typeof raw.balance_cny === 'number') {
        statusKind = 'connected';
      } else if (raw.status === 'unavailable') {
        statusKind = 'unavailable';
        statusReason = raw.error;
      } else if (raw.balance_error) {
        statusKind = 'failed';
        statusReason = raw.balance_error;
      }
      // 上限既用来推渠道健康点，也是页面上的「单价上限」读数：同一个值只取一次。
      const ceilingCny = raw.budget?.max_per_number_cny ?? 0;
      const channels = Array.isArray(raw.channels)
        ? raw.channels.map((channel) => toChannel(channel, ceilingCny))
        : [];
      const ledger = Array.isArray(raw.ledger) ? raw.ledger.map(toLedger) : [];
      setStoreLocked(storeLocked);
      setWebPresent(webPresent);
      setUserHints({
        apiUser: raw.api_user_hint ?? '',
        webUser: raw.web_user_hint ?? '',
      });
      setCreds({
        platformId: 'haozhuma',
        platformName: '豪猪接码',
        account: { account: '', endpoint: '', present: accountPresent },
        session: { cookie: '', present: cookiePresent },
        status: statusKind,
        statusReason,
      });
      // 渠道 / 账本 / 花费是平台记录，与凭据无关，照实显示。
      // 只有**凭据相关**读数在锁定时不可读：余额置空（而非沿用旧值）。
      setStatus({
        enabled: raw.enabled === true,
        balanceCny: !storeLocked && typeof raw.balance_cny === 'number' ? raw.balance_cny : null,
        balanceError: raw.balance_error,
        sessionSpendCny: typeof raw.spent_cny === 'number' ? raw.spent_cny : 0,
        priceCeilingCny: ceilingCny,
        maxTotalCny: raw.budget?.max_total_cny ?? 0,
        availableChannels: channels.filter((c) => !c.paused && c.stock > 0).length,
        totalChannels: channels.length,
        channels,
        ledger,
        updatedAt:
          typeof raw.channels_updated_at === 'number' && raw.channels_updated_at > 0
            ? new Date(raw.channels_updated_at * 1000).toISOString()
            : '',
      });
    } catch (error) {
      setLoadError((error as { message?: string })?.message ?? 'failed to load SMS status');
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

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
        const result = await smsApi.setChannel(apiBase, channel.id, !channel.paused);
        if (!result.ok) {
          setChannelError(result.message);
          return;
        }
        setStatus((prev) => ({
          ...prev,
          channels: result.channels.map((channel) => toChannel(channel, prev.priceCeilingCny)),
          availableChannels: result.channels.filter((c) => c.paused !== true && c.stock > 0).length,
          totalChannels: result.channels.length,
        }));
      } catch (error) {
        setChannelError((error as { message?: string })?.message ?? 'failed to switch the channel');
      } finally {
        setChannelBusy(null);
      }
    },
    [apiBase]
  );

  const channels: SmsChannel[] = status.channels;

  /** 省钱护栏：把超上限 / 无货的渠道暂停，把可用的恢复（真实写平台）。 */
  const runGuardrail = useCallback(async () => {
    setGuardrailBusy(true);
    setChannelError(null);
    try {
      const result = await smsApi.runGuardrail(apiBase);
      if (!result.ok) {
        setChannelError(result.message);
        return;
      }
      setStatus((prev) => ({
        ...prev,
        channels: result.channels.map((channel) => toChannel(channel, prev.priceCeilingCny)),
        availableChannels: result.channels.filter((c) => c.paused !== true && c.stock > 0).length,
        totalChannels: result.channels.length,
      }));
    } catch (error) {
      setChannelError((error as { message?: string })?.message ?? 'failed to apply the guardrail');
    } finally {
      setGuardrailBusy(false);
    }
  }, [apiBase]);

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

  const overCeiling = useMemo(
    () =>
      channels.filter((channel) => !channel.paused && channel.priceCny > status.priceCeilingCny),
    [channels, status.priceCeilingCny]
  );

  // 凭据可见的**唯一**判据：本会话验证过主密码（gate unlocked），且后端密钥库确实已解锁。
  // 二者缺一都不可见 —— 否则「跳过验证但后端先前已解锁」会让页面把凭据露出来。
  const credsVisible = gatePhase === 'unlocked' && !storeLocked;

  // 页头状态词只在**能确认**时给；凭据不可见时不猜，交给顶部那条主密码提示。
  const headerStatus = (() => {
    if (!credsVisible) return null;
    // `enabled` 是后端的真实开关（sms_provider 已配置）；未配置时先报「未配置」。
    if (!creds?.account.present) {
      return { label: t('sms_service.status_not_configured'), ok: false };
    }
    if (!status.enabled) return { label: t('sms_service.status_disabled'), ok: false };
    switch (creds.status) {
      case 'connected':
        return { label: t('sms_service.status_connected'), ok: true };
      case 'failed':
        return { label: t('sms_service.status_failed'), ok: false };
      default:
        return { label: t('sms_service.status_unknown'), ok: false };
    }
  })();

  const statusLabel = (() => {
    if (!creds) return t('sms_service.status_unknown');
    switch (creds.status) {
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
        <div className={styles.headerCopy}>
          <h1 className={styles.title}>{t('sms_service.title')}</h1>
          <p className={styles.meta}>
            {headerStatus && (
              <>
                <span className={headerStatus.ok ? styles.metaOk : styles.metaMuted}>
                  {headerStatus.label}
                </span>
                <span className={styles.metaDot}>·</span>
              </>
            )}
            <span className={styles.metaMuted}>
              {t('sms_service.header_channels', { count: status.availableChannels })}
            </span>
          </p>
        </div>
        <div className={styles.headerActions}>
          <button type="button" className={styles.ghostAction} onClick={() => setModalOpen(true)}>
            <IconSettings size={14} />
            {t('sms_service.configure_channels')}
          </button>
        </div>
      </header>

      {loadError && (
        <div className={styles.previewNotice} role="alert">
          <IconAlertTriangle size={15} />
          <span>{t('sms_service.load_error', { message: loadError })}</span>
        </div>
      )}
      {channelError && (
        <div className={styles.previewNotice} role="alert">
          <IconAlertTriangle size={15} />
          <span>{t('sms_service.channel_error', { message: channelError })}</span>
        </div>
      )}

      {/* 已配置渠道：L3（两张凭据表 + 真实连接状态）。 */}
      <Card
        title={
          <span className={styles.cardTitle}>
            <IconSettings size={17} />
            {t('sms_service.configured_title')}
          </span>
        }
        extra={
          <button type="button" className={styles.ghostAction} onClick={() => setModalOpen(true)}>
            <IconPlus size={14} />
            {t('sms_service.configure_add')}
          </button>
        }
      >
        {!credsVisible ? (
          <EmptyState
            title={t('sms_service.configured_locked')}
            description={t('sms_service.configured_locked_desc')}
          />
        ) : !creds || (!creds.account.present && !creds.session.present) ? (
          <EmptyState
            title={t('sms_service.configured_empty')}
            description={t('sms_service.configured_empty_desc')}
          />
        ) : (
          <div className={styles.platformRows}>
            <div className={styles.platformRow}>
              <span
                className={`${styles.healthDot} ${
                  creds.status === 'connected' ? styles.healthGood : styles.healthCritical
                }`}
                aria-hidden="true"
              />
              <span className={styles.platformRowText}>
                <span className={styles.platformRowName}>
                  {creds.platformName}
                  <span
                    className={`${styles.tag} ${
                      creds.status === 'connected' ? styles.tagGood : styles.tagMuted
                    }`}
                  >
                    {statusLabel}
                  </span>
                </span>
                <span className={styles.platformRowMeta}>
                  <span className={creds.account.present ? styles.metaOk : styles.metaMuted}>
                    {t('sms_service.cred_account')}·{creds.account.present ? '✓' : '—'}
                  </span>
                  <span className={styles.ledgerDot} aria-hidden="true" />
                  <span className={creds.session.present ? styles.metaOk : styles.metaMuted}>
                    {t('sms_service.cred_cookie')}·{creds.session.present ? '✓' : '—'}
                  </span>
                  {creds.statusReason && (
                    <>
                      <span className={styles.ledgerDot} aria-hidden="true" />
                      <span className={styles.metaMuted}>{creds.statusReason}</span>
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
            {status.balanceCny === null || !credsVisible ? '—' : formatCny(status.balanceCny)}
          </span>
        </div>
        <div className={styles.statPill}>
          <span className={styles.statLabel}>{t('sms_service.stat_session_spend')}</span>
          <span className={styles.statValue}>{formatCny(status.sessionSpendCny)}</span>
        </div>
        <div className={styles.statPill}>
          <span className={styles.statLabel}>{t('sms_service.stat_price_ceiling')}</span>
          <span className={styles.statValue}>
            {status.priceCeilingCny > 0 ? formatCny(status.priceCeilingCny) : '—'}
          </span>
        </div>
        <div className={styles.statPill}>
          <span className={styles.statLabel}>{t('sms_service.stat_channels')}</span>
          <span className={styles.statValue}>
            {status.availableChannels}
            <span className={styles.statLabel}> / {status.totalChannels}</span>
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
              <span className={styles.statLabel}>
                {t('sms_service.channels_extra', {
                  count: overCeiling.length,
                  ceiling: formatCny(status.priceCeilingCny),
                })}
              </span>
            }
          >
            {channels.length === 0 ? (
              <EmptyState
                title={t('sms_service.channels_empty')}
                description={t('sms_service.channels_empty_desc')}
              />
            ) : (
              <table className={styles.channelTable}>
                <thead>
                  <tr>
                    <th>{t('sms_service.col_channel')}</th>
                    <th>{t('sms_service.col_price')}</th>
                    <th>{t('sms_service.col_stock')}</th>
                    <th aria-label={t('sms_service.col_actions')} />
                  </tr>
                </thead>
                <tbody>
                  {channels.map((channel) => (
                    <tr key={channel.id} className={channel.paused ? styles.rowMuted : undefined}>
                      <td>
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
                      </td>
                      <td className={styles.mono}>{formatCny(channel.priceCny)}</td>
                      <td className={styles.mono}>{channel.stock}</td>
                      <td>
                        <div className={styles.channelActions}>
                          <button
                            type="button"
                            className={styles.actionPill}
                            onClick={() => void toggleChannel(channel)}
                            disabled={
                              channelBusy === channel.id ||
                              gatePhase === 'locked' ||
                              !creds?.session.present
                            }
                            title={
                              creds?.session.present
                                ? undefined
                                : t('sms_service.action_need_session')
                            }
                          >
                            {channelBusy === channel.id
                              ? t('sms_service.action_working')
                              : channel.paused
                                ? t('sms_service.action_recover')
                                : t('sms_service.action_pause')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                {t('sms_service.ledger_extra', { count: status.ledger.length })}
              </span>
            }
          >
            {status.ledger.length === 0 ? (
              <EmptyState
                title={t('sms_service.ledger_empty')}
                description={t('sms_service.ledger_empty_desc')}
              />
            ) : (
              <div className={styles.ledger}>
                {status.ledger.map((entry) => (
                  <div key={`${entry.phone}@${entry.takenAt ?? ''}`} className={styles.ledgerRow}>
                    <span className={styles.ledgerPhone}>{entry.phone}</span>
                    <span className={`${styles.tag} ${ledgerStatusClass[entry.status]}`}>
                      {t(`sms_service.ledger_status_${entry.status}`)}
                    </span>
                    <span className={styles.ledgerMeta}>
                      <span>{entry.account}</span>
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
                disabled={gatePhase === 'locked' || !creds?.session.present || guardrailBusy}
                title={creds?.session.present ? undefined : t('sms_service.action_need_session')}
              >
                {guardrailBusy ? t('sms_service.action_working') : t('sms_service.guardrail_apply')}
              </button>
            </div>

            <div className={styles.guardrailRow}>
              <div className={styles.guardrailText}>
                <div className={styles.guardrailLabel}>{t('sms_service.guardrail_auto_bind')}</div>
                <div className={styles.guardrailHint}>
                  {t('sms_service.guardrail_auto_bind_hint')}
                </div>
              </div>
            </div>

            <div className={styles.guardrailRow}>
              <div className={styles.guardrailText}>
                <div className={styles.guardrailLabel}>{t('sms_service.guardrail_budget')}</div>
                <div className={styles.guardrailHint}>
                  {t('sms_service.guardrail_ceiling_hint', {
                    ceiling: formatCny(status.priceCeilingCny),
                    total: formatCny(status.maxTotalCny),
                  })}
                </div>
              </div>
              <span
                className={`${styles.statValue} ${
                  status.sessionSpendCny >= status.maxTotalCny
                    ? styles.statValueWarn
                    : styles.statValueGood
                }`}
              >
                {t('sms_service.guardrail_budget_value', {
                  spent: formatCny(status.sessionSpendCny),
                  total: formatCny(status.maxTotalCny),
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
                  {t('sms_service.recommend_hint', {
                    stock: cheapestChannel.stock,
                    count: overCeiling.length,
                  })}
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
        {t('sms_service.updated_at', { time: formatDateTimeValue(status.updatedAt) })}
        {loading ? ` · ${t('sms_service.loading')}` : ''}
      </div>

      <ChannelConfigModal
        open={modalOpen}
        existing={
          creds
            ? {
                accountPresent: creds.account.present,
                cookiePresent: creds.session.present,
                webPresent,
                apiUserHint: userHints.apiUser,
                webUserHint: userHints.webUser,
              }
            : null
        }
        onClose={() => setModalOpen(false)}
        onSaved={() => {
          void loadStatus();
        }}
      />
    </div>
  );
}
