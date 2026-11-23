// Pure. Which terminal tabs Sort pulls out of a window because they belong to another project.

export interface SplitCandidate {
  readonly key: string;
  /** Tab titles in tab-bar order, as the app read them. */
  readonly tabTitles: readonly string[];
  /** The context the window is sorted into now, if any. */
  readonly current: string | null;
  /** The owner placed this window (or kept it unsorted) by hand: never split. */
  readonly ownerChoice: boolean;
}

export interface TabRef {
  readonly index: number;
  readonly title: string;
}

export interface TabSplit {
  readonly windowKey: string;
  readonly tabs: readonly TabRef[];
}

/**
 * The window keeps the project most of its matched tabs belong to (a tie keeps the window's current
 * project, else the first tab's); every tab of another project is pulled out. Tabs that match nothing stay.
 */
export function tabSplits(windows: readonly SplitCandidate[], contextOf: (windowKey: string, title: string) => string | null): readonly TabSplit[] {
  const splits: TabSplit[] = [];
  for (const w of windows) {
    if (w.ownerChoice || w.tabTitles.length < 2) continue;
    const tabs = w.tabTitles.map((title, index) => ({ index, title, context: contextOf(w.key, title) }));
    const keep = keeper(tabs.map((t) => t.context), w.current);
    if (keep === null) continue;
    const out = tabs.filter((t) => t.context !== null && t.context !== keep).map(({ index, title }) => ({ index, title }));
    if (out.length > 0) splits.push({ windowKey: w.key, tabs: out });
  }
  return splits;
}

function keeper(contexts: readonly (string | null)[], current: string | null): string | null {
  const counts = new Map<string, number>();
  for (const c of contexts) if (c !== null) counts.set(c, (counts.get(c) ?? 0) + 1);
  if (counts.size < 2) return null;
  const top = Math.max(...counts.values());
  const tied = [...counts].filter(([, n]) => n === top).map(([c]) => c);
  if (current !== null && tied.includes(current)) return current;
  return contexts.find((c): c is string => c !== null && tied.includes(c)) ?? null;
}
