// Account categories: the credential groups the credentials page already shows as
// its tabs. A client API key may be scoped to one or more of them through
// `access.key-pools`.
//
// The set is derived from the live credential list rather than declared in
// configuration, so a scoped key follows accounts being added or removed with no
// configuration write. A category exists exactly as long as a credential belongs
// to it.

import type { AuthFileItem } from '@/types/authFile';

export type AccountCategory = { name: string; count: number };

/** Placeholders the credentials page uses when a file carries no usable type. */
const UNGROUPED = new Set(['', 'empty', 'unknown']);

/**
 * The category one credential belongs to.
 *
 * This is the credential's raw `type` lowercased, because that is the string the
 * host compares against when it routes a scoped key. The display label is
 * resolved separately, so grouping never depends on a translated name.
 */
export const accountCategoryOf = (file: Pick<AuthFileItem, 'type' | 'provider'>): string =>
  String(file.type ?? file.provider ?? '')
    .trim()
    .toLowerCase();

/** Categories that currently hold at least one credential, in first-seen order. */
export function accountCategories(files: readonly AuthFileItem[]): AccountCategory[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const name = accountCategoryOf(file);
    if (UNGROUPED.has(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts, ([name, count]) => ({ name, count }));
}

/**
 * Checkboxes for one key: the categories that exist now, plus any category the key
 * still names that no longer has credentials.
 *
 * A stale entry has to stay visible. A scope the operator cannot see is one they
 * cannot clear, so the key would keep pointing at a category that is gone.
 */
export function accountCategoryOptions(
  categories: readonly AccountCategory[],
  selected: readonly string[]
): Array<AccountCategory & { missing: boolean }> {
  const known = new Set(categories.map((category) => category.name.toLowerCase()));
  const options = categories.map((category) => ({ ...category, missing: false }));
  for (const value of selected) {
    const name = value.trim();
    if (!name || known.has(name.toLowerCase())) continue;
    known.add(name.toLowerCase());
    options.push({ name, count: 0, missing: true });
  }
  return options;
}
