/**
 * 账号聚合视图类型（宿主 `GET /v8/management/accounts`）
 *
 * 后端契约的唯一来源：`internal/api/handlers/management/account_view.go`（字段与可空性）
 * 与 `account_failure.go`（失败归类值域）。归一化在 `src/services/api/accounts.ts`，
 * 组件只消费本文件的 camelCase 字段，不得出现后端 snake_case 字段名。
 *
 * 两条不可协商的语义（`account_view.go:28-31`）在这里同样成立：
 * 1. 后端无法确定的值一律省略或 `null`，前端不得回落成 0 / false；
 * 2. 读取永不探测上游，额度只来自宿主快照缓存，缺快照即 `unknown`。
 */

/**
 * 供应池身份类别（`internal/supply/supply.go:30-35`）。
 * F1 阶段仅当凭证能匹配到身份池记录时后端才下发。
 */
export type AccountSourceKind = 'phone' | 'email';

/**
 * 认证状态（`sdk/cliproxy/auth/status.go:6-19` 的完整词表）。
 * 本接口实际只会产出 `active` / `disabled` / `error` / `unknown`。
 */
export type AccountAuthState =
  | 'unknown'
  | 'active'
  | 'pending'
  | 'refreshing'
  | 'error'
  | 'disabled';

/**
 * 账号路由策略（宿主 `account_view.go` 的 `policy` 字段）。值域是开放的：
 * `auto` = 默认（等价于不设策略），`only:<渠道key>` = 只走 `channels` 里 key 命中的那条渠道。
 * 无合法策略时后端省略该字段 ⇒ 前端为 undefined。
 *
 * 词表不在这里枚举：渠道 key 由插件下发（见 `AccountChannel`），面板不得内置固定清单。
 */
export type AccountPolicy = 'auto' | `only:${string}`;

/** 该凭证实际携带的一条路由渠道。`key` 是插件自有的渠道标识，策略用它选中渠道；
 *  `label` 是插件从上游真实上报里取的名字，用于展示。 */
export type AccountChannel = { key: string; label: string };

/**
 * 失败归类（`account_failure.go:12-20` 的全部 7 个类）。
 * 没有任何失败可归类时后端省略该字段 ⇒ 前端为 undefined，绝不回落成某个类。
 */
export type AccountFailureClass =
  | 'auth'
  | 'quota'
  | 'risk'
  | 'rate'
  | 'network'
  | 'request'
  | 'upstream';

/**
 * 额度快照状态。值域是本接口实际能产出的 4 个（`account_view.go:165,209,211,213,215`）：
 * `unknown` 无快照 / `query-error` 最近一次查询失败 / `exhausted` 全部桶已知归零 /
 * `entitled` 其余。
 *
 * `sdk/pluginapi/types.go:2004-2011` 另有 `probing` 与 `not-entitled`，但本接口不会产出；
 * 归一化遇到词表外的值时回落到 `unknown`（未识别即「不知道」），不臆造具体状态。
 */
export type AccountQuotaState = 'unknown' | 'query-error' | 'exhausted' | 'entitled';

/** 一个账号的一个额度窗口（`account_view.go:73-82`）。 */
export interface AccountQuotaBucket {
  /** 分组显示名；缺省 = 该桶不按分组限定。 */
  group?: string;
  /** 该窗口适用的模型；缺省 = 不按模型限定。 */
  model?: string;
  /** 窗口名，如 `hourly` / `plan`。 */
  window?: string;
  /** 剩余比例。0 是真实值，不是「未知」。 */
  remainingFraction: number;
  /** 缺省 = 后端未报出该值（不是 0）。 */
  remaining?: number;
  /** 缺省 = 后端未报出该值（不是 0）。 */
  total?: number;
  resetAt?: string;
  description?: string;
}

/** 请求热力的一格（`account_view.go:87-92`）。 */
export interface AccountHeatBucket {
  bucket: string;
  success: number;
  failed: number;
  /** 窗口内无请求时缺省（与「全部失败」= 0 可区分）。 */
  successRate?: number;
}

