/**
 * 邮箱视图：邮箱这一类渠道的列表 + 编辑弹窗。
 *
 * 版面与手机号视图**逐项对齐**：同一条页头操作行（添加渠道）+ 同一张渠道池表
 * （`SupplyPoolTable`，表头完全一致）+ **同一个编辑器组件**（`ChannelEditorModal`）。
 * 两个类别的差别只在「可选哪些接入方式」和「凭据填在哪」，版面本身没有第二套。
 *
 * 添加渠道的入口**只有页头这一个**：表里那一个在有数据后就消失，两个入口会让
 * 「去哪加」变成一个问题，而它本来不是问题。
 *
 * 后端一条渠道仍可同时带手机号与邮箱块；本视图只列与只改邮箱块，手机号块由
 * 编辑器原样带回，不丢（基座把一次提交当成整条渠道的替换）。
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconPlus } from '@/components/ui/icons';
import { ChannelEditorModal } from './ChannelEditorModal';
import { SupplyPoolTable } from './SupplyPoolTable';
import type { SupplyChannel, SupplyNatureOption } from './types';
import styles from './SmsServicePage.module.scss';

export function SupplyChannelCard() {
  const { t } = useTranslation();
  const [natures, setNatures] = useState<SupplyNatureOption[]>([]);
  const [editing, setEditing] = useState<SupplyChannel | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const openEditor = useCallback((channel: SupplyChannel | null) => {
    setEditing(channel);
    setEditorOpen(true);
  }, []);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.headerActions}>
          <button type="button" className={styles.actionPill} onClick={() => openEditor(null)}>
            <IconPlus size={14} />
            {t('sms_service.config_add_email')}
          </button>
        </div>
      </header>

      <SupplyPoolTable
        kind="email"
        reloadKey={reloadKey}
        onEdit={openEditor}
        onNatures={setNatures}
      />

      <ChannelEditorModal
        open={editorOpen}
        kind="email"
        channel={editing}
        natures={natures}
        credential={null}
        onClose={() => setEditorOpen(false)}
        onSaved={() => setReloadKey((key) => key + 1)}
      />
    </div>
  );
}
