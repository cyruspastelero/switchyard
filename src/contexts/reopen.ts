// Copyright 2026 Cyrus David Pastelero. Apache-2.0 License.
//
// The app opens a window for a context (restore, an accepted tab suggestion) but cannot say which window it made.
// The server claims it from the next snapshot: a window it has never seen, in the same browser, named as asked
// (or, unnamed, showing one of the asked URLs). Pure, so it can be tested without the service.

import type { SnapshotWindow } from './types.ts';

export interface ExpectedOpen {
  readonly contextId: string;
  readonly browser: string;
  readonly name: string | null;
  readonly urls: readonly string[];
  readonly until: number;
}

/** How long a window may take to show up in a snapshot after its open command was queued. */
export const EXPECT_OPEN_MS = 120_000;

function fits(open: ExpectedOpen, w: SnapshotWindow): boolean {
  if (!w.browser || w.app !== open.browser) return false;
  if (open.name) return w.browser.name === open.name;
  return w.browser.tabs.some((t) => open.urls.includes(t.url));
}

/** Window key -> context for each expected open found among the new windows; claimed and expired seqs are listed. */
export function claimOpened(
  expected: ReadonlyMap<number, ExpectedOpen>,
  windows: readonly SnapshotWindow[],
  known: ReadonlySet<string>,
  now: number,
): { readonly claims: ReadonlyMap<string, string>; readonly done: readonly number[] } {
  const claims = new Map<string, string>();
  const done: number[] = [];
  const fresh = windows.filter((w) => !known.has(w.key));
  for (const [seq, open] of expected) {
    const w = fresh.find((candidate) => !claims.has(candidate.key) && fits(open, candidate));
    if (w) claims.set(w.key, open.contextId);
    if (w || now > open.until) done.push(seq);
  }
  return { claims, done };
}
