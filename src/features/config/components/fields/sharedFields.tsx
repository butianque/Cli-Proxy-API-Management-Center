// 8 个高频字段的唯一渲染源：SectionCommon（常用 tab）与各正典分区共用这些组件，
// 两处渲染结构性不可能漂移（旧简单模式靠共享 JSX 常量达成同一目的）。
// 注意：只挂载激活 tab，所以 FieldAnchor 的 DOM id 不会重复。

import { useTranslation } from 'react-i18next';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { egressApi } from '@/services/api/egress';
import type { EgressProbeResult } from '@/services/api/egress';
import { egressOptions, egressPoolApi } from '@/services/api/egressPool';
import { useEgressPool } from '@/hooks/useEgressPool';
import type { VisualConfigValues } from '@/types/visualConfig';
import { SPONSORS } from '../../sponsors';
import { ApiKeysCardEditor } from '../blocks/ApiKeysCardEditor';
import { FieldAnchor, FieldGroup, FieldShell, ToggleRow } from './FieldPrimitives';
import fieldStyles from './Field.module.scss';

/** 下拉框里「自己填一个地址」的哨兵值：它不是编号，也不是空。 */
const CUSTOM_EGRESS = 'custom';

export type SharedFieldProps = {
  values: VisualConfigValues;
  disabled: boolean;
  onChange: (patch: Partial<VisualConfigValues>) => void;
  /** 可选的标签上方占位行（见 SponsorHintSpacer），仅在需要与代理 URL 字段对齐时传入。 */
  topExtra?: ReactNode;
};

export function HostField({ values, disabled, onChange, topExtra }: SharedFieldProps) {
  const { t } = useTranslation();
  return (
    <FieldAnchor fieldId="host">
      <Input
        label={t('config_management.visual.sections.server.host')}
        placeholder="0.0.0.0"
        value={values.host}
        onChange={(e) => onChange({ host: e.target.value })}
        disabled={disabled}
        topExtra={topExtra}
      />
    </FieldAnchor>
  );
}

export function PortField({
  values,
  disabled,
  onChange,
  error,
  topExtra,
}: SharedFieldProps & { error?: string }) {
  const { t } = useTranslation();
  return (
    <FieldAnchor fieldId="port">
      <Input
        label={t('config_management.visual.sections.server.port')}
        type="number"
        placeholder="8317"
        value={values.port}
        onChange={(e) => onChange({ port: e.target.value })}
        disabled={disabled}
        error={error}
        topExtra={topExtra}
      />
    </FieldAnchor>
  );
}

export function ProxyUrlField({ values, disabled, onChange }: SharedFieldProps) {
  const { t } = useTranslation();
  // 代理 URL 较长，字段跨两列；标签下方挂赞助跳转行（数据见 sponsors.ts，空则不渲染）。
  const sponsor = SPONSORS[0];
  return (
    <FieldAnchor fieldId="proxyUrl" wide>
      <Input
        label={t('config_management.visual.sections.network.proxy_url')}
        labelExtra={
          sponsor ? (
            <p className={fieldStyles.fieldSponsorHint}>
              {t('config_management.visual.sections.network.proxy_url_sponsor_hint')}{' '}
              <a
                className={fieldStyles.fieldSponsorLink}
                href={sponsor.url}
                target="_blank"
                rel="noopener noreferrer sponsored"
              >
                {sponsor.logo ? (
                  <img className={fieldStyles.fieldSponsorLogo} src={sponsor.logo} alt="" />
                ) : null}
                {sponsor.name}
              </a>
            </p>
          ) : undefined
        }
        placeholder="socks5://user:pass@127.0.0.1:1080/"
        value={values.proxyUrl}
        onChange={(e) => onChange({ proxyUrl: e.target.value })}
        disabled={disabled}
      />
    </FieldAnchor>
  );
}

/**
 * 与代理 URL 字段同排时的隐形占位行：渲染在标签上方（Input 的 topExtra），
 * 赞助商存在时把同排字段整体下移与赞助行同高，让输入框水平对齐，
 * 同时标签与输入框之间保持正常间距；无赞助商则不渲染。
 */
export function SponsorHintSpacer() {
  if (SPONSORS.length === 0) return null;
  return (
    <p className={fieldStyles.fieldSponsorSpacer} aria-hidden="true">
      &nbsp;
    </p>
  );
}

type EgressProbePhase =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; result: EgressProbeResult }
  | { kind: 'failed'; message: string };

