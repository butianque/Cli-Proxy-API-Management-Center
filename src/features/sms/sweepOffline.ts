/**
 * 扫活：从台账里挑出**现在真的连不上**的邮箱。
 *
 * 这一块只做判断，不发请求、不渲染 —— 判断规则写在这里，是因为它是这一页最容易
 * 说谎的一处：把「没测成」说成「坏了」，人会去重新导入一个好好的号；把「坏了」
 * 说成「不知道」，那个号就一直躺在池子里占着位置。
 *
 * 所以答案只有三种，且每一种都有唯一依据：
 *
 * - **在线**：基座真的连上了这个信箱。
 * - **离线**：基座连了一次、失败了；或者密钥库里**确定**没有它的凭据 ——
 *   后者连试都不用试，它注定打不开。
 * - **判断不了**：没测到（密钥库锁着、地址认不出来、探活没实现）。这一种不进
 *   离线清单，也不假装它是在线。
 *
 * 范围只有**自带凭据的邮箱**。渠道发出来的地址（`mailbox === null`）自己不收信，
 * 它的信落在那条渠道的信箱里 —— 渠道通不通由渠道那一页回答，这里再问一遍只会
 * 得到同一个答案的另一个说法。
 */

import type { MailboxProbe, PoolEntry, SupplyProbeState } from './types';

/**
 * 一次探活请求带多少个地址。
 *
 * 与基座的上限一致：它按 40 封顶，多出来的部分它不会测，也不会报错 —— 那就会
 * 出现「扫过了、结果里没有」的静默漏检。分片在面板这一侧做，进度才有得报。
 */
export const PROBE_CHUNK_SIZE = 40;

/** 一个邮箱为什么算离线。两种原因的下一步不同，所以要分开。 */
export type OfflineCause =
  /** 密钥库里没有它的凭据：这个号现在没有能用来收信的东西。 */
  | 'credential-missing'
  /** 凭据在，但连不上：通常是令牌过期或账号被停用。 */
  | 'unreachable';

export interface OfflineMailbox {
  entry: PoolEntry;
  cause: OfflineCause;
  /** 基座给的一句话（失败原因）；空字符串 = 没有可说的。 */
  detail: string;
}

export interface SweepVerdict {
  /** 真的连不上：这份清单里的每一个都值得处理。 */
  offline: OfflineMailbox[];
  online: PoolEntry[];
  /** 这次判断不了：既不进离线清单，也不算通过。 */
  unknown: PoolEntry[];
}

/** 这次扫活要不要检查这一个身份。 */
export function isSweepCandidate(entry: PoolEntry): boolean {
  return entry.kind === 'email' && entry.mailbox !== null && entry.identity.trim() !== '';
}

/** 当前台账里所有该检查的身份。 */
export function sweepCandidates(entries: PoolEntry[]): PoolEntry[] {
  return entries.filter(isSweepCandidate);
}

/**
 * 待检查的地址，按小写去重。
 *
 * 同一个信箱下的多个地址共用一份凭据，连一次就够；重复问只会让同一次失败在
 * 清单里出现好几遍。
 */
export function sweepAddresses(entries: PoolEntry[]): string[] {
  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const entry of entries) {
    const address = entry.identity.trim().toLowerCase();
    if (!isSweepCandidate(entry) || address === '' || seen.has(address)) continue;
    seen.add(address);
    addresses.push(address);
  }
  return addresses;
}

/** 按基座的上限切片。空数组不产生分片，调用方不必自己判空。 */
export function chunkAddresses(addresses: string[]): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < addresses.length; start += PROBE_CHUNK_SIZE) {
    chunks.push(addresses.slice(start, start + PROBE_CHUNK_SIZE));
  }
  return chunks;
}

/**
 * 探活结果 → 三份清单。
 *
 * 判据只有上面那三条，没有第四种解释：探活说 `offline` 才算连不上；说
 * `unready` / `unsupported`、或者根本没给这个地址的结论，都是「判断不了」。
 */
export function classifyOffline(
  entries: PoolEntry[],
  probes: Map<string, MailboxProbe>
): SweepVerdict {
  const verdict: SweepVerdict = { offline: [], online: [], unknown: [] };
  for (const entry of sweepCandidates(entries)) {
    const probe = probes.get(entry.identity.trim().toLowerCase());
    const state: SupplyProbeState | undefined = probe?.state;
    if (state === 'online') {
      verdict.online.push(entry);
      continue;
    }
    if (state === 'offline') {
      verdict.offline.push({ entry, cause: 'unreachable', detail: probe?.detail ?? '' });
      continue;
    }
    // 只有「凭据确定不在」这一种情况能不看探活结果就断定它连不上。`null` 是
    // 「读不到」，把读不到当成不在，人就会去重新导入一个好好的号。
    if (entry.mailbox?.hasCredential === false) {
      verdict.offline.push({
        entry,
        cause: 'credential-missing',
        detail: probe?.detail ?? '',
      });
      continue;
    }
    verdict.unknown.push(entry);
  }
  return verdict;
}

/**
 * 整份清单共用的那一句依据；没有共用的一句时返回空字符串。
 *
 * 一批号常常是同时过期的：73 行里写 73 遍同一句「令牌已过期」，人只会读第一行，
 * 剩下 72 行都是噪点。所以只在**两行以上、且每一行都非空且完全相同**时把它提出来，
 * 行里不再重复；有任何一行不同就各自保留 —— 把不同的话合并显示，等于把依据说错。
 */
export function sharedOfflineDetail(rows: OfflineMailbox[]): string {
  if (rows.length < 2) return '';
  const first = rows[0].detail.trim();
  if (first === '') return '';
  return rows.every((row) => row.detail.trim() === first) ? first : '';
}

/**
 * 选中的这些能不能走「重新授权」。
 *
 * 授权登录只对微软那两个信箱成立（账号本人登录一次换令牌）；用邮箱密码登录的
 * 信箱没有这一步，给它一个点了没反应的按钮，等于让人以为这个号救得回来。
 */
export function canReauthorize(rows: OfflineMailbox[]): boolean {
  if (rows.length === 0) return false;
  return rows.every((row) => {
    const nature = row.entry.mailbox?.nature;
    return nature === 'oauth2' || nature === 'graph';
  });
}