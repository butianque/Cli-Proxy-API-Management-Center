/**
 * 账号池索引：把 `GET /accounts` 的账号视图挂到 `GET /credentials` 的文件行上。
 * React-free 纯函数 —— `tests/accountPool.test.ts` 直接断言。
 *
 * 键 = `getQuotaCacheKey(file)`（页面用同一个键取）。它本身就是 `file.name`，只有
 * Devin 这类「一个文件多个凭据身份」才是 `name\0authIndex`；用同一个键才能让
 * 「一个文件两行」时两张卡片各拿各的账号。
 *
 * 不造值：三级匹配全部未命中的文件**不入 map**，由消费方按「账号信息不可用」渲染。
 */
import type { AuthFileItem } from '@/types';
import type { AccountPolicy, AccountView } from '@/types/accounts';
import { getQuotaCacheKey } from '@/utils/quota/identity';

/**
 * 取标识的末段，同时处理 `/` 与 `\`。
 * 宿主 watcher 侧把 `ID` 写成相对路径（Windows 下转小写），而 `FileName` 是
 * `filepath.Base` ⇒ `authId` 可能带目录前缀，不能直接与文件名比较。
 */
const basename = (id: string): string => id.split(/[\\/]/).pop() ?? id;

/** 归一化 authIndex 供跨类型比较；空值不参与匹配（避免「两边都空」被判成相等）。 */
const matchableAuthIndex = (value: string | number | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

/**
 * 按 `getQuotaCacheKey(file)` 建索引。三级匹配（顺序固定，先命中先赢）：
 * 1. `account.authId === file.name`（filestore 路径，两者相等）；
 * 2. `basename(account.authId).toLowerCase() === file.name.toLowerCase()`
 *    （覆盖子目录前缀与 Windows 大小写差异）；
 * 3. `authIndex` 兜底（两侧都有非空 authIndex 且字符串相等）。
 *
 * 一个键被**多个不同账号**共用时该键作废（值记 `null`）并继续降级；三级都用不上就
 * 不入 map。宁可让这张卡片显示「账号信息不可用」，也不能把同名的另一个账号的池信息
 * 张冠李戴 —— Devin 这类「一个文件多个凭据身份」就是同名多行。
 */
export function buildAccountIndex(
  files: readonly AuthFileItem[],
  accounts: readonly AccountView[]
): Map<string, AccountView> {
  const index = new Map<string, AccountView>();
  if (files.length === 0 || accounts.length === 0) return index;

  // 值 `null` = 该键被多个不同账号共用，作废。
  const byAuthId = new Map<string, AccountView | null>();
  const byBasename = new Map<string, AccountView | null>();
  const byAuthIndex = new Map<string, AccountView | null>();

  /** 账号身份（`authId` + `authIndex`）：同键第二次出现的是**另一个**账号就作废。 */
  const identityOf = (account: AccountView) =>
    `${account.authId}\u0000${matchableAuthIndex(account.authIndex) ?? ''}`;
  const put = (map: Map<string, AccountView | null>, key: string, account: AccountView) => {
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, account);
    } else if (existing !== null && identityOf(existing) !== identityOf(account)) {
      map.set(key, null);
    }
  };

  accounts.forEach((account) => {
    put(byAuthId, account.authId, account);
    const baseKey = basename(account.authId).toLowerCase();
    if (baseKey) put(byBasename, baseKey, account);
    const authIndexKey = matchableAuthIndex(account.authIndex);
    if (authIndexKey) put(byAuthIndex, authIndexKey, account);
  });

  files.forEach((file) => {
    const name = file.name;
    if (!name) return;

    // 键作废（`null`）与未命中（`undefined`）都继续降级到更弱的键。
    const authIndexKey = matchableAuthIndex(file.authIndex);
    const matched =
      byAuthId.get(name) ??
      byBasename.get(name.toLowerCase()) ??
      (authIndexKey ? byAuthIndex.get(authIndexKey) : undefined);

    if (matched) index.set(getQuotaCacheKey(file), matched);
  });

  return index;
}

/** policy 枚举值 → i18n key 后缀（`'start-plan-only'` → `'start_plan_only'`）。 */
export function policyI18nSuffix(policy: AccountPolicy): string {
  return policy.split('-').join('_');
}