/**
 * 接码与注册的出口：与上面的代理地址是两段不同的流量。
 *
 * 为什么它在这里而不是在接码页：这是一条网络出口，跟代理地址同属网络配置；放在接码页
 * 会让人以为它只管接码那一个页面，而它管的是取号、收信、注册整条链路。
 *
 * 三种取值，按「越具体越优先」排列：
 *   1. 选池里的某条出口 —— 存的是编号，换 IP 只改池里那一条；
 *   2. 自己填一个地址 —— 一次性的、不值得进池的地址；
 *   3. 都不填 —— 沿用上面的代理地址。这个默认是有意的：注册与使用从同一个地址
 *      出去，本来就更像同一台机器。
 *
 * 「测试」是这一格存在的理由：地址值不值，只能从外面问一次它看起来是哪儿。
 * 选了池里的出口就测那一条（结论记在池上，四处共用），否则测手上的地址。
 */
export function SupplyEgressField({ values, disabled, onChange }: SharedFieldProps) {
  const { t } = useTranslation();
  const pool = useEgressPool();
  const [probe, setProbe] = useState<EgressProbePhase>({ kind: 'idle' });
  // 每次测试领一个号；地址被改或又点了一次，旧号作废，晚到的答案不覆盖新结论。
  const probeToken = useRef(0);

  // 池不可用（旧版服务端）时退回手填地址，这一格照旧能用。
  const poolReady = pool.status === 'ready' && pool.entries.length > 0;
  const selectedId = values.supplyEgressId.trim();
  // 「自己填一个地址」是一种模式，不是一种取值：刚切过去时地址还是空的，
  // 只看 `supplyEgress` 会让下拉框弹回「沿用」，输入框永远出不来。
  const [customMode, setCustomMode] = useState(
    () => values.supplyEgressId.trim() === '' && values.supplyEgress.trim() !== ''
  );

  const test = useCallback(async () => {
    const token = ++probeToken.current;
    setProbe({ kind: 'testing' });
    if (selectedId !== '') {
      // 测的是这条池出口本身：结论会写回池，卡片与三处下拉看到的是同一个答案。
      const outcome = await egressPoolApi.probe(Number(selectedId));
      if (probeToken.current !== token) return;
      if (!outcome.ok || !outcome.entry) {
        setProbe({ kind: 'failed', message: outcome.ok ? '' : outcome.message });
        return;
      }
      const recorded = outcome.entry.probe;
      setProbe({
        kind: 'ok',
        result: {
          ip: recorded?.ip ?? '',
          region: recorded?.region ?? '',
          network: recorded?.network ?? '',
          latencyMs: recorded?.latencyMs ?? null,
          direct: false,
        },
      });
      await pool.reload();
      return;
    }
    const typed = values.supplyEgress.trim();
    // 留空时测的是**当前生效**的出口，不是「没有出口」。
    const outcome = await egressApi.probe(typed === '' ? undefined : typed);
    if (probeToken.current !== token) return;
    if (!outcome.ok) {
      setProbe({ kind: 'failed', message: outcome.message });
      return;
    }
    setProbe({ kind: 'ok', result: outcome.result });
  }, [pool, selectedId, values.supplyEgress]);

  const resetProbe = () => {
    probeToken.current += 1;
    setProbe({ kind: 'idle' });
  };

  const selectOptions = poolReady
    ? [
        { value: '', label: t('egress_pool.supply_inherit') },
        ...egressOptions(pool.entries).map((option) => ({
          value: option.value,
          label: option.enabled ? option.label : `${option.label} (${t('egress_pool.paused')})`,
        })),
        { value: CUSTOM_EGRESS, label: t('egress_pool.supply_custom') },
      ]
    : [];

  const selectValue = selectedId !== '' ? selectedId : customMode ? CUSTOM_EGRESS : '';

  return (
    <FieldAnchor fieldId="supplyEgress" wide>
      {poolReady ? (
        <>
          <FieldShell
            label={t('config_management.visual.sections.network.supply_egress')}
            hint={t('egress_pool.supply_hint')}
          >
            <Select
              value={selectValue}
              options={selectOptions}
              disabled={disabled}
              fullWidth
              ariaLabel={t('config_management.visual.sections.network.supply_egress')}
              onChange={(nextValue) => {
                resetProbe();
                if (nextValue === CUSTOM_EGRESS) {
                  setCustomMode(true);
                  onChange({ supplyEgressId: '' });
                  return;
                }
                setCustomMode(false);
                // 选了池里的出口就把手填地址清掉：地址与编号同时存在时编号优先，
                // 留着旧地址只会让下一回改成「沿用」时突然走回一条烧掉的 IP。
                onChange({ supplyEgressId: nextValue, supplyEgress: '' });
              }}
            />
          </FieldShell>
          {selectValue === CUSTOM_EGRESS && (
            <Input
              label={t('egress_pool.supply_custom_label')}
              placeholder="socks5://user:pass@127.0.0.1:1080/"
              value={values.supplyEgress}
              onChange={(e) => {
                onChange({ supplyEgress: e.target.value });
                resetProbe();
              }}
              disabled={disabled}
            />
          )}
        </>
      ) : (
        <Input
          label={t('config_management.visual.sections.network.supply_egress')}
          hint={t('config_management.visual.sections.network.supply_egress_hint')}
          placeholder="socks5://user:pass@127.0.0.1:1080/"
          value={values.supplyEgress}
          onChange={(e) => {
            onChange({ supplyEgress: e.target.value });
            resetProbe();
          }}
          disabled={disabled}
        />
      )}
      <div className={fieldStyles.probeRow}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void test()}
          loading={probe.kind === 'testing'}
          disabled={disabled || probe.kind === 'testing'}
        >
          {t('config_management.visual.sections.network.supply_egress_test')}
        </Button>
        {probe.kind === 'ok' && (
          <span className={fieldStyles.probeResult}>
            {probe.result.direct && (
              <span className={fieldStyles.probeTag}>
                {t('config_management.visual.sections.network.supply_egress_direct')}
              </span>
            )}
            <span className={fieldStyles.probeValue}>{probe.result.ip}</span>
            {probe.result.region !== '' && (
              <span className={fieldStyles.probeValue}>{probe.result.region}</span>
            )}
            {probe.result.network !== '' && (
              <span className={fieldStyles.probeValue}>{probe.result.network}</span>
            )}
            {probe.result.latencyMs !== null && (
              <span className={fieldStyles.probeValue}>{probe.result.latencyMs} ms</span>
            )}
          </span>
        )}
        {probe.kind === 'failed' && (
          <span className={fieldStyles.probeFailed} role="alert">
            {probe.message === ''
              ? t('config_management.visual.sections.network.supply_egress_no_ip')
              : t('config_management.visual.sections.network.supply_egress_failed', {
                  message: probe.message,
                })}
            <span className={fieldStyles.probeFailedHint}>
              {t('config_management.visual.sections.network.supply_egress_failed_hint')}
            </span>
          </span>
        )}
      </div>
    </FieldAnchor>
  );
}

