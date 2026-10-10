/**
 * 配置相关 API
 */

import { apiClient } from './client';
import type { Config } from '@/types';
import { normalizeConfigResponse } from './transformers';

export const configApi = {
  /**
   * 获取配置（会进行字段规范化）
   */
  async getConfig(): Promise<Config> {
    const raw = await apiClient.get('/config');
    return normalizeConfigResponse(raw);
  },

  /**
   * 请求日志开关
   */
  updateRequestLog: (enabled: boolean) =>
    apiClient.put('/config/observability/logs/request-log', enabled),

  /**
   * 更换管理密钥。
   *
   * 只提交 management.secret-key 一个键，配置其余部分不动；后端写入并热重载，
   * 新密钥返回即生效（无需重启）。换完当前会话仍持有旧密钥，调用方须同步更新。
   */
  changeManagementKey: (key: string) =>
    apiClient.patch('/config', { management: { 'secret-key': key } }),
};
