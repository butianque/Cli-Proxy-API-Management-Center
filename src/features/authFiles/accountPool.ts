/**
 * 账号池索引：把 `GET /accounts` 的账号视图挂到 `GET /credentials` 的文件行上。
 * React-free 纯函数 —— `tests/accountPool.test.ts` 直接断言。
 * 同时是「账号路由策略」下拉选项的唯一落点：策略值域是开放的（`auto` 或
 * `only:<渠道key>`），能选什么由该账号实际携带的 `channels` 决定，面板不内置渠道清单。
 *
 * 键 = `getQuotaCacheKey(file)`（页面用同一个键取）。它本身就是 `file.name`，只有
 * Devin 这类「一个文件多个凭据身份」才是 `name\0authIndex`；用同一个键才能让
 * 「一个文件两行」时两张卡片各拿各的账号。
 *
 * 不造值：三级匹配全部未命中的文件**不入 map**，由消费方按「账号信息不可用」渲染。
 */
import type { AuthFileItem } from '@/types';
import type { AccountChannel, AccountPolicy, AccountQuotaBucket, AccountView } from '@/types/accounts';
import { DAY_MS, MINUTE_MS } from '@/utils/time/durations';
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

/**
 * 渠道分组共享的到期时刻。上游的 `expires_at` / `period_end` 是**套餐（渠道）一级**的
 * 事实：组内各模型的窗口同属这份套餐时值必然相同 ⇒ 只需在组头说一次，不逐行重复。
 *
 * 组内桶报出**多于一个**不同值时返回 null —— 那说明这些窗口各有各的期限，组头的一个值
 * 代表不了全部，由调用方退回逐行显示。空串（宿主没下发该字段）不参与比较。
 */
export function sharedResetAt(buckets: readonly AccountQuotaBucket[]): string | null {
  const values = new Set<string>();
  buckets.forEach((bucket) => {
    const value = bucket.resetAt?.trim();
    if (value) values.add(value);
  });
  return values.size === 1 ? [...values][0] : null;
}

/**
 * 卡片上该显示的那个时刻（毫秒），解析不出返回 null。
 *
 * 按日窗口（`window === 'daily'`）多做一件事：**把已经过去的时刻按整天往前滚**。
 * 上游/插件是在探测那一刻算出「下一个重置点」的，面板跨过那个点之后这条快照就落在
 * 过去，照直显示会得到「下一次重置时间：10-17 00:00」——一句自相矛盾的话。日窗口的
 * 边界是「同一个钟点、每 24 小时一次」，往前滚出来的值与重新探测一次完全一致，所以
 * 这不是编造，只是把同一条规则续到当下。
 *
 * 其它窗口一律不滚：周/月/一次性窗口过期就是真的过期，滚一下会把它说成还没到期。
 */
export function resolveResetInstant(
  resetAt: string | null | undefined,
  window: string | null | undefined,
  now: number
): number | null {
  const ms = resetAt ? Date.parse(resetAt) : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  if (window?.trim() !== 'daily' || ms > now) return ms;
  return ms + (Math.floor((now - ms) / DAY_MS) + 1) * DAY_MS;
}

/**
 * 距离某个时刻还剩多少**分钟**（向上取整），已经过去或没有时刻时返回 null。
 *
 * 向上取整是有意的：显示「剩余 0 分钟」时其实还剩一点，而倒计时宁可少说一秒，
 * 也不能多说；`null` 表示「没有可倒数的东西」，调用方只报时刻、不报剩余。
 */
export function remainingMinutes(targetMs: number | null, now: number): number | null {
  if (targetMs === null || !Number.isFinite(targetMs)) return null;
  const minutes = Math.ceil((targetMs - now) / MINUTE_MS);
  return minutes > 0 ? minutes : null;
}

/** 默认策略：不钉渠道（等价于不设策略）。 */
export const ACCOUNT_POLICY_AUTO: AccountPolicy = 'auto';

/** 「钉死某渠道」的前缀，与 `services/api/accounts.ts` 的校验保持一致。 */
const POLICY_ONLY_PREFIX = 'only:';

/** 把渠道 key 变成「钉死该渠道」的策略值。 */
export function accountPolicyOnly(channelKey: string): AccountPolicy {
  return `only:${channelKey}`;
}

/** 取出策略钉死的渠道 key；不是钉死策略（auto / 空 / 非法）时返回 null。 */
export function accountPolicyChannelKey(policy: string | undefined): string | null {
  if (typeof policy !== 'string') return null;
  const raw = policy.trim();
  if (!raw.startsWith(POLICY_ONLY_PREFIX)) return null;
  const channelKey = raw.slice(POLICY_ONLY_PREFIX.length).trim();
  return channelKey ? channelKey : null;
}

/** 抽屉里的一个策略选项。channelLabel 为 null 表示「默认（自动）」。 */
export type RoutingPolicyOption = {
  value: AccountPolicy;
  channelLabel: string | null;
};

/**
 * 选项 = 默认 + 该账号实际携带的每个渠道（只给存在的，选不到对不上的渠道）。
 * 若 currentPolicy 钉了一个不在 channels 里的渠道（陈旧值），补一个以该 key 为标签的选项，
 * 免得触发器上显示空白。
 */
export function routingPolicyOptions(
  channels: readonly AccountChannel[],
  currentPolicy?: string
): readonly RoutingPolicyOption[] {
  const options: RoutingPolicyOption[] = [{ value: ACCOUNT_POLICY_AUTO, channelLabel: null }];
  const knownKeys = new Set<string>();
  channels.forEach((channel) => {
    if (knownKeys.has(channel.key)) return;
    knownKeys.add(channel.key);
    options.push({ value: accountPolicyOnly(channel.key), channelLabel: channel.label });
  });

  const pinnedKey = accountPolicyChannelKey(currentPolicy);
  if (pinnedKey && !knownKeys.has(pinnedKey)) {
    options.push({ value: accountPolicyOnly(pinnedKey), channelLabel: pinnedKey });
  }

  return options;
}
