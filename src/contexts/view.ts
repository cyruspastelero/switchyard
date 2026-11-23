// Builds the GET /api/contexts response from plain data. No I/O.

import { createHash } from 'node:crypto';
import type { DesktopsListView } from './desktop-admin.ts';
import { desktopFor } from './desktops.ts';
import { matchUrl, type MatchableContext } from './matcher.ts';
import type { ContextRow } from './store.ts';
import type {
  AgentView, CommandFailure, ContextStatus, DesktopsInfo, ContextView, ContextsView, Snapshot, SnapshotWindow, SuggestionView, WindowView,
} from './types.ts';

export const SNAPSHOT_FRESH_MS = 15_000;
const MAX_SUGGESTIONS = 20;

export interface ViewInput {
  readonly contexts: readonly ContextRow[];
  readonly agentsByContext: ReadonlyMap<string, readonly AgentView[]>;
  readonly snapshot: Snapshot | null;
  readonly snapshotAt: number | null;
  readonly assignments: ReadonlyMap<string, { contextId: string; reason?: string | null }>;
  readonly names: ReadonlyMap<string, { name: string }>;
  readonly parkedCounts: ReadonlyMap<string, number>;
  readonly matchables: readonly MatchableContext[];
  readonly activeContextId: string | null;
  readonly lastFailure?: CommandFailure | null;
  readonly nowMs: number;
  /** Real desktops in use; null or absent means off-screen mode. */
  readonly desktops?: DesktopsInfo | null;
  readonly desktopNote?: string | null;
  readonly desktopList?: DesktopsListView | null;
  readonly toSort?: number;
  readonly unsortedToMove?: number;
  readonly autoTidy?: boolean;
  /** Windows hidden off-screen by the last show. */
  readonly hiddenKeys?: ReadonlySet<string>;
}

/** The Mac app can name Chrome windows only (not Arc, not other apps). */
export const canBeNamed = (bundleId: string): boolean => bundleId === 'com.google.Chrome';

export function toWindowView(
  w: SnapshotWindow, names: ViewInput['names'], why: string | null = null, hidden: ReadonlySet<string> = new Set(),
): WindowView {
  const stored = canBeNamed(w.bundleId) ? names.get(w.key)?.name : undefined;
  // Chrome puts a window's name where the page title was; the active tab still says what the window shows.
  const page = w.browser?.name && w.browser.activeTitle ? w.browser.activeTitle : null;
  return {
    key: w.key,
    app: w.app,
    bundleId: w.bundleId,
    title: page ?? w.title,
    name: stored ?? w.browser?.name ?? null,
    tabCount: w.browser ? w.browser.tabs.length : null,
    why,
    desktop: w.desktop ?? null,
    hidden: hidden.has(w.key),
  };
}

export function rollUpStatus(parked: boolean, agents: readonly AgentView[]): ContextStatus {
  if (parked) return 'parked';
  if (agents.some((a) => a.status === 'waiting')) return 'waiting';
  if (agents.some((a) => a.status === 'working')) return 'working';
  return 'idle';
}

export function suggestionId(windowKey: string, tabId: string | number, toContextId: string): string {
  return createHash('sha1').update(`${windowKey}\n${tabId}\n${toContextId}`).digest('hex').slice(0, 16);
}

/** Tabs sitting in a window of one context whose URL clearly belongs to another. */
export function computeSuggestions(input: ViewInput): readonly SuggestionView[] {
  const out: SuggestionView[] = [];
  for (const w of input.snapshot?.windows ?? []) {
    const owner = input.assignments.get(w.key)?.contextId;
    if (!owner || !w.browser) continue;
    for (const tab of w.browser.tabs) {
      const target = matchUrl(tab.url, input.matchables);
      if (!target || target === owner) continue;
      out.push({
        id: suggestionId(w.key, tab.id, target),
        url: tab.url,
        title: tab.title,
        fromWindowKey: w.key,
        toContextId: target,
      });
      if (out.length >= MAX_SUGGESTIONS) return out;
    }
  }
  return out;
}

function contextView(row: ContextRow, input: ViewInput): ContextView {
  const agents = input.agentsByContext.get(row.id) ?? [];
  const windows = (input.snapshot?.windows ?? [])
    .filter((w) => input.assignments.get(w.key)?.contextId === row.id)
    .map((w) => toWindowView(w, input.names, input.assignments.get(w.key)?.reason ?? null, input.hiddenKeys));
  const count = input.desktops?.count ?? null;
  const desktop = desktopFor(row.key, count);
  return {
    id: row.id,
    name: row.name,
    folder: row.folder,
    key: row.key,
    color: row.color,
    status: rollUpStatus(row.parked, agents),
    agents,
    windows,
    parkedWindowCount: input.parkedCounts.get(row.id) ?? 0,
    lastActiveAt: row.last_active_at,
    desktop,
    desktopShared: desktop !== null && desktop === count,
    strays: desktop === null ? 0 : windows.filter((w) => w.desktop !== null && w.desktop !== desktop).length,
  };
}

export function buildView(input: ViewInput): ContextsView {
  const contexts = input.contexts.map((row) => contextView(row, input));
  const known = new Set(input.contexts.map((c) => c.id));
  const unsorted = (input.snapshot?.windows ?? [])
    .filter((w) => {
      const id = input.assignments.get(w.key)?.contextId;
      return !id || !known.has(id);
    })
    .map((w) => toWindowView(w, input.names, null, input.hiddenKeys));
  const control = input.snapshotAt !== null && input.nowMs - input.snapshotAt < SNAPSHOT_FRESH_MS;
  return {
    windowControl: control,
    activeContextId: input.activeContextId && known.has(input.activeContextId) ? input.activeContextId : null,
    contexts,
    lastFailure: input.lastFailure ?? null,
    unsorted,
    suggestions: computeSuggestions(input),
    waitingCount: contexts.filter((c) => c.status === 'waiting').length,
    desktopMode: input.desktops ? 'desktops' : 'offscreen',
    desktops: input.desktops ?? null,
    desktopNote: input.desktopNote ?? null,
    desktopList: input.desktopList ?? null,
    toSort: input.toSort ?? 0,
    unsortedToMove: input.unsortedToMove ?? 0,
    autoTidy: input.autoTidy ?? true,
  };
}
