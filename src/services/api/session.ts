/**
 * 管理会话（`/v8/management/session`）。
 *
 * ## 为什么需要会话
 *
 * 管理密钥证明「你是运维」，但它是一把静态、永不过期、无法吊销的钥匙 ——
 * 谁拿到它都能读凭据。会话是操作者**真正持有的东西**：登录时创建，随真实操作
 * 滑动，超时自行销毁。密钥库的授权挂在会话上，所以「解开了库」这件事只属于
 * 一个会话，不会因为别人也持有管理密钥而共享。
 *
 * ## 面板这边的约定
 *
 * - 登录成功后 `ensure()`：复用仍然有效的令牌，否则新建一个。刷新页面（F5）
 *   因此落在同一个会话里，不会重复要主密码。
 * - 只有**用户主动操作**才 `touch()`；后台轮询不能续命，否则永远不会超时。
 * - 登出 `end()`：结束会话并丢掉令牌。服务端同时撤销该会话的凭据授权。
 */

import { apiClient } from './client';
import {
  clearSessionToken,
  markSessionEstablished,
  readSessionToken,
  SESSION_HEADER,
  writeSessionToken,
} from './sessionToken';
import type { AxiosAdapter, AxiosRequestConfig } from 'axios';

/** 会话描述（GET/POST `/session`）。 */
export interface ManagementSession {
  id: string;
  client_ip?: string;
  /** 凭据授权的空闲上限（秒）：只有真实操作会重置它。 */
  idle_seconds: number;
  /** 浏览器会话的空闲上限（秒）：到点整个会话结束，面板据此登出。 */
  panel_idle_seconds?: number;
  /** 绝对上限（秒）：到点必死，谁也续不了。 */
  absolute_seconds: number;
  expires_at: string;
  /** 本会话是否已解锁凭据。 */
  unlocked: boolean;
  /** 后端自身的凭据访问能力：machine（常驻）/ session（有人解锁）/ none。 */
  system_access: 'machine' | 'session' | 'none';
}

/**
 * 会话请求的可选传输参数。
 *
 * `renewal` 标记「这是面板自己在找回会话」。这类请求的 401 由调用方消化，
 * 不该再由 `apiClient` 派发全局登出 —— 否则一次失败会登出两次（第二次是多余的，
 * 更糟的是它发生在调用方还没决定要不要登出之前）。`adapter` 只给测试用。
 */
interface SessionRequestOptions {
  adapter?: AxiosAdapter;
  renewal?: boolean;
}

function sessionRequestConfig(options: SessionRequestOptions): AxiosRequestConfig {
  return {
    ...(options.adapter ? { adapter: options.adapter } : {}),
    ...(options.renewal ? { cpaSessionRenewal: true } : {}),
  } as AxiosRequestConfig;
}

export const sessionApi = {
  /**
   * 新建会话并保存令牌。
   *
   * `persistent` 只影响浏览器保存会话凭据的方式：true 时服务端下发的 cookie 会
   * 带寿命（关掉浏览器再打开仍是同一个会话），false 时是浏览器会话 cookie
   * （关掉浏览器就结束）。会话本身在服务端仍受绝对上限约束。
   */
  async start(persistent = false, options: SessionRequestOptions = {}): Promise<ManagementSession> {
    const session = await apiClient.post<ManagementSession & { token?: string }>(
      '/session',
      { persistent },
      sessionRequestConfig(options)
    );
    if (session?.token) writeSessionToken(session.token);
    return session;
  },

  /** 读取当前会话；令牌失效时抛 401。 */
  async describe(options: SessionRequestOptions = {}): Promise<ManagementSession> {
    // 探测必须显式带上存下来的令牌：请求拦截器只在「本次加载已确认会话」后
    // 才自动挂它，而这一步正是去确认这件事的。
    const token = readSessionToken();
    return apiClient.get<ManagementSession>('/session', {
      ...sessionRequestConfig(options),
      ...(token ? { headers: { [SESSION_HEADER]: token } } : {}),
    });
  },

  /** 续期：只在真实用户操作时调用。 */
  async touch(options: SessionRequestOptions = {}): Promise<ManagementSession> {
    return apiClient.post<ManagementSession>(
      '/session/touch',
      undefined,
      sessionRequestConfig(options)
    );
  },

  /** 结束会话并丢掉令牌。 */
  async end(): Promise<void> {
    try {
      await apiClient.delete('/session');
    } finally {
      clearSessionToken();
    }
  },
};

