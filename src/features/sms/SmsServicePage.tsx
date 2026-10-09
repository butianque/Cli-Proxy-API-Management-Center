/**
 * 接码服务页：取号渠道与号码账本的总览。
 *
 * ⚠️ 第一版为**结构预览**：数据来自 ./mockData.ts，不发起任何真实请求。
 * 接入真实数据时，把 `getMockSmsStatus()` 换成 src/services/api/sms.ts 的调用，
 * 其余渲染逻辑不变（组件只消费 ./types.ts 的领域类型）。
 *
 * 版面约定（遵循仓库 UI 原则）：
 * - 视觉与指标靠拢：渠道健康点 + 单价 + 库存同排一行，扫一眼即知好坏；
 * - 颜色只由数据推导（健康度 / 上限），不做纯装饰色块；
 * - 护栏是「省钱的唯一手段」，与推荐渠道联动展示。
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconAlertTriangle,
  IconCheckCircle2,
  IconDollarSign,
  IconRefreshCw,
  IconShield,
  IconTimer,
} from '@/components/ui/icons';
import { formatDateTimeValue } from '@/utils/format';
import { getMockSmsStatus } from './mockData';
import type { ChannelHealth, PhoneLedgerEntry, SmsChannel } from './types';
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
  // 第一版：同步取用占位数据。真实接入后改为 useState + 异步加载。
  const status = useMemo(() => getMockSmsStatus(), []);

  const cheapestChannel = useMemo(
    () =>
      status.channels
        .filter((channel) => !channel.paused && channel.stock > 0)
        .reduce<SmsChannel | null>(
          (best, channel) => (best === null || channel.priceCny < best.priceCny ? channel : best),
          null
        ),
    [status.channels]
  );

  const overCeiling = useMemo(
    () =>
      status.channels.filter(
        (channel) => !channel.paused && channel.priceCny > status.priceCeilingCny
      ),
    [status.channels, status.priceCeilingCny]
  );

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div className={styles.headerText}>
          <h1 className={styles.title}>{t('sms_service.title')}</h1>
          <p className={styles.description}>{t('sms_service.description')}</p>
        </div>
        <div className={styles.headerActions}>
          <Button variant="secondary" size="sm" disabled>
            <IconRefreshCw size={15} />
            {t('sms_service.refresh')}
          </Button>
        </div>
      </div>

      <div className={styles.previewNotice} role="note">
        <IconAlertTriangle size={15} />
        <span>{t('sms_service.preview_notice')}</span>
      </div>

      <div className={styles.statusBar}>
        <div className={styles.statPill}>
          <span className={styles.statLabel}>{t('sms_service.stat_status')}</span>
          <span
            className={`${styles.statValue} ${
              status.enabled ? styles.statValueGood : styles.statValueWarn
            }`}
          >
            {status.enabled ? t('sms_service.enabled') : t('sms_service.disabled')}
          </span>
        </div>
        <div className={styles.statPill}>
          <span className={styles.statLabel}>{t('sms_service.stat_unlock')}</span>
          <span className={styles.statValue}>
            {status.unlocked ? t('sms_service.unlocked') : t('sms_service.locked')}
          </span>
        </div>
        <div className={styles.statPill}>
          <span className={styles.statLabel}>{t('sms_service.stat_balance')}</span>
          <span className={styles.statValue}>{formatCny(status.balanceCny)}</span>
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
        {/* 左栏（宽）：渠道表 —— 取号供给的主视图 */}
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
            {status.channels.length === 0 ? (
              <EmptyState title={t('sms_service.channels_empty')} />
            ) : (
              <table className={styles.channelTable}>
                <thead>
                  <tr>
                    <th>{t('sms_service.col_channel')}</th>
                    <th>{t('sms_service.col_price')}</th>
                    <th>{t('sms_service.col_stock')}</th>
                    <th>{t('sms_service.col_used')}</th>
                    <th aria-label={t('sms_service.col_actions')} />
                  </tr>
                </thead>
                <tbody>
                  {status.channels.map((channel) => (
                    <tr key={channel.id} className={channel.paused ? styles.rowMuted : undefined}>
                      <td>
                        <span className={styles.channelName}>
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
                      <td className={styles.mono}>{channel.usedCount}</td>
                      <td>
                        <div className={styles.channelActions}>
                          <button type="button" className={styles.actionPill} disabled>
                            {channel.paused
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

          {/* 号码账本：哪个账号用了哪个号码 */}
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
                      <span className={styles.ledgerDot} aria-hidden="true" />
                      <span className={styles.mono}>{formatCny(entry.costCny)}</span>
                      <span className={styles.ledgerDot} aria-hidden="true" />
                      <span>{formatDateTimeValue(entry.takenAt)}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* 右栏（窄）：护栏 + 推荐渠道 —— 省钱的唯一手段 */}
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
              <ToggleSwitch checked={status.guardrail} onChange={() => undefined} disabled />
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
      </div>
    </div>
  );
}
