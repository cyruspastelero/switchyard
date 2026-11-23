// Which preset a tidy uses, and the preset fields of the view. Pure.

import { desktopFor, type TidyDesktop } from './desktops.ts';
import { AUTO_LAYOUT, type LayoutPresets, type LayoutSlot } from './layouts.ts';
import type { ContextsView } from './types.ts';

interface OwnerRow {
  readonly id: string;
  readonly key: number | null;
  readonly parked: boolean;
}

/**
 * The context whose preset lays out `desktop`: the one unparked context mapped to it. On the shared (last)
 * desktop several may be, so only the active one counts there, as with the Mac app's own Tidy.
 */
export function desktopOwner(rows: readonly OwnerRow[], desktop: number, count: number, activeId: string | null): string | null {
  const owners = rows.filter((r) => !r.parked && desktopFor(r.key, count) === desktop);
  if (desktop === count) return owners.some((r) => r.id === activeId) ? activeId : null;
  return owners.length === 1 ? owners[0].id : null;
}

/** Adds `slots` to each desktop that has a preset. Desktops without one stay as they were (auto layout). */
export function withSlots(
  desktops: readonly TidyDesktop[],
  slotsFor: (desktop: number) => readonly LayoutSlot[] | null,
): readonly TidyDesktop[] {
  return desktops.map((d) => {
    const slots = slotsFor(d.desktop);
    return slots ? { ...d, slots } : d;
  });
}

/** The presets, the default, and per context its own choice (`layoutId`) and the one in effect (`layout`). */
export function withLayouts(view: ContextsView, presets: LayoutPresets): ContextsView {
  const own = presets.contextLayouts();
  const list = presets.list();
  const byId = new Map(list.map((p) => [p.id, p]));
  const defaultLayoutId = presets.defaultId();
  const contexts = view.contexts.map((c) => {
    const layoutId = own.get(c.id) ?? null;
    const effective = layoutId ?? defaultLayoutId;
    return { ...c, layoutId, layout: effective === AUTO_LAYOUT ? null : (byId.get(effective ?? '') ?? null) };
  });
  return { ...view, contexts, layouts: list, defaultLayoutId };
}