/**
 * 取得一个可用会话：有令牌且仍有效就复用，否则新建。
 *
 * 复用是必要的 —— 刷新页面时令牌还在，会话还是同一个，凭据授权也还在；
 * 每次都新建会让 F5 变成「重新要主密码」，而刷新不是会话边界。
 *
 * `persistent` 只在新建会话时使用，含义见 `sessionApi.start`。
 */
export async function ensureManagementSession(persistent = false): Promise<ManagementSession> {
  if (readSessionToken()) {
    try {
      const session = await sessionApi.describe();
      markSessionEstablished();
      return session;
    } catch {
      // 令牌过期或服务端重启过：当作没有，下面新建。
      clearSessionToken();
    }
  }
  return sessionApi.start(persistent);
}

/**
 * 续期的节流间隔。
 *
 * 服务端的空闲窗口是分钟级，没必要每次鼠标移动都打一条请求；一分钟一次足够
 * 让会话在「一直在用」时不过期。
 */
const TOUCH_INTERVAL_MS = 60_000;
let lastTouchAt = 0;

/**
 * 续期结果。
 *
 * - `ok`：服务端认得这个会话，时钟已经推进（或被节流跳过）。
 * - `renewed`：令牌作废了，但会话已经**悄悄**接上（cookie 优先，其次管理密钥）。
 *   调用方应当把空闲时钟重新起算 —— 这是另一个会话了。
 * - `ended`：接不上（没有 cookie、内存里也没有管理密钥）。这时才真的结束登录态，
 *   由本函数派发 `unauthorized`。
 */
export type TouchOutcome = 'ok' | 'renewed' | 'ended';

/**
 * 服务端给出的拒绝原因（见 `sessions.go` 的 `sessionErrorReason`）。
 *
 * 它只用来把话说清楚：`idle`/`absolute` 是「这个浏览器被服务端判定离开太久」，
 * `missing`/`expired` 是「不认识这个令牌」（服务端重启过、会话被清掉），
 * `ip` 是「运维显式开启了地址绑定，而地址变了」。前两种必须登出、后两种才重建，
 * 见 `recoverRefusedTouch`。
 */
type TouchRefusalReason = 'idle' | 'absolute' | 'ip' | 'missing' | 'expired';

function touchRefusalReason(error: unknown): TouchRefusalReason {
  const details = (error as { details?: { reason?: unknown } })?.details;
  const reason = details?.reason;
  if (reason === 'idle' || reason === 'absolute' || reason === 'ip') return reason;
  if (reason === 'missing') return 'missing';
  return 'expired';
}

