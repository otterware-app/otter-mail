/**
 * Open searches, shown as sidebar rows: the top Search row (all mail) and
 * at most one per view, nested under the view it was started from.
 */

export type SearchTab = {
  id: string;
  /** The sidebar's mailbox (an account id, or Combined) the row lives in. */
  mailbox: string;
  /** The view / label it was started from; null = the top Search row. */
  parent: string | null;
  /** The parent as Gmail operators (`in:inbox`), prefilled and kept. */
  base: string;
  /** The query that ran. */
  query: string;
  /** What's in the bar (may not have run yet). */
  draft: string;
  /** Accounts searched. */
  scope: string[];
};

export function searchTabId(mailbox: string, parent: string | null): string {
  return `${mailbox}::${parent ?? "*"}`;
}

/** The row's title: the words searched, without the parent's operators. */
export function searchTitle(tab: SearchTab): string {
  const text = (tab.query || tab.draft).trim();
  const words = tab.base ? text.replace(tab.base, "").trim() : text;
  return words || "Search";
}
