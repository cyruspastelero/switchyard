// Chrome window names: a window sorted into a context is named after it, unless someone else named it.

import type { CommandQueue } from './commands.ts';
import type { ContextStore } from './store.ts';
import type { SnapshotWindow } from './types.ts';
import { canBeNamed } from './view.ts';

/** Names a Chrome window after its context, unless the owner (or anyone but us) named it. */
export function nameChromeWindow(store: ContextStore, commands: CommandQueue, w: SnapshotWindow, contextId: string): void {
  if (!w.browser || !canBeNamed(w.bundleId)) return;
  const ctx = store.getContext(contextId);
  if (!ctx) return;
  const record = store.getNames().get(w.key);
  if (record?.set_by === 'owner') return;
  const current = w.browser.name;
  if (current && current !== record?.name) {
    store.setName(w.key, current, 'owner'); // someone named it: keep their name
    return;
  }
  if (current === ctx.name) return;
  // Already asked. If the browser did not take the name, asking again on every snapshot only queues
  // slow browser scripts in front of the next switch.
  if (record?.set_by === 'switchyard' && record.name === ctx.name) return;
  store.setName(w.key, ctx.name, 'switchyard');
  commands.enqueue({ type: 'nameWindow', windowKey: w.key, name: ctx.name });
}
