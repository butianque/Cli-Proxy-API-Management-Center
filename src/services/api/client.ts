/**
 * Axios API 客户端
 * 替代原项目 src/core/api-client.js
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import type { ApiClientConfig, ApiError } from '@/types';
import {
  BUILD_DATE_HEADER_KEYS,
  CPA_BUILD_DATE_HEADER_KEYS,
  CPA_SUPPORT_PLUGIN_HEADER_KEYS,
  CPA_VERSION_HEADER_KEYS,
  REQUEST_TIMEOUT_MS,
  VERSION_HEADER_KEYS,
} from '@/utils/constants';
import { computeApiUrl } from '@/utils/connection';
import { parseApiErrorResponse } from './apiError';
import {
  isSessionEstablished,
  readSessionToken,
  SESSION_HEADER,
  writeSessionToken,
} from './sessionToken';

/**
 * 携带主密码的路由：401 只表示「主密码不符」，不表示会话失效。
 *
 * 这些路由的 401 与「管理密钥无效」的 401 同码但语义不同，而管理密钥无效在
 * 已登录状态下不可能出现（登录本身就会校验），故按路径放行是安全的：
 * 既避免填错主密码被登出，也不会掩盖真正的会话失效。
 */
const PASSPHRASE_ROUTES = ['/secrets/verify', '/secrets/unlock', '/secrets/passphrase'];

function isPassphraseRoute(url: string | undefined): boolean {
  if (!url) return false;
  return PASSPHRASE_ROUTES.some((route) => url.split('?')[0].endsWith(route));
}

/**
 * 会话令牌只随「已经存在的会话」发出。新建会话这一条必须不带：带着一个过期
 * 令牌去开会话，服务端会先按过期令牌拒绝，反而开不出新的。
 */
function carriesSessionToken(method: string | undefined, url: string | undefined): boolean {
  const path = (url || '').split('?')[0];
  return !((method || 'get').toLowerCase() === 'post' && path.endsWith('/session'));
}

/**
 * 面板标记头。
 *
 * 服务端除了管理密钥还认一种凭据：登录时下发的 HttpOnly 会话 cookie。cookie 由
 * 浏览器自动携带，所以它能挡住「别的站点伪造一个表单提交」的只有 SameSite ——
 * 而 SameSite 划的是**可注册域**，同域下的兄弟主机（比如 api.example.com 向
 * cpa.example.com 提交）依然会带上它。这个头表单设不了，服务端见不到它就拒绝
 * cookie 认证。它同时也是一条可读的「这条请求来自面板」的标记。
 */
const PANEL_HEADER = 'X-CPA-Panel';

/**
 * 探测当前会话是否还有效（`GET /session`）。
 *
 * 这条请求的 401 意思是「手上这个令牌不能用了」，而不是「你被踢下线了」——
 * 它唯一的调用方是登录/恢复连接时的 `ensureManagementSession`，那里会立刻丢掉
 * 旧令牌、开一个新会话。若也按会话失效处理，浏览器里留着一个上次进程的令牌
 * （后端重启过、或空闲超时后关掉了页面）就会把登录本身打成「认证失败」。
 */
function isSessionProbe(method: string | undefined, url: string | undefined): boolean {
  if (!url) return false;
  const verb = (method || 'get').toLowerCase();
  return verb === 'get' && url.split('?')[0].endsWith('/session');
}

/**
 * 会话令牌会随后端进程一起消失，但打开的标签页不会：重启之后，页面上每个请求
 * 都带着一个服务端已经不认识的令牌，于是每一条都 401。
 *
 * 这个 401 说的是**令牌**，不是管理密钥。所以这里就地换一个新会话再重放一次原
 * 请求，只有换不到会话（管理密钥真的不对）才按「被登出」处理。否则每次部署重启
 * 都会把一个正在用的面板踢回登录页 —— 那是把「服务端换了个进程」误报成「你的
 * 密钥失效了」。
 */
type SessionAwareConfig = AxiosRequestConfig & {
  /** 这条请求已经因为会话失效重放过一次，不再递归。 */
  cpaSessionRetried?: boolean;
  /** 这是面板自己发的换会话请求，它的 401 由调用方消化。 */
  cpaSessionRenewal?: boolean;
};

function sentSessionToken(config: AxiosRequestConfig | undefined): boolean {
  const headers = config?.headers as
    | (Record<string, unknown> & { get?: (name: string) => unknown })
    | undefined;
  if (!headers) return false;
  if (typeof headers.get === 'function') return Boolean(headers.get(SESSION_HEADER));
  return Boolean(headers[SESSION_HEADER]);
}

class ApiClient {
  private instance: AxiosInstance;
  private apiBase: string = '';
  private managementKey: string = '';
  private connectionRevision = 0;
  /** 正在进行中的会话续期，供并发的 401 共用（见 renewSession）。 */
  private sessionRenewal: Promise<boolean> | null = null;

