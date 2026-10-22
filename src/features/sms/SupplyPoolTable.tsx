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
 * 每条渠道下面挂一条**状态带**（`ChannelStatusStrip`）：它属于上面那一行，先说这条
 * 渠道往供应池送了多少身份，再说它自己的运行情况 —— 这个平台的余额还剩多少，或者这个
 * 邮箱最新一封是什么码。收件箱不另开入口：自动化脚本要的是接口，人要的是「这一条
 * 现在要不要管」。
 *
 * 探活是**只读**的：进页面探一次，探不动就如实显示「未检查」，不把「探不了」说成
 * 「连不上」。
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
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { IconAlertTriangle, IconPencil, IconPlug, IconTrash2 } from '@/components/ui/icons';
import { supplyApi, type SupplyChannelInput } from '@/services/api/supply';
import { EgressBindingSelect } from '@/features/egress/EgressBindingSelect';
import { ChannelStatusStrip } from './ChannelStatusStrip';
import { useChannelStatus } from './useChannelStatus';
import { kindBlockInput } from './channelDraft';
import {
  toNatureOptions,
  toProbes,
  toSupplyChannels,
  blockEgressId,
  CATEGORY_LABEL,
  NATURE_LABEL,
  connectionState,
} from './smsMapping';
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

  // 每条渠道的状态带：一次读全，按渠道分派（见 `useChannelStatus`）。
  const statuses = useChannelStatus(kind, channels, reloadKey);

  const natureLabels = (list: SupplyNature[]) =>
    list.map((nature) => t(NATURE_LABEL[nature])).join(' + ') || '—';

  // 连接状态与台账共用同一份判据：同一条渠道在两个页面上说的必须是同一句话。
  const connectionOf = (channel: SupplyChannel) =>
    connectionState(
      (kind === 'phone' ? channel.phone : channel.email)?.natures ?? [],
      probesById.get(channel.id),
      (nature) => t(NATURE_LABEL[nature])
    );

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
              const connection = connectionOf(channel);
              const categoryLabel = CATEGORY_LABEL[channel.category];
              const editLabel = t('sms_service.pool_edit_aria', { name: channel.label });
              const removeLabel = t('sms_service.pool_remove_aria', { name: channel.label });
              return (
                <Fragment key={channel.id}>
                  <TableRow className={styles.stripLead}>
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
                      <span className={`${styles.tag} ${styles[connection.tone]}`}>
                        {t(connection.key, connection.params)}
                      </span>
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
                  <TableRow className={styles.stripRow}>
                    <TableCell colSpan={7}>
                      <div className={styles.stripCell}>
                        <ChannelStatusStrip
                          kind={kind}
                          status={statuses.get(channel.id) ?? { kind: 'loading' }}
                          pooled={channel.pooled[kind]}
                        />
                        <span className={styles.stripEgress}>
                          <EgressBindingSelect
                            kind="channel"
                            name={channel.id}
                            supplyKind={kind}
                            currentId={blockEgressId(block)}
                            noneLabel={t('egress_pool.none_direct')}
                            ariaLabel={t('egress_pool.binding_aria', { name: channel.label })}
                            onChanged={() => load()}
                          />
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
