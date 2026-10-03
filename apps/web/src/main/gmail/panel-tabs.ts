/** The strip's left neighbour wins; at its start, continue to the right. */
export function tabAfterClose(tabs: string[], id: string): string | null {
  const at = tabs.indexOf(id);
  return at < 0 ? null : (tabs[at - 1] ?? tabs[at + 1] ?? null);
}

/** Only open tabs count; restored tabs may not have been visited yet. */
export function mostRecentTab(tabs: string[], activeId: string, recent: string[]): string | null {
  return (
    recent.find((id) => id !== activeId && tabs.includes(id)) ??
    tabs.find((id) => id !== activeId) ??
    null
  );
}
