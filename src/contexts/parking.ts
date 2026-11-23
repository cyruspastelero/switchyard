// Parked windows: what a park saves, and which saved rows count for the view.

import type { Assignment, ContextRow, NameRow, ParkedInput } from './store.ts';
import type { SnapshotWindow } from './types.ts';

/** Saved windows per context, for parked contexts only: rows an unacked restore left behind are not "parked". */
export function parkedCountsOf(rows: readonly ContextRow[], counts: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
  const parked = new Set(rows.filter((r) => r.parked).map((r) => r.id));
  return new Map([...counts].filter(([id]) => parked.has(id)));
}

/** The context's browser windows and what to save for each before they close. */
export function windowsToPark(
  windows: readonly SnapshotWindow[],
  contextId: string,
  assignments: ReadonlyMap<string, Assignment>,
  names: ReadonlyMap<string, NameRow>,
): { readonly windows: readonly SnapshotWindow[]; readonly saved: readonly ParkedInput[] } {
  const parked = windows.filter((w) => w.browser !== null && assignments.get(w.key)?.contextId === contextId);
  return {
    windows: parked,
    saved: parked.map((w) => ({
      browser: w.app,
      name: names.get(w.key)?.name ?? w.browser?.name ?? null,
      urls: (w.browser?.tabs ?? []).map((t) => t.url),
    })),
  };
}
