/**
 * 基座密钥库 API（`/v8/management/secrets/*`）。
 *
 * 这是**基座**能力，不属于任何一个插件：校验 / 解锁 / 锁定 / 更换主密码，以及
 * 「库里存了哪些密文」。所以它独立成模块 —— 配置页的「安全管理」与接码面板的
 * 主密码门都调它；接码各类别自己的路由（如 `/v8/management/supply/phone/*`）
 * 留在各自的域模块里（`sms.ts`）。
 */

import { apiClient } from './client';

/** 密钥库状态（GET /v8/management/secrets）。 */
export interface SecretStoreStatus {
  enabled: boolean;
  initialized: boolean;
  unlocked: boolean;
  /** 是否已安装主密码。 */
  passphrase: boolean;
  mode: string;
  names: string[];
}

export const secretStoreApi = {
  /** 读取密钥库状态。 */
  async getStatus(): Promise<SecretStoreStatus> {
    return apiClient.get<SecretStoreStatus>('/secrets');
  },

  /** 校验主密码（不改变解锁状态；成功不等于已解锁）。 */
  async verifyPassphrase(passphrase: string): Promise<boolean> {
    const result = await apiClient.post<{ verified?: boolean }>('/secrets/verify', { passphrase });
    return result?.verified === true;
  },

  /** 用主密码解锁密钥库。成功后库内密文可读，直到被 Lock。 */
  async unlock(passphrase: string): Promise<SecretStoreStatus> {
    return apiClient.post<SecretStoreStatus>('/secrets/unlock', { passphrase });
  },

  /** 锁定密钥库（丢弃内存中的 key）。 */
  async lock(): Promise<SecretStoreStatus> {
    return apiClient.post<SecretStoreStatus>('/secrets/lock', {});
  },

  /**
   * 更换主密码。
   *
   * 后端要求「先解锁、再更换」（锁定态直接更换会被拒绝），所以这里把两步合成
   * 一次调用，调用方无法把顺序弄错。当前主密码不对会以 401 抛出——那是「主密码
   * 不符」而非会话失效，由调用方就地提示。
   */
  async setPassphrase(current: string, next: string): Promise<SecretStoreStatus> {
    await apiClient.post('/secrets/unlock', { passphrase: current });
    return apiClient.post<SecretStoreStatus>('/secrets/passphrase', { current, next });
  },

  /** 全新密钥库首次安装主密码（已安装的库会被拒绝，不会静默覆盖）。 */
  async initialize(passphrase: string): Promise<SecretStoreStatus> {
    return apiClient.post<SecretStoreStatus>('/secrets/initialize', { passphrase });
  },
};