/**
 * 续期被拒之后的处理。**按原因分流**，因为「令牌不认识了」和「你该下线了」
 * 是两件完全不同的事。
 *
 * - `idle` / `absolute`：服务端按空闲时钟或绝对上限判死了这个会话，也就是
 *   「人离开了」。**不重建**。重建在这里不只是无意义，而是会**废掉服务端那条
 *   规则**：只要「记住密码」把密钥留在内存里，一次后台轮询的 401 就能把因空闲
 *   被判死的会话悄悄接回来，「10 分钟无操作才踢」在服务端那一侧就形同虚设
 *   （sessions.go 的头注释写得很清楚：background polling must not keep a
 *   session alive）。所以直接登出。
 * - `ip`：运维用 `CPA_SESSION_BIND_IP=1` 显式要求的拒绝，重建等于绕开它。登出。
 * - `missing` / `expired`：服务端**不认识这个令牌**了 —— 进程重启过、会话被
 *   清理过、cookie 与 header 不是同一个。这跟「该下线了」无关，重建它正是要
 *   修的那个「部署重启把正在用的面板踢回登录页」。
 *
 * 一句话：重建只用来兜住「服务端换了个进程」，不用来兜住「你该下线了」。
 *
 * 重建的顺序是刻意的：
 *
 * - cookie 还在 → `GET /session` 直接复用**同一个**会话，凭据库仍然开着；
 * - cookie 没了 → 内存里的管理密钥换一个新会话（新会话是锁着的，主密码要重新过）。
 *
 * 顺序不能反：先新建会话会丢掉 cookie 那条路上的解锁授权，等于每次令牌过期都要
 * 重新输主密码。两条都走不通才派发 `unauthorized`。
 */
async function recoverRefusedTouch(
  error: unknown,
  persistent: boolean,
  adapter?: AxiosAdapter
): Promise<TouchOutcome> {
  const status = (error as { status?: number })?.status;
  // 网络抖动不是会话问题：留给下一次真实活动重试，不动登录态。
  if (status !== 401) return 'ok';

  const reason = touchRefusalReason(error);
  // 死令牌必须丢掉：留着它，接下来每条请求都还会被它带坏。
  clearSessionToken();
  if (reason === 'idle' || reason === 'absolute' || reason === 'ip') {
    // "You should be signed out" or an operator-required refusal: rebuilding
    // would defeat the rule that produced the refusal.
    console.warn(`Session touch refused (${reason}); ending the session.`);
    window.dispatchEvent(new Event('unauthorized'));
    return 'ended';
  }
  console.warn(`Session touch refused (${reason}); rebuilding the session.`);

  // 1) The browser's own cookie. `describe` sends no header token when there is
  //    none stored, so the server answers from the cookie — the same session, with
  //    its credential unlock intact.
  try {
    await sessionApi.describe({ adapter, renewal: true });
    markSessionEstablished();
    return 'renewed';
  } catch {
    // No usable cookie; fall through to the management key.
  }

  // 2) A new session from the key in memory. Only reachable when "remember the
  //    password" kept it, or when the operator typed it this load.
  try {
    await sessionApi.start(persistent, { adapter, renewal: true });
    return 'renewed';
  } catch {
    // Nothing to rebuild from: this is a real sign-out.
    window.dispatchEvent(new Event('unauthorized'));
    return 'ended';
  }
}

/**
 * 用一次真实用户操作续期服务端会话。
 *
 * 失败不抛给调用方：被拒绝时先试着把会话接回来（见 `recoverRefusedTouch`），
 * 接不回来才登出；网络抖动则留给下一次活动重试——续期失败本身不该变成用户可见
 * 的错误。
 */
export interface TouchSessionOptions {
  /** 跳过节流。守卫在拿到一个新会话之后会立刻补一次，那一次不能被上一轮挡掉。 */
  force?: boolean;
  /** 重建会话时 cookie 的寿命，跟着「记住密码」走。 */
  persistent?: boolean;
  /** 传输层适配器，仅测试使用。 */
  adapter?: AxiosAdapter;
}

export async function touchSession(options: TouchSessionOptions = {}): Promise<TouchOutcome> {
  // 不要求本地有令牌：会话也可以只由 cookie 认证（比如本地存储被清过、或
  // 刷新后靠 cookie 恢复）。这时提前返回会让服务端的时钟永远不被推进，
  // 于是一个正在使用面板的人也会在窗口到点时被登出。
  const now = Date.now();
  if (!options.force && now - lastTouchAt < TOUCH_INTERVAL_MS) return 'ok';
  lastTouchAt = now;
  try {
    await sessionApi.touch({ adapter: options.adapter });
    return 'ok';
  } catch (error) {
    return recoverRefusedTouch(error, options.persistent === true, options.adapter);
  }
}
