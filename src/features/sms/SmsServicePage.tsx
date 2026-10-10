/**
 * 接码服务页：聚合渠道的配置与运行总览。
 *
 * 数据来源（本轮）：
 * - **真实**：插件 `/sms/status` → 凭据是否已配（账密表 / CK 表）、主密码状态、
 *   余额（真实联网）、渠道列表与账本（后端返回，若有）；
 * - **占位**：渠道表 / 号码账本在字段缺失时回退到 ./mockData.ts（下一轮接线）。
 *
 * 版面约定（遵循仓库 UI 原则 + 对齐 `ConfigHeader` 语汇）：
 * - 页头与「配置面板」同范式：`align-items: flex-end` 两端对齐 + `▍` mono meta + ghost 药丸按钮；
 * - 页头主开关负责服务启停，未配置渠道时禁用并引导去配置；
 * - 视觉与指标靠拢：渠道健康点 + 单价 + 库存同排一行，扫一眼即知好坏；
 * - 颜色只由数据推导（健康度 / 上限 / 门是否锁定），不做纯装饰色块。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
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
import type { SmsChannelWire, SmsLedgerWire } from '@/services/api/sms';
import { useAuthStore } from '@/stores/useAuthStore';
import { useSecretGateStore } from '@/stores/useSecretGateStore';
import { formatDateTimeValue } from '@/utils/format';
import { getMockSmsStatus } from './mockData';
import { ChannelConfigModal } from './ChannelConfigModal';
import type { ChannelHealth, PhoneLedgerEntry, PlatformCredentials, SmsChannel } from './types';
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

/**
 * 后端渠道行 → 页面领域类型。
 *
 * 健康度由可得的事实推导（暂停 / 是否有货 / 相对价格），不做纯装饰着色：
 * 暂停=critical、无货=warning、其余按价格分档。
 *
 * 渠道名不直接照搬平台的「[项目]讯飞」——同项目的多个渠道会全部同名、无法区分。
 * 改用该渠道真实抽取的运营商与号段（后端 `carriers`/`paragraphs`），
 * 这两个字段与平台无关，也真正说明「这条渠道能拿到什么号」。
 */
function toChannel(raw: SmsChannelWire): SmsChannel {
  const paused = raw.paused === true;
  const stock = Number.isFinite(raw.stock) ? raw.stock : 0;
  const health: ChannelHealth = paused
    ? 'critical'
    : stock <= 0
      ? 'warning'
      : raw.price <= 0.3
        ? 'good'
        : 'warning';
  const label = channelLabel(raw);
  return {
    id: raw.uid,
    name: label.name,
    detail: label.detail,
    priceCny: Number.isFinite(raw.price) ? raw.price : 0,
    stock,
    paused,
    health,
  };
}

/**
 * Builds a short, distinguishable label plus a full description.
 *
 * The platform's own label is the project name ("[21614]讯飞"), which every
 * channel of a project shares — useless for telling channels apart. The
 * carriers and number prefixes are real per-channel facts, so the name shows the
 * carriers and the detail adds the prefixes; a long prefix list is truncated in
 * the name and available in full on hover.
 */
function channelLabel(raw: SmsChannelWire): { name: string; detail: string } {
  const carriers = splitList(raw.carriers);
  const paragraphs = splitList(raw.paragraphs);
  const carriersText = carriers.length > 0 ? carriers.join('/') : '';
  const paragraphsText = paragraphs.length > 0 ? paragraphs.join('/') : '';
  const detail = [
    carriersText,
    paragraphsText ? `号段 ${paragraphsText}` : '',
  ]
    .filter((part) => part !== '')
    .join(' · ');
  if (detail === '') {
    const fallback = (raw.name ?? '').trim() || raw.uid;
    return { name: fallback, detail: fallback };
  }
  const prefix = paragraphsText
    ? `号段 ${truncateList(paragraphs, 2)}${paragraphs.length > 2 ? '…' : ''}`
    : '';
  const name = [carriersText, prefix]
    .filter((part) => part !== '')
    .join(' · ');
  return { name, detail };
}

/** 列表超过 `max` 项时只留前 `max` 项，其余交给悬停详情。 */
function truncateList(items: string[], max: number): string {
  if (items.length <= max) return items.join('/');
  return items.slice(0, max).join('/');
}

