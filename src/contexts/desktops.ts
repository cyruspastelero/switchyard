// Real macOS desktops (Spaces): which desktop each context lives on, and which windows sit on the wrong one.
// Pure. Context key N goes to Desktop N; the last desktop is shared by unsorted windows and every key
// that has no desktop of its own (keys 6–9 with six desktops). See docs/superpowers/specs/2026-11-22-contexts-design.md.

import type { Snapshot } from './types.ts';

export interface WindowMove {
  readonly windowKey: string;
  readonly desktop: number;
}

/** The desktop a context key maps to, or null in off-screen mode (fewer than two desktops). */
export function desktopFor(key: number | null, count: number | null): number | null {
  if (count === null || count < 2) return null;
  if (key !== null && key >= 1 && key <= count - 1) return key;
  return count;
}

/** The desktop count when real desktops are in use; null means off-screen hiding for everything. */
export function desktopMode(snapshot: Snapshot | null): number | null {
  const desktops = snapshot?.desktops;
  if (!desktops || desktops.count < 2 || snapshot?.canCarry === false) return null;
  return desktops.count;
}

/** Windows whose known desktop differs from their target. Windows without a target (unsorted) are never moved. */
export function misplaced(
  windows: readonly { readonly key: string; readonly desktop?: number | null }[],
  targets: ReadonlyMap<string, number>,
): readonly WindowMove[] {
  const moves: WindowMove[] = [];
  for (const w of windows) {
    const target = targets.get(w.key);
    if (target === undefined || w.desktop === undefined || w.desktop === null || w.desktop === target) continue;
    moves.push({ windowKey: w.key, desktop: target });
  }
  return moves;
}

/** Why the app hides windows off-screen instead of using desktops; null when desktops are in use or unknown. */
export function offscreenReason(snapshot: Snapshot | null): string | null {
  if (!snapshot || snapshot.desktops === undefined) return null;
  if (snapshot.desktops === null) {
    return 'Real desktops are not available (displays share one set of Spaces), so windows are hidden off-screen instead.';
  }
  if (snapshot.desktops.count < 2) {
    return 'There is only one desktop. Add more in Mission Control to give each context its own; until then windows are hidden off-screen.';
  }
  if (snapshot.canCarry === false) {
    return 'Moving windows between desktops failed, so windows are hidden off-screen instead. Quit and reopen Switchyard to try again.';
  }
  return null;
}

type PlacedWindow = { readonly key: string; readonly desktop?: number | null };

/**
 * Sort's sweep: unsorted windows on a desktop some context owns go to the shared (last) desktop.
 * Windows on the shared desktop, on desktops no context maps to, or with no known desktop stay put.
 */
export function unsortedSweep(
  windows: readonly PlacedWindow[],
  sorted: ReadonlySet<string>,
  ownedDesktops: ReadonlySet<number>,
  shared: number,
): readonly WindowMove[] {
  return windows
    .filter((w) => !sorted.has(w.key) && typeof w.desktop === 'number' && w.desktop !== shared && ownedDesktops.has(w.desktop))
    .map((w) => ({ windowKey: w.key, desktop: shared }));
}

export interface TidyDesktop {
  readonly desktop: number;
  readonly windowKeys: readonly string[];
}

/**
 * The windows to lay out on each desktop once `moves` are done: windows whose context maps to that desktop
 * (`targets`), that will be there, and that the last show did not hide. Desktops left with none are dropped.
 */
export function tidyPlan(
  desktops: Iterable<number>,
  windows: readonly PlacedWindow[],
  targets: ReadonlyMap<string, number>,
  moves: readonly WindowMove[],
  hidden: ReadonlySet<string>,
): readonly TidyDesktop[] {
  const moved = new Map(moves.map((m) => [m.windowKey, m.desktop]));
  return [...new Set(desktops)].sort((a, b) => a - b)
    .map((desktop) => ({
      desktop,
      windowKeys: windows
        .filter((w) => targets.get(w.key) === desktop && (moved.get(w.key) ?? w.desktop) === desktop && !hidden.has(w.key))
        .map((w) => w.key),
    }))
    .filter((d) => d.windowKeys.length > 0);
}
