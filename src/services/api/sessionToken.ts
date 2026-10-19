/**
 * 管理会话令牌的读写。
 *
 * 单独成模块是因为它被两侧共用：`client.ts` 每次请求都要附上它，`session.ts`
 * 负责创建/续期/结束会话。两者互相 import 会成环，而令牌本身只是三个存取函数。
 *
 * ## 为什么存 `localStorage`
 *
 * 会话要表达的是「**这个浏览器**的一次登录」，所以同一浏览器的多个标签页必须
 * 共用同一个令牌 —— 否则在 A 标签页解锁后，B 标签页还会再问一次主密码，正是
 * 要修掉的那个毛病。`sessionStorage` 是每标签页独立的，用不了。
 *
 * 浏览器关掉后令牌仍在，但**会话本身会过期**：服务端 10 分钟无操作即销毁，
 * 带着过期令牌的请求会 401，面板随即重新登录、重新要主密码。所以「关掉再开」
 * 的边界由服务端空闲时钟给出，不靠前端删键。
 */

/** 请求头名，与后端 `sessionHeaderName` 对应。 */
export const SESSION_HEADER = 'X-CPA-Session';

const SESSION_TOKEN_KEY = 'cpa.session.token';

/**
 * 本次页面加载是否已经拿到过一个可用会话（只在内存里）。
 *
 * 令牌存在 `localStorage` 里，所以刷新页面后它还在 —— 但「还在」不等于「还
 * 有效」：后端重启过、或者空闲超时后关掉了页面，这个令牌早就作废了。如果
 * 一开始就把它挂在登录时的连接自检上，那条请求会被 401 拒掉，登录直接失败，
 * 而报错看起来像「管理密钥不对」。
 *
 * 所以令牌只在「本次加载已经确认过会话」之后才随请求发出：登录自检不带它，
 * 随后的 `ensureManagementSession()` 会拿它去探测——有效就继续用同一个会话
 * （F5 因此不会重新要主密码），无效就换一个新的。
 */
let established = false;

/** 当前令牌；没有或存储不可用时返回 null。 */
export function readSessionToken(): string | null {
  try {
    const token = window.localStorage.getItem(SESSION_TOKEN_KEY);
    return token && token.trim() ? token : null;
  } catch {
    return null;
  }
}

/** 本次加载是否已经确认过会话（决定要不要把令牌挂到请求上）。 */
export function isSessionEstablished(): boolean {
  return established;
}

/** 确认复用了一个已存在的会话：之后的请求可以带上这个令牌。 */
export function markSessionEstablished(): void {
  established = true;
}

export function writeSessionToken(token: string): void {
  established = true;
  try {
    window.localStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    // 存储不可用：本次加载仍能用内存里的令牌，刷新后会重新登录。
  }
}

export function clearSessionToken(): void {
  established = false;
  try {
    window.localStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // 删不掉也不影响：服务端那边已经失效了。
  }
}
