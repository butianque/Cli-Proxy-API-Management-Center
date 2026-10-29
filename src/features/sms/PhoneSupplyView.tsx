/**
 * 手机号接码视图（「接码服务」页的「手机号」类别）。
 *
 * 正文只有一件事：**这一类配了哪些渠道**（渠道池表），以及渠道的增删改。
 * 平台侧的数据（余额 / 取号渠道 / 账本 / 成本护栏 / 使用建议）已经从这里撤掉，
 * 位置待定；本视图不再渲染它们。
 *
 * 这里仍然读一次 `/supply/phone/status`，但**只**用于编辑器的回填提示
 * （已存哪种凭据、账号脱敏提示、凭据属于哪个平台）—— 页面正文不依赖它，
 * 读不到也不挡正文。
 *
 * 版面与邮箱视图逐项对齐：同一条页头操作行 + 同一张渠道池表 + 同一个编辑器。
 * 添加渠道的入口只有页头这一个。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconPlus } from '@/components/ui/icons';
import { smsApi } from '@/services/api/sms';
import { useSecretGateStore } from '@/stores/useSecretGateStore';
import { ChannelEditorModal } from './ChannelEditorModal';
import { SupplyPoolTable } from './SupplyPoolTable';
import { EMPTY_SMS_VIEW, toStatus } from './smsMapping';
import type {
  PhoneCredentialState,
  SmsStatusView,
  SupplyChannel,
  SupplyNatureOption,
} from './types';
import styles from './SmsServicePage.module.scss';

export function PhoneSupplyView() {
  const { t } = useTranslation();
  const gatePhase = useSecretGateStore((state) => state.phase);
  // 渠道名里要用「号段」这个词，由页面把本地化写法交给映射层（映射层保持纯函数）。
  const prefixLabel = t('sms_service.channel_prefix');

  // 起步就是真实空态；后端返回什么就显示什么，不拿假数据兜底。
  const [view, setView] = useState<SmsStatusView>(EMPTY_SMS_VIEW);
  const [natures, setNatures] = useState<SupplyNatureOption[]>([]);
  const [editing, setEditing] = useState<SupplyChannel | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const loadStatus = useCallback(async () => {
    try {
      setView(toStatus(await smsApi.getStatus(), prefixLabel));
    } catch {
      // 读不到只影响编辑器的回填提示。正文（渠道池表）有自己的加载与报错。
    }
  }, [prefixLabel]);

  useEffect(() => {
    void loadStatus();
    // Re-read when the gate changes state: locking or unlocking the base store
    // flips what the backend can report about the credentials.
  }, [loadStatus, gatePhase]);

  /**
   * 编辑器要的凭据现状。`provider` 决定「已存凭据属于哪个平台」—— 选了别的平台
   * 就不能再拿它的脱敏账号当提示。
   */
  const credential = useMemo<PhoneCredentialState>(
    () => ({
      provider: view.provider,
      apiPresent: view.accountPresent,
      webPresent: view.webPresent,
      cookiePresent: view.cookiePresent,
      apiUserHint: view.apiUserHint,
      webUserHint: view.webUserHint,
    }),
    [view]
  );

  const openEditor = useCallback((channel: SupplyChannel | null) => {
    setEditing(channel);
    setEditorOpen(true);
  }, []);

  return (
    <div className={styles.subPage}>
      <header className={styles.pageHeader}>
        <div className={styles.headerActions}>
          <button type="button" className={styles.actionPill} onClick={() => openEditor(null)}>
            <IconPlus size={14} />
            {t('sms_service.config_add_phone')}
          </button>
        </div>
      </header>

      <SupplyPoolTable
        kind="phone"
        reloadKey={reloadKey}
        onEdit={openEditor}
        onNatures={setNatures}
      />

      <ChannelEditorModal
        open={editorOpen}
        kind="phone"
        channel={editing}
        natures={natures}
        credential={credential}
        onClose={() => setEditorOpen(false)}
        onSaved={() => {
          setReloadKey((key) => key + 1);
          void loadStatus();
        }}
      />
    </div>
  );
}