/** 平台把运营商/号段用 `|` 分隔并留空尾，这里切成干净的列表。 */
function splitList(value?: string): string[] {
  if (!value) return [];
  return value
    .split('|')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** 后端账本行 → 页面领域类型（后端只记「租过」，成不成注册看账号绑定）。 */
function toLedger(raw: SmsLedgerWire): PhoneLedgerEntry {
  const used = typeof raw.last_used === 'number' ? raw.last_used : 0;
  return {
    phone: raw.phone,
    account: raw.account ?? '',
    channel: raw.sid ?? '',
    // 后端不记录每次租用的实际支出，只有累计花费；这里不编造单条成本。
    costCny: null,
    status: raw.account ? 'registered' : 'pending',
    takenAt: used > 0 ? new Date(used * 1000).toISOString() : new Date().toISOString(),
  };
}

export function SmsServicePage() {
  const { t } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const gatePhase = useSecretGateStore((state) => state.phase);

  // 渠道表 / 账本：本轮仍为占位（真实字段缺失时回退）。
  const mock = useMemo(() => getMockSmsStatus(), []);
  const [status, setStatus] = useState(mock);
  const [creds, setCreds] = useState<PlatformCredentials | null>(null);
  const [storeLocked, setStoreLocked] = useState(false);
  const [webPresent, setWebPresent] = useState(false);
  const [userHints, setUserHints] = useState({ apiUser: '', webUser: '' });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
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
      // api_present/cookie_present come back false even though they exist. Report
      // that as "locked" instead of "not configured", or the page would imply the
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
      // 真实余额 / 花费 / 护栏（有就用真实的，没有保留占位量级）。
      // 锁定时不回显余额：加密数据不可访问期间不应泄露任何凭据相关读数。
      setStatus((prev) => ({
        ...prev,
        balanceCny:
          !storeLocked && typeof raw.balance_cny === 'number' ? raw.balance_cny : prev.balanceCny,
        balanceError: raw.balance_error,
        sessionSpendCny: typeof raw.spent_cny === 'number' ? raw.spent_cny : prev.sessionSpendCny,
        priceCeilingCny: raw.budget?.max_per_number_cny ?? prev.priceCeilingCny,
        maxTotalCny: raw.budget?.max_total_cny ?? prev.maxTotalCny,
        // 渠道 / 账本接真实后端：后端返回了就用真实的，没返回才保留占位。
        channels: Array.isArray(raw.channels)
          ? raw.channels.map(toChannel)
          : prev.channels,
        ledger: Array.isArray(raw.ledger) ? raw.ledger.map(toLedger) : prev.ledger,
        availableChannels:
          Array.isArray(raw.channels) && raw.channels.length > 0
            ? raw.channels.filter((c) => c.paused !== true && c.stock > 0).length
            : prev.availableChannels,
        totalChannels:
          Array.isArray(raw.channels) && raw.channels.length > 0
            ? raw.channels.length
            : prev.totalChannels,
        updatedAt:
          typeof raw.channels_updated_at === 'number' && raw.channels_updated_at > 0
            ? new Date(raw.channels_updated_at * 1000).toISOString()
            : prev.updatedAt,
      }));
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
          channels: result.channels.map(toChannel),
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
        channels: result.channels.map(toChannel),
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

  const anyCredential = Boolean(creds?.account.present || creds?.session.present);
  // 锁定（门或密钥库）时凭据不可读，不能据此判定「未配置」或允许启动。
  const locked = gatePhase === 'locked' || storeLocked;
  const canStart = anyCredential && !storeLocked;

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
            <span className={running ? styles.metaOk : styles.metaMuted}>
              {running ? t('sms_service.header_running') : t('sms_service.header_stopped')}
            </span>
            <span className={styles.metaDot}>·</span>
            <span className={styles.metaMuted}>
              {t('sms_service.header_platforms', { count: creds ? 1 : 0 })}
            </span>
            <span className={styles.metaDot}>·</span>
            <span className={styles.metaMuted}>
              {t('sms_service.header_channels', { count: status.availableChannels })}
            </span>
          </p>
        </div>
        <div className={styles.headerActions}>
          <ToggleSwitch
            checked={running}
            onChange={setRunning}
            disabled={!canStart}
            labelPosition="left"
            label={t('sms_service.service_switch')}
            ariaLabel={t('sms_service.service_switch')}
          />
          <button type="button" className={styles.ghostAction} onClick={() => setModalOpen(true)}>
            <IconSettings size={14} />
            {t('sms_service.configure_channels')}
          </button>
        </div>
      </header>

      {locked && (
        <div className={styles.previewNotice} role="note">
          <IconAlertTriangle size={15} />
          <span>{t('sms_service.locked_notice')}</span>
        </div>
      )}
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
        {storeLocked ? (
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
            {status.balanceCny === null || locked ? '—' : formatCny(status.balanceCny)}
          </span>
        </div>
        <div className={styles.statPill}>
          <span className={styles.statLabel}>{t('sms_service.stat_session_spend')}</span>
          <span className={styles.statValue}>{formatCny(status.sessionSpendCny)}</span>
        </div>
        <div className={styles.statPill}>
          <span className={styles.statLabel}>{t('sms_service.stat_price_ceiling')}</span>
          <span className={styles.statValue}>{formatCny(status.priceCeilingCny)}</span>
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
              <EmptyState title={t('sms_service.channels_empty')} />
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
                              channelBusy === channel.id || gatePhase === 'locked' || !creds?.session.present
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
              <EmptyState title={t('sms_service.ledger_empty')} />
            ) : (
              <div className={styles.ledger}>
                {status.ledger.map((entry) => (
                  <div key={`${entry.phone}@${entry.takenAt}`} className={styles.ledgerRow}>
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
                      <span className={styles.ledgerDot} aria-hidden="true" />
                      <span>{formatDateTimeValue(entry.takenAt)}</span>
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
              <ToggleSwitch checked onChange={() => undefined} disabled />
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
