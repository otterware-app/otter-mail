/** Reconcile the saved strip with open tabs, inserting new ones beside their source neighbour. */
export function orderedPanelTabs(order: string[], tabs: string[]): string[] {
  const next = [...new Set(order)].filter((id) => tabs.includes(id));
  for (const [at, id] of tabs.entries()) {
    if (next.includes(id)) continue;
    next.splice(at === 0 ? 0 : next.indexOf(tabs[at - 1]) + 1, 0, id);
  }
  return next;
}

/** Move a chat or page to either side of another tab without changing selection. */
export function movePanelTab(tabs: string[], id: string, target: string, after: boolean): string[] {
  if (id === target || !tabs.includes(id) || !tabs.includes(target)) return tabs;
  const next = tabs.filter((tab) => tab !== id);
  next.splice(next.indexOf(target) + Number(after), 0, id);
  return next;
}

/** Cross layout midpoints, rather than animated bounds, so neighbours don't oscillate. */
export function tabDragTarget(
  tabs: { id: string; left: number; width: number }[],
  id: string,
  center: number,
): { id: string; after: boolean } | null {
  const at = tabs.findIndex((tab) => tab.id === id);
  if (at < 0) return null;
  let target = at;
  for (let i = at + 1; i < tabs.length && center >= tabs[i].left + tabs[i].width / 2; i++)
    target = i;
  for (let i = at - 1; i >= 0 && center <= tabs[i].left + tabs[i].width / 2; i--) target = i;
  return target === at ? null : { id: tabs[target].id, after: target > at };
}

/** Only open tabs count; restored tabs may not have been visited yet. */
export function mostRecentTab(tabs: string[], activeId: string, recent: string[]): string | null {
  return (
    recent.find((id) => id !== activeId && tabs.includes(id)) ??
    tabs.find((id) => id !== activeId) ??
    null
  );
}
