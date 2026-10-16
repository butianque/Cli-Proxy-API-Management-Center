/**
 * 渠道池表：这一类**已配置的渠道**（手机号与邮箱共用的一张表）。
 *
 * 表头固定七列：名称 | 类别 | 连接方式 | 连接状态 | 启动开关 | 编辑 | 删除。
 * 每一格都来自真实数据 —— 名称 / 类别 / 连接方式读基座的渠道清单，连接状态由基座
 * **真发一次探活请求**得到，启动开关真写启用位，删除真删。没有一格是占位，也没有
 * 不能改变任何东西的假控件。
 *
 * 表只管「列出 + 改」：**添加**的入口由调用方给（页头那一个按钮），编辑的弹窗也由
 * 调用方给。表里不再放第二个「添加」入口 —— 它在有数据后就消失，只会让「去哪加」
 * 变成一个本来不存在的问题。
 *
 * 探活是**只读**的：进页面探一次，探不动就如实显示「未检查」，不把「探不了」说成
 * 「连不上」。
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
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { IconAlertTriangle, IconPencil, IconPlug, IconTrash2 } from '@/components/ui/icons';
import { supplyApi, type SupplyChannelInput } from '@/services/api/supply';
import { kindBlockInput } from './channelDraft';
import { toNatureOptions, toProbes, toSupplyChannels, CATEGORY_LABEL, NATURE_LABEL } from './smsMapping';
import type {
  SupplyChannel,
  SupplyKind,
  SupplyNature,
  SupplyNatureOption,
  SupplyProbeResult,
} from './types';
import styles from './SmsServicePage.module.scss';

export interface SupplyPoolTableProps {
  /** 这一类身份（手机号 / 邮箱）。 */
  kind: SupplyKind;
  /** 调用方保存成功后 +1，表据此重新拉一次。 */
  reloadKey?: number;
  onEdit: (channel: SupplyChannel) => void;
  /** 表每次拉到「哪种连接方式能服务哪种身份」后回传，调用方不必再拉一次同一份。 */
  onNatures?: (natures: SupplyNatureOption[]) => void;
}

