/**
 * 账号池索引：把 `GET /accounts` 的账号视图挂到 `GET /credentials` 的文件行上。
 * React-free 纯函数 —— `tests/accountPool.test.ts` 直接断言。
 *
 * 键 = `AuthFileItem.name`（页面用 `index.get(file.name)` 取），因为按文件操作的
 * 既有接口（status / fields / refresh / delete）都以 name 作键。
 *
 * 不造值：三级匹配全部未命中的文件**不入 map**，由消费方按「账号信息不可用」渲染。
 */
import type { AuthFileItem } from '@/types';
import type { AccountPolicy, AccountView } from '@/types/accounts';

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
 * 按 `AuthFileItem.name` 建索引。三级匹配（顺序固定，先命中先赢）：
 * 1. `account.authId === file.name`（filestore 路径，两者相等）；
 * 2. `basename(account.authId).toLowerCase() === file.name.toLowerCase()`
 *    （覆盖子目录前缀与 Windows 大小写差异）；
 * 3. `authIndex` 兜底（两侧都有非空 authIndex 且字符串相等）。
 *
 * 同一 `authId` / 同一 basename / 同一 authIndex 出现多行时取 `accounts` 里先到的一行。
 */
export function buildAccountIndex(
  files: readonly AuthFileItem[],
  accounts: readonly AccountView[]
): Map<string, AccountView> {
  const index = new Map<string, AccountView>();
  if (files.length === 0 || accounts.length === 0) return index;

  const byAuthId = new Map<string, AccountView>();
  const byBasename = new Map<string, AccountView>();
  const byAuthIndex = new Map<string, AccountView>();

  accounts.forEach((account) => {
    if (!byAuthId.has(account.authId)) byAuthId.set(account.authId, account);
    const baseKey = basename(account.authId).toLowerCase();
    if (baseKey && !byBasename.has(baseKey)) byBasename.set(baseKey, account);
    const authIndexKey = matchableAuthIndex(account.authIndex);
    if (authIndexKey && !byAuthIndex.has(authIndexKey)) byAuthIndex.set(authIndexKey, account);
  });

  files.forEach((file) => {
    const name = file.name;
    if (!name) return;

    let matched = byAuthId.get(name) ?? byBasename.get(name.toLowerCase());
    if (!matched) {
      const authIndexKey = matchableAuthIndex(file.authIndex);
      matched = authIndexKey ? byAuthIndex.get(authIndexKey) : undefined;
    }

    if (matched) index.set(name, matched);
  });

  return index;
}

/** policy 枚举值 → i18n key 后缀（`'start-plan-only'` → `'start_plan_only'`）。 */
export function policyI18nSuffix(policy: AccountPolicy): string {
  return policy.split('-').join('_');
}
