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

export const sessionApi = {
  /**
   * 新建会话并保存令牌。
   *
   * `persistent` 只影响浏览器保存会话凭据的方式：true 时服务端下发的 cookie 会
   * 带寿命（关掉浏览器再打开仍是同一个会话），false 时是浏览器会话 cookie
   * （关掉浏览器就结束）。会话本身在服务端仍受绝对上限约束。
   */
  async start(persistent = false): Promise<ManagementSession> {
    const session = await apiClient.post<ManagementSession & { token?: string }>('/session', {
      persistent,
    });
    if (session?.token) writeSessionToken(session.token);
    return session;
  },

  /** 读取当前会话；令牌失效时抛 401。 */
  async describe(): Promise<ManagementSession> {
    // 探测必须显式带上存下来的令牌：请求拦截器只在「本次加载已确认会话」后
    // 才自动挂它，而这一步正是去确认这件事的。
    const token = readSessionToken();
    return apiClient.get<ManagementSession>(
      '/session',
      token ? { headers: { [SESSION_HEADER]: token } } : undefined
    );
  },

  /** 续期：只在真实用户操作时调用。 */
  async touch(): Promise<ManagementSession> {
    return apiClient.post<ManagementSession>('/session/touch');
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
 * 用一次真实用户操作续期服务端会话。
 *
 * 失败不抛给调用方：401 由 `apiClient` 统一转成登出，网络抖动则留给下一次活动
 * 重试——续期失败本身不该变成用户可见的错误。
 */
export async function touchSession(): Promise<void> {
  // 不要求本地有令牌：会话也可以只由 cookie 认证（比如本地存储被清过、或
  // 刷新后靠 cookie 恢复）。这时提前返回会让服务端的时钟永远不被推进，
  // 于是一个正在使用面板的人也会在窗口到点时被登出。
  const now = Date.now();
  if (now - lastTouchAt < TOUCH_INTERVAL_MS) return;
  lastTouchAt = now;
  try {
    await sessionApi.touch();
  } catch {
    // Intentionally ignored; see the doc comment.
  }
}