  constructor() {
    this.instance = axios.create({
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.setupInterceptors();
  }

  /**
   * 设置 API 配置
   */
  setConfig(config: ApiClientConfig): void {
    const apiBase = computeApiUrl(config.apiBase);
    if (apiBase !== this.apiBase || config.managementKey !== this.managementKey) {
      this.connectionRevision += 1;
    }
    this.apiBase = apiBase;
    this.managementKey = config.managementKey;

    if (config.timeout) {
      this.instance.defaults.timeout = config.timeout;
    } else {
      this.instance.defaults.timeout = REQUEST_TIMEOUT_MS;
    }
  }

  /** Guards read/modify/write operations across connection changes, including ABA switches. */
  getConnectionRevision(): number {
    return this.connectionRevision;
  }

  private readHeader(headers: Record<string, unknown> | undefined, keys: string[]): string | null {
    if (!headers) return null;

    const normalizeValue = (value: unknown): string | null => {
      if (value === undefined || value === null) return null;
      if (Array.isArray(value)) {
        const first = value.find(
          (entry) => entry !== undefined && entry !== null && String(entry).trim()
        );
        return first !== undefined ? String(first) : null;
      }
      const text = String(value);
      return text ? text : null;
    };

    const headerGetter = (headers as { get?: (name: string) => unknown }).get;
    if (typeof headerGetter === 'function') {
      for (const key of keys) {
        const match = normalizeValue(headerGetter.call(headers, key));
        if (match) return match;
      }
    }

    const entries =
      typeof (headers as { entries?: () => Iterable<[string, unknown]> }).entries === 'function'
        ? Array.from((headers as { entries: () => Iterable<[string, unknown]> }).entries())
        : Object.entries(headers);

    const normalized = Object.fromEntries(
      entries.map(([key, value]) => [String(key).toLowerCase(), value])
    );
    for (const key of keys) {
      const match = normalizeValue(normalized[key.toLowerCase()]);
      if (match) return match;
    }
    return null;
  }

  private readBooleanHeader(
    headers: Record<string, unknown> | undefined,
    keys: string[]
  ): boolean | null {
    const value = this.readHeader(headers, keys);
    if (value === null) return null;

    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return null;
  }

  /**
   * 设置请求/响应拦截器
   */
  private setupInterceptors(): void {
    // 请求拦截器
    this.instance.interceptors.request.use(
      (config) => {
        // 设置 baseURL
        config.baseURL = this.apiBase;

        // 添加认证头
        if (this.managementKey) {
          config.headers.Authorization = `Bearer ${this.managementKey}`;
        }

        // 面板标记：服务端只对带这个头的请求接受 cookie 认证（见 PANEL_HEADER）。
        config.headers[PANEL_HEADER] = '1';

        // 会话令牌：证明「哪个会话在问」，凭据读写只认它。
        //
        // 只在本次加载已经确认过会话时才挂上（见 sessionToken.ts）：localStorage
        // 里的令牌可能是上一次进程留下的，先拿它去发请求只会被 401 拒掉。
        if (carriesSessionToken(config.method, config.url) && isSessionEstablished()) {
          const sessionToken = readSessionToken();
          if (sessionToken) {
            config.headers[SESSION_HEADER] = sessionToken;
          }
        }

        return config;
      },
      (error) => Promise.reject(this.handleError(error))
    );

    // 响应拦截器
    this.instance.interceptors.response.use(
      (response) => {
        const headers = response.headers as Record<string, string | undefined>;
        const cpaVersion = this.readHeader(headers, CPA_VERSION_HEADER_KEYS);
        const cpaBuildDate = this.readHeader(headers, CPA_BUILD_DATE_HEADER_KEYS);
        const version = cpaVersion || this.readHeader(headers, VERSION_HEADER_KEYS);
        const buildDate = cpaBuildDate || this.readHeader(headers, BUILD_DATE_HEADER_KEYS);
        const supportsPlugin = this.readBooleanHeader(headers, CPA_SUPPORT_PLUGIN_HEADER_KEYS);

        // 触发版本更新事件（后续通过 store 处理）
        if (version || buildDate) {
          window.dispatchEvent(
            new CustomEvent('server-version-update', {
              detail: { version: version || null, buildDate: buildDate || null },
            })
          );
        }
        if (supportsPlugin !== null) {
          window.dispatchEvent(
            new CustomEvent('server-plugin-support-update', {
              detail: { supportsPlugin },
            })
          );
        }

        return response;
      },
      async (error) => {
        if (this.shouldRenewSession(error)) {
          const config = error.config as SessionAwareConfig | undefined;
          const renewed = await this.renewSession(config?.adapter);
          if (renewed && config) {
            return this.instance.request(this.replayConfig(config));
          }
        }
        return Promise.reject(this.handleError(error));
      }
    );
  }

  /** 这次 401 是「令牌过期」而不是「密钥不对」，值得就地换一个会话。 */
  private shouldRenewSession(error: unknown): boolean {
    if (!axios.isAxiosError(error)) return false;
    if (error.response?.status !== 401) return false;
    const config = error.config as SessionAwareConfig | undefined;
    if (!config || config.cpaSessionRetried) return false;
    if (!sentSessionToken(config)) return false;
    if (isPassphraseRoute(config.url) || isSessionProbe(config.method, config.url)) return false;
    return true;
  }

  /**
   * 用当前管理密钥换一个新会话。
   *
   * 并发的多个 401 共用同一次换会话：三个请求同时过期时不该开三个会话。换失败
   * 只返回 false，让调用方照常走登出；这里不抛错，免得把 401 变成别的样子。
   */
  private renewSession(adapter: AxiosRequestConfig['adapter']): Promise<boolean> {
    if (this.sessionRenewal) return this.sessionRenewal;
    const revision = this.connectionRevision;
    const renewal = this.instance
      .post<{ token?: string }>(
        '/session',
        undefined,
        { cpaSessionRenewal: true, ...(adapter ? { adapter } : {}) } as SessionAwareConfig
      )
      .then((response) => {
        const token = response.data?.token;
        // 换会话期间连接被换掉（重新登录/切服务器）：新令牌不属于这次请求。
        if (!token || this.connectionRevision !== revision) return false;
        writeSessionToken(token);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        if (this.sessionRenewal === renewal) this.sessionRenewal = null;
      });
    this.sessionRenewal = renewal;
    return renewal;
  }

  /**
   * 重放用的一次性请求配置。
   *
   * 旧令牌必须摘掉：它已经失效，留着只会让重放再 401 一次。标记 `cpaSessionRetried`
   * 让重放本身失败时走正常错误路径，不再递归换会话。
   */
  private replayConfig(config: SessionAwareConfig): SessionAwareConfig {
    const headers = config.headers as
      | (Record<string, unknown> & { delete?: (name: string) => void })
      | undefined;
    if (headers) {
      if (typeof headers.delete === 'function') headers.delete(SESSION_HEADER);
      else delete headers[SESSION_HEADER];
    }
    return { ...config, cpaSessionRetried: true };
  }

  /**
   * 错误处理
   */
  private handleError(error: unknown): ApiError {
    if (axios.isAxiosError(error)) {
      const responseData: unknown = error.response?.data;
      const parsedError = parseApiErrorResponse(responseData, error.message);
      const apiError = new Error(parsedError.message) as ApiError;
      apiError.name = 'ApiError';
      apiError.status = error.response?.status;
      apiError.code = error.code;
      apiError.apiCode = parsedError.apiCode;
      apiError.details = responseData;
      apiError.data = responseData;

      // 401 未授权 - 触发登出事件。例外：携带主密码的三条路由，401 表示「主密码
      // 不符」而不是「会话失效」，属于可就地更正的输入错误，绝不能让操作者登出
      // （旧主密码填错只应提示重填，而不是把人踢回登录页）。
      //
      // 换会话那条请求的 401 也不在此列：它由 renewSession 自己消化，随后原来
      // 那条请求会带着「仍然失败」的结果走到这里，登出只发生一次。
      if (
        error.response?.status === 401 &&
        !isPassphraseRoute(error.config?.url) &&
        !isSessionProbe(error.config?.method, error.config?.url) &&
        !(error.config as SessionAwareConfig | undefined)?.cpaSessionRenewal
      ) {
        window.dispatchEvent(new Event('unauthorized'));
      }

      return apiError;
    }

    const fallbackMessage =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Unknown error occurred';
    const fallback = new Error(fallbackMessage) as ApiError;
    fallback.name = 'ApiError';
    return fallback;
  }

  /**
   * GET 请求
   */
  async get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.instance.get<T>(url, config);
    return response.data;
  }

  /**
   * POST 请求
   */
  async post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.instance.post<T>(url, data, config);
    return response.data;
  }

  /**
   * PUT 请求
   */
  async put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.instance.put<T>(url, data, config);
    return response.data;
  }

  /**
   * PATCH 请求
   */
  async patch<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.instance.patch<T>(url, data, config);
    return response.data;
  }

  /**
   * DELETE 请求
   */
  async delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.instance.delete<T>(url, config);
    return response.data;
  }

  /**
   * 获取原始响应（用于下载等场景）
   */
  async getRaw(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse> {
    return this.instance.get(url, config);
  }

  /**
   * 发送 FormData
   */
  async postForm<T = unknown>(
    url: string,
    formData: FormData,
    config?: AxiosRequestConfig
  ): Promise<T> {
    const response = await this.instance.post<T>(url, formData, {
      ...config,
      headers: {
        ...(config?.headers || {}),
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  }
}

// 导出单例
export const apiClient = new ApiClient();