export function ApiKeysField({ values, disabled, onChange }: SharedFieldProps) {
  return (
    <FieldAnchor fieldId="apiKeys">
      <FieldGroup>
        <ApiKeysCardEditor
          value={values.apiKeysText}
          pools={values.apiKeyPools}
          disabled={disabled}
          onChange={({ apiKeysText, apiKeyPools }) => onChange({ apiKeysText, apiKeyPools })}
        />
      </FieldGroup>
    </FieldAnchor>
  );
}

export function DebugToggle({ values, disabled, onChange }: SharedFieldProps) {
  const { t } = useTranslation();
  return (
    <FieldAnchor fieldId="debug">
      <ToggleRow
        title={t('config_management.visual.sections.system.debug')}
        description={t('config_management.visual.sections.system.debug_desc')}
        checked={values.debug}
        disabled={disabled}
        onChange={(debug) => onChange({ debug })}
      />
    </FieldAnchor>
  );
}

export function LoggingToFileToggle({ values, disabled, onChange }: SharedFieldProps) {
  const { t } = useTranslation();
  return (
    <FieldAnchor fieldId="loggingToFile">
      <ToggleRow
        title={t('config_management.visual.sections.system.logging_to_file')}
        description={t('config_management.visual.sections.system.logging_to_file_desc')}
        checked={values.loggingToFile}
        disabled={disabled}
        onChange={(loggingToFile) => onChange({ loggingToFile })}
      />
    </FieldAnchor>
  );
}

export function QuotaSwitchProjectToggle({ values, disabled, onChange }: SharedFieldProps) {
  const { t } = useTranslation();
  return (
    <FieldAnchor fieldId="quotaSwitchProject">
      <ToggleRow
        title={t('config_management.visual.sections.quota.switch_project')}
        description={t('config_management.visual.sections.quota.switch_project_desc')}
        checked={values.quotaSwitchProject}
        disabled={disabled}
        onChange={(quotaSwitchProject) => onChange({ quotaSwitchProject })}
      />
    </FieldAnchor>
  );
}

export function QuotaSwitchPreviewModelToggle({ values, disabled, onChange }: SharedFieldProps) {
  const { t } = useTranslation();
  return (
    <FieldAnchor fieldId="quotaSwitchPreviewModel">
      <ToggleRow
        title={t('config_management.visual.sections.quota.switch_preview_model')}
        description={t('config_management.visual.sections.quota.switch_preview_model_desc')}
        checked={values.quotaSwitchPreviewModel}
        disabled={disabled}
        onChange={(quotaSwitchPreviewModel) => onChange({ quotaSwitchPreviewModel })}
      />
    </FieldAnchor>
  );
}
