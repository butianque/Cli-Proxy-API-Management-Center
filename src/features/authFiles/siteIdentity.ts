/**
 * 凭证站点：一条凭证属于哪个上游，用「产品 + 国内/国际 + 域名」三件事说清。
 * 卡片徽标与过滤 tab 只留产品名，域名落在卡片的「站点」行，不再拼
 * 「国际站·WorkBuddy」这类又长又重复的名字。
 *
 * React-free —— 由 tests/accountPool.test.ts 直接消费。
 *
 * 键是宿主的 provider 键：插件按登录站点声明，一条凭证一个键。键 → 域名是
 * 固定映射，不是猜测——每个键在上游只对应一个域名。没有映射的键返回 null，
 * 调用方回落到 i18n 标签，绝不凭空补一个站点。
 */

export type CredentialRegion = 'cn' | 'intl';

export type CredentialSite = {
  /** 产品名（品牌原名，不翻译）：卡片徽标与 tab 主行。 */
  brand: string;
  region: CredentialRegion;
  /** 上游域名：卡片「站点」行。 */
  domain: string;
};

const SITE_BY_PROVIDER_KEY: Readonly<Record<string, CredentialSite>> = {
  'workbuddy-cn': { brand: 'WorkBuddy', region: 'cn', domain: 'copilot.tencent.com' },
  'workbuddy-intl': { brand: 'CodeBuddy', region: 'intl', domain: 'codebuddy.ai' },
  'workbuddy-global': { brand: 'WorkBuddy', region: 'intl', domain: 'workbuddy.ai' },
  'zcode-bigmodel': { brand: '智谱', region: 'cn', domain: 'bigmodel.cn' },
  'zcode-zai': { brand: 'Z.ai', region: 'intl', domain: 'z.ai' },
};

/** 按 provider 键查站点；未登记返回 null（不造站点）。 */
export const resolveCredentialSite = (providerKey: string): CredentialSite | null => {
  const key = providerKey.trim().toLowerCase();
  return SITE_BY_PROVIDER_KEY[key] ?? null;
};
