// The dashboard's Desktops list: one row per desktop, and the rules for going to, adding and closing one.
// Pure. Closing or adding a desktop renumbers every desktop after it, and a context's desktop is its key,
// so any change that would renumber a project's desktop is refused with a reason that says how to free it.

import type { CommandBody } from './commands.ts';
import { desktopFor } from './desktops.ts';
import { ContextsError, type DesktopEntry, type Snapshot } from './types.ts';

interface KeyedContext {
  readonly id: string;
  readonly name: string;
  readonly key: number | null;
}

export interface DesktopOwner { readonly id: string; readonly name: string }

export interface DesktopRow {
  readonly number: number;
  readonly screen: number;
  readonly screenLabel: string;
  readonly showing: boolean;
  /** The last desktop, where unsorted windows and contexts without a desktop of their own live. */
  readonly shared: boolean;
  /** Contexts whose own desktop this is; empty for the shared desktop. */
  readonly owners: readonly DesktopOwner[];
  readonly windows: number;
  /** Why Close is off, or null when the desktop can be closed. */
  readonly closeBlocked: string | null;
}

export interface ScreenRow { readonly screen: number; readonly label: string; readonly addBlocked: string | null }

export interface DesktopsListView {
  readonly desktops: readonly DesktopRow[];
  readonly screens: readonly ScreenRow[];
}

export type DesktopAction =
  | { readonly type: 'show'; readonly number: number }
  | { readonly type: 'add'; readonly screen: number }
  | { readonly type: 'close'; readonly number: number };

const MAX_DESKTOPS = 16;

/** Contexts that have `number` as their own desktop (never the shared one). */
function ownersOf(number: number, contexts: readonly KeyedContext[], count: number): readonly KeyedContext[] {
  if (number >= count) return [];
  return contexts.filter((c) => desktopFor(c.key, count) === number);
}

/** The first project desktop after `number`, which closing or adding there would renumber. */
function firstOwnedAfter(number: number, contexts: readonly KeyedContext[], count: number): { number: number; name: string } | null {
  for (let n = number + 1; n < count; n++) {
    const owner = ownersOf(n, contexts, count)[0];
    if (owner) return { number: n, name: owner.name };
  }
  return null;
}

/** `windowsOn`: windows on the desktop now. The last (shared) desktop may close while empty: no number shifts. */
export function closeBlock(
  number: number, list: readonly DesktopEntry[], contexts: readonly KeyedContext[], count: number, windowsOn = 0,
): string | null {
  const entry = list.find((d) => d.number === number);
  if (!entry) return `There is no Desktop ${number}.`;
  if (number === count && windowsOn > 0) {
    return `Desktop ${number} is the shared desktop and holds ${windowsOn} ${windowsOn === 1 ? 'window' : 'windows'}. Move them first.`;
  }
  const owner = ownersOf(number, contexts, count)[0];
  if (owner) return `Desktop ${number} belongs to ${owner.name}. Give ${owner.name} another desktop first.`;
  if (list.filter((d) => d.screen === entry.screen).length < 2) return `Desktop ${number} is the only desktop on its screen.`;
  const later = firstOwnedAfter(number, contexts, count);
  if (later) return `Closing it would renumber Desktop ${later.number} (${later.name}). Give ${later.name} another desktop first.`;
  return null;
}

export function addBlock(screen: number, list: readonly DesktopEntry[], contexts: readonly KeyedContext[], count: number): string | null {
  const onScreen = list.filter((d) => d.screen === screen);
  if (onScreen.length === 0) return `There is no screen ${screen}.`;
  if (list.length >= MAX_DESKTOPS) return `Switchyard uses up to ${MAX_DESKTOPS} desktops.`;
  // macOS adds the new desktop at the end of that screen's row.
  const later = firstOwnedAfter(onScreen[onScreen.length - 1].number, contexts, count);
  if (later) return `A new desktop here would renumber Desktop ${later.number} (${later.name}). Give ${later.name} another desktop first.`;
  return null;
}

/** "Laptop" and "Monitor" while each kind appears once; otherwise "Screen N". */
function screenLabels(list: readonly DesktopEntry[]): Map<number, string> {
  const screens = new Map<number, boolean>();
  for (const d of list) screens.set(d.screen, d.builtin);
  const kinds = [...screens.values()];
  const unique = (builtin: boolean) => kinds.filter((b) => b === builtin).length === 1;
  return new Map([...screens].map(([screen, builtin]) => [
    screen, unique(builtin) ? (builtin ? 'Laptop' : 'Monitor') : `Screen ${screen}`,
  ]));
}

export function desktopsListView(
  list: readonly DesktopEntry[],
  contexts: readonly KeyedContext[],
  windows: readonly { readonly desktop?: number | null }[],
  count: number,
): DesktopsListView {
  const labels = screenLabels(list);
  const desktops = list.map((d) => ({
    number: d.number,
    screen: d.screen,
    screenLabel: labels.get(d.screen) ?? `Screen ${d.screen}`,
    showing: d.showing,
    shared: d.number === count,
    owners: ownersOf(d.number, contexts, count).map((c) => ({ id: c.id, name: c.name })),
    windows: windows.filter((w) => w.desktop === d.number).length,
    closeBlocked: closeBlock(d.number, list, contexts, count, windows.filter((w) => w.desktop === d.number).length),
  }));
  const screens = [...labels].map(([screen, label]) => ({ screen, label, addBlocked: addBlock(screen, list, contexts, count) }));
  return { desktops, screens };
}

/** Checks the action against the latest snapshot and returns the app command. Throws ContextsError when refused. */
export function planDesktopAction(
  action: DesktopAction,
  snapshot: Snapshot | null,
  contexts: readonly KeyedContext[],
  count: number | null,
): CommandBody {
  if (count === null) throw new ContextsError(409, 'Desktops need real desktops. Add a second desktop in Mission Control.');
  const list = snapshot?.desktops?.list;
  if (!list) throw new ContextsError(409, 'Update the Switchyard Mac app to manage desktops from here.');
  if (action.type === 'add') {
    const blocked = addBlock(action.screen, list, contexts, count);
    if (blocked) throw new ContextsError(blocked.startsWith('There is no') ? 404 : 409, blocked);
    return { type: 'addDesktop', screen: action.screen };
  }
  const entry = list.find((d) => d.number === action.number);
  if (!entry) throw new ContextsError(404, `There is no Desktop ${action.number}.`);
  if (action.type === 'show') return { type: 'showDesktop', desktop: action.number };
  const windowsOn = (snapshot?.windows ?? []).filter((w) => w.desktop === action.number).length;
  const blocked = closeBlock(action.number, list, contexts, count, windowsOn);
  if (blocked) throw new ContextsError(409, blocked);
  return { type: 'closeDesktop', number: action.number, spaceCheck: entry.space };
}
