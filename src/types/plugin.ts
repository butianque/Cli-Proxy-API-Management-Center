export type PluginConfigFieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'array'
  | 'object';

export interface PluginConfigField {
  name: string;
  type: PluginConfigFieldType | string;
  enumValues: string[];
  description: string;
}

export type PluginConfigObject = Record<string, unknown>;

export interface PluginMetadata {
  name: string;
  version: string;
  author: string;
  githubRepository: string;
  logo: string;
  configFields: PluginConfigField[];
}

export interface PluginMenu {
  path: string;
  menu: string;
  description: string;
}

export interface PluginListEntry {
  id: string;
  path: string;
  configured: boolean;
  registered: boolean;
  enabled: boolean;
  effectiveEnabled: boolean;
  supportsOAuth: boolean;
  oauthProvider?: string;
  /**
   * 该插件可登录的 provider 键；缺省时回落到 `oauthProvider`。
   * 宿主对多键插件只暴露单个 `quotaProvider`，面板的额度通道索引用它补齐其余键。
   */
  oauthProviders?: string[];
  /** provider 键 → 面向使用者的短标签；缺省即无标签。 */
  oauthProviderLabels?: Record<string, string>;
  /** 宿主是否为该插件注册了额度通道（`quota_provider` 非空即为真）。 */
  supportsQuota: boolean;
  /** 该插件负责额度的 provider 键；缺省即无额度通道。 */
  quotaProvider?: string;
  /** 该插件的登录会读取指纹浏览器选项；只有为真时才应渲染那个开关。 */
  supportsFingerprintBrowser: boolean;
  logo: string;
  configFields: PluginConfigField[];
  menus: PluginMenu[];
  metadata: PluginMetadata | null;
}

export interface PluginListResponse {
  pluginsEnabled: boolean;
  pluginsDir: string;
  plugins: PluginListEntry[];
}

export interface PluginDeleteResult {
  status: string;
  id: string;
  path: string;
  fileDeleted: boolean;
  configuredRemoved: boolean;
  restartRequired: boolean;
}

export interface PluginStoreEntry {
  storeId: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  repository: string;
  installType: string;
  authRequired: boolean;
  authConfigured: boolean;
  platforms: PluginStorePlatform[];
  logo: string;
  homepage: string;
  license: string;
  tags: string[];
  installed: boolean;
  installedVersion: string;
  path: string;
  configured: boolean;
  registered: boolean;
  enabled: boolean;
  effectiveEnabled: boolean;
  updateAvailable: boolean;
}

export interface PluginStorePlatform {
  goos: string;
  goarch: string;
}

export interface PluginStoreSourceError {
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  message: string;
}

export interface PluginStoreResponse {
  pluginsEnabled: boolean;
  pluginsDir: string;
  sourceErrors: PluginStoreSourceError[];
  plugins: PluginStoreEntry[];
}

export interface PluginStoreInstallResult {
  status: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  id: string;
  version: string;
  installType: string;
  path: string;
  pluginsEnabled: boolean;
  restartRequired: boolean;
}