export function SupplyPoolTable({ kind, reloadKey = 0, onEdit, onNatures }: SupplyPoolTableProps) {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<SupplyChannel[]>([]);
  const [probes, setProbes] = useState<SupplyProbeResult[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyId, setBusyId] = useState('');

  /** 探活：只读，不需要主密码。探不动就当作没探到（显示「未检查」）。 */
  const probe = useCallback(async (list: SupplyChannel[]) => {
    if (list.length === 0) {
      setProbes([]);
      return;
    }
    try {
      setProbes(toProbes(await supplyApi.probeChannels(list.map((channel) => channel.id))));
    } catch {
      setProbes([]);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const result = await supplyApi.listChannels(kind);
      const list = toSupplyChannels(result.channels);
      setChannels(list);
      onNatures?.(toNatureOptions(result.natures));
      setLoadError('');
      await probe(list);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoaded(true);
    }
  }, [kind, onNatures, probe]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  /**
   * 启用 / 停用这一条渠道：真写启用位，然后重新拉一次（状态由后端说了算）。
   *
   * 后端把这次提交当成**整条渠道的替换**，所以两个种类块都要带上：只发当前这一类
   * 会把另一类整块删掉（一条渠道可以同时服务手机号和邮箱）。
   */
  const setEnabled = useCallback(
    async (channel: SupplyChannel, next: boolean) => {
      const input: SupplyChannelInput = {
        id: channel.id,
        label: channel.label,
        category: channel.category,
      };
      const phoneBlock = kindBlockInput(
        channel,
        'phone',
        kind === 'phone' ? next : (channel.phone?.enabled ?? false)
      );
      const emailBlock = kindBlockInput(
        channel,
        'email',
        kind === 'email' ? next : (channel.email?.enabled ?? false)
      );
      if (!phoneBlock && !emailBlock) return;
      if (phoneBlock) input.phone = phoneBlock;
      if (emailBlock) input.email = emailBlock;
      setActionError('');
      setBusyId(channel.id);
      const result = await supplyApi.saveChannel(input);
      setBusyId('');
      if (!result.ok) {
        setActionError(result.message);
        return;
      }
      await load();
    },
    [kind, load]
  );

  const remove = useCallback(
    async (channel: SupplyChannel) => {
      setActionError('');
      setBusyId(channel.id);
      const result = await supplyApi.removeChannel(channel.id);
      setBusyId('');
      if (!result.ok) {
        setActionError(result.message);
        return;
      }
      await load();
    },
    [load]
  );

  const probesById = useMemo(
    () => new Map(probes.map((item) => [item.id, item.natures])),
    [probes]
  );

  const natureLabels = (list: SupplyNature[]) =>
    list.map((nature) => t(NATURE_LABEL[nature])).join(' + ') || '—';

  /** 连接状态：先看这条渠道声明了哪些连接方式，再看每一种探活的结果。 */
  const connectionState = (channel: SupplyChannel) => {
    const declared = (kind === 'phone' ? channel.phone : channel.email)?.natures ?? [];
    const stateOf = (nature: SupplyNature) => probesById.get(channel.id)?.[nature];
    const online = declared.filter((nature) => stateOf(nature) === 'online');
    if (declared.length === 0) {
      return { tone: styles.tagMuted, text: t('sms_service.pool_probe_none') };
    }
    if (online.length === declared.length) {
      return {
        tone: styles.tagGood,
        text: t('sms_service.pool_probe_online', { natures: natureLabels(online) }),
      };
    }
    if (online.length > 0) {
      return {
        tone: styles.tagWarning,
        text: t('sms_service.pool_probe_partial', { natures: natureLabels(online) }),
      };
    }
    const offline = declared.filter((nature) => stateOf(nature) === 'offline');
    if (offline.length > 0) {
      return {
        tone: styles.tagWarning,
        text: t('sms_service.pool_probe_offline', { natures: natureLabels(offline) }),
      };
    }
    if (declared.some((nature) => stateOf(nature) === 'unready')) {
      return { tone: styles.tagMuted, text: t('sms_service.pool_probe_unready') };
    }
    if (declared.some((nature) => stateOf(nature) === 'unsupported')) {
      return { tone: styles.tagMuted, text: t('sms_service.pool_probe_unsupported') };
    }
    return { tone: styles.tagMuted, text: t('sms_service.pool_probe_unchecked') };
  };

  return (
    <Card
      title={
        <span className={styles.cardTitle}>
          <IconPlug size={17} />
          {t('sms_service.configured_title')}
        </span>
      }
    >
      {loadError && (
        <Notice tone="danger" role="alert" icon={<IconAlertTriangle size={15} />}>
          {t('sms_service.pool_error_load', { message: loadError })}
        </Notice>
      )}
      {actionError && (
        <Notice tone="danger" role="alert" icon={<IconAlertTriangle size={15} />}>
          {t('sms_service.pool_error_change', { message: actionError })}
        </Notice>
      )}

      {!loaded ? null : channels.length === 0 ? (
        <EmptyState
          title={t('sms_service.pool_empty_channels')}
          description={t('sms_service.pool_empty_channels_desc')}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('sms_service.pool_col_name')}</TableHead>
              <TableHead>{t('sms_service.pool_col_category')}</TableHead>
              <TableHead>{t('sms_service.pool_col_natures')}</TableHead>
              <TableHead>{t('sms_service.pool_col_connection')}</TableHead>
              <TableHead>{t('sms_service.pool_col_switch')}</TableHead>
              <TableHead alignRight>{t('sms_service.pool_col_edit')}</TableHead>
              <TableHead alignRight>{t('sms_service.pool_col_remove')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {channels.map((channel) => {
              const block = kind === 'phone' ? channel.phone : channel.email;
              const status = connectionState(channel);
              const categoryLabel = CATEGORY_LABEL[channel.category];
              const editLabel = t('sms_service.pool_edit_aria', { name: channel.label });
              const removeLabel = t('sms_service.pool_remove_aria', { name: channel.label });
              return (
                <TableRow key={channel.id}>
                  <TableCell>
                    <span className={styles.channelName}>{channel.label}</span>
                  </TableCell>
                  <TableCell>
                    <span className={`${styles.tag} ${styles.tagMuted}`}>
                      {categoryLabel ? t(categoryLabel) : '—'}
                    </span>
                  </TableCell>
                  <TableCell>{natureLabels(block?.natures ?? [])}</TableCell>
                  <TableCell>
                    <span className={`${styles.tag} ${status.tone}`}>{status.text}</span>
                  </TableCell>
                  <TableCell>
                    <ToggleSwitch
                      checked={block?.enabled ?? false}
                      onChange={(next) => void setEnabled(channel, next)}
                      disabled={busyId === channel.id}
                      ariaLabel={t('sms_service.pool_toggle_aria', { name: channel.label })}
                    />
                  </TableCell>
                  <TableCell alignRight>
                    <button
                      type="button"
                      className={styles.actionPill}
                      onClick={() => onEdit(channel)}
                      title={editLabel}
                      aria-label={editLabel}
                    >
                      <IconPencil size={14} />
                    </button>
                  </TableCell>
                  <TableCell alignRight>
                    <button
                      type="button"
                      className={styles.actionPill}
                      onClick={() => void remove(channel)}
                      disabled={busyId === channel.id}
                      title={removeLabel}
                      aria-label={removeLabel}
                    >
                      <IconTrash2 size={14} />
                    </button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