/** 一个账号（`account_view.go:34-68`）。 */
export interface AccountView {
  provider: string;
  authIndex: string;
  /**
   * 凭证标识（宿主 `auth.ID`，`account_view.go:158`）。**它不等于**
   * `GET /credentials` 的 `name`，只在 filestore 路径下恰好相等：
   * `sdk/auth/filestore.go:337-340` 把 `ID` 与 `FileName` 赋成同一个 id，
   * 但 watcher 路径（`internal/watcher/synthesizer/file.go:197-199`）的 `ID`
   * 是相对路径且 Windows 下转小写，而 `FileName` 是 `filepath.Base`。
   * ⇒ 跨两个接口关联必须容错匹配（精确 → basename 忽略大小写 → authIndex），
   * 见 `features/authFiles/accountPool.ts` 的 `buildAccountIndex`。
   * 单接口内按文件操作（status / fields / refresh / delete）仍可直接用 authId 作键。
   */
  authId: string;
  /** 上游账号标识（email 优先，回落 project_id）；两者皆空时缺省。 */
  accountId?: string;
  displayName: string;
  /** F1 恒缺失（`buildAccountView` 从未赋值），F3 接线前不得依赖。 */
  site?: string;
  sourceKind?: AccountSourceKind;
  /** 索引已解析（`auth.Index != ""`），不是「凭证已解析」。 */
  parsed: boolean;
  enabled: boolean;
  /** F1 恒为 null（`buildAccountView` 从未赋值），F3 接线前不得依赖。 */
  supportsRefresh?: boolean;
  authState: AccountAuthState;
  /** 冷却状态判定下的可用性（`!unavailable`）。 */
  eligible: boolean;
  /** 仅当账号 metadata 的 policy 合法且等于 `disabled` 时为 true。 */
  manuallyDisabled: boolean;
  /** RFC3339 UTC；无冷却时缺省。 */
  cooldownUntil?: string;
  failureClass?: AccountFailureClass;
  /** 已由后端脱敏与限长的诊断文本。 */
  failureReason?: string;
  /** 仅当凭证带结构化错误时下发。 */
  failureRetryable?: boolean;
  planId?: string;
  channel?: string;
  /**
   * 账号在该平台首次开通的时刻（RFC3339 UTC），由插件按上游事实记录。
   * 缺省 = 该平台没有可用的开通时刻，不回落成凭证创建时间。
   */
  openedAt?: string;
  /** 该凭证实际携带的路由渠道；缺省 = 未知（宿主未下发，不回落成空数组以外的猜测）。 */
  channels?: AccountChannel[];
  policy?: AccountPolicy;
  /** F1 恒缺失（`buildAccountView` 从未赋值），F3 接线前不得依赖。 */
  entitlement?: string;
  quotaState: AccountQuotaState;
  /** RFC3339 UTC；仅有已抓取的快照时下发。 */
  fetchedAt?: string;
  /** 无缓存快照或无桶时为空数组。 */
  quota: AccountQuotaBucket[];
  requestCount: number;
  successCount: number;
  failureCount: number;
  /** 无历史时后端下发 null ⇒ 归一化为空数组。 */
  heatmap: AccountHeatBucket[];
}

/** 过滤后的计数（`account_view.go:140-148`）。 */
export interface AccountsCounts {
  total: number;
  /** key = provider。早退分支（`account_view.go:101`）不给这个键。 */
  byProvider: Record<string, number>;
  /** key = auth_state。早退分支（`account_view.go:101`）不给这个键。 */
  byState: Record<string, number>;
}

export interface AccountsResponse {
  status: string;
  accounts: AccountView[];
  counts: AccountsCounts;
}

/** `accountsApi.list` 的可选过滤条件（`account_view.go:96-99`）。 */
export interface AccountsListParams {
  provider?: string;
  kind?: AccountSourceKind;
}
