// In-memory command queue for the macOS app (long-poll).

import type { TabSplit } from './tabsplit.ts';
import type { TidyDesktop } from './desktops.ts';

export type CommandBody =
  // hideKeys: the windows of every other context. Sent with the command so the app never has to ask again
  // (a failed second request must not decide what gets hidden). focus=false: re-apply without raising anything.
  | {
    readonly type: 'show'; readonly contextId: string; readonly windowKeys: readonly string[];
    readonly hideKeys: readonly string[]; readonly focus: boolean;
    // Real desktops only: the desktop to go to first (with focus). Absent in off-screen mode.
    readonly desktop?: number;
    // Desktop mode only (always sent with `desktop`): the context's windows not on that desktop. Never raised, hidden or moved.
    readonly strayKeys?: readonly string[];
  }
  // Real desktops only: carry each window to its desktop, one at a time. Sent by Sort and by Move.
  | { readonly type: 'moveWindows'; readonly moves: readonly { readonly windowKey: string; readonly desktop: number }[] }
  // Sort, before carrying: pull these terminal tabs out into windows of their own. Never closes anything.
  | { readonly type: 'splitTabs'; readonly splits: readonly TabSplit[] }
  | { readonly type: 'nameWindow'; readonly windowKey: string; readonly name: string }
  | { readonly type: 'openWindow'; readonly browser: string; readonly name: string | null; readonly urls: readonly string[]; readonly contextId: string }
  | { readonly type: 'closeWindow'; readonly windowKey: string }
  // Brings one window to the front (its desktop, un-hidden, raised). Hides nothing else.
  | { readonly type: 'focusWindow'; readonly windowKey: string }
  | { readonly type: 'openTab'; readonly windowKey: string; readonly url: string }
  | { readonly type: 'closeTab'; readonly windowKey: string; readonly tabId: string | number }
  | { readonly type: 'showAll' }
  // Lay out each desktop's windows. force=false (after Sort/Move) skips a desktop whose window set is the same as at its last Tidy.
  // A desktop with `slots` is laid out from that preset instead of the automatic layout.
  | { readonly type: 'tidy'; readonly desktops: readonly TidyDesktop[]; readonly force: boolean }
  // Save the windows on the desktop on screen as a layout preset (the app POSTs it to /layouts).
  | { readonly type: 'captureLayout'; readonly name: string }
  // Put back the frames from before the last Tidy of that desktop.
  | { readonly type: 'undoTidy'; readonly desktop: number }
  // Desktops list: go to a desktop; add one at the end of a screen's row; close one, only while it is still `spaceCheck`.
  | { readonly type: 'showDesktop'; readonly desktop: number }
  | { readonly type: 'addDesktop'; readonly screen: number }
  | { readonly type: 'closeDesktop'; readonly number: number; readonly spaceCheck: number };

export type Command = CommandBody & { readonly seq: number; readonly createdAt: string };

const MAX_COMMANDS = 200;

interface Waiter {
  readonly since: number;
  readonly resolve: (commands: readonly Command[]) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class CommandQueue {
  private commands: readonly Command[] = [];
  private waiters: readonly Waiter[] = [];
  private listeners: readonly ((c: Command) => void)[] = [];
  // Start from the clock so sequence numbers stay increasing across server restarts.
  private seq: number;

  constructor(start: number = Date.now()) {
    this.seq = start;
  }

  get lastSeq(): number {
    return this.seq;
  }

  onEnqueue(fn: (c: Command) => void): void {
    this.listeners = [...this.listeners, fn];
  }

  enqueue(body: CommandBody): Command {
    this.seq += 1;
    const command: Command = { ...body, seq: this.seq, createdAt: new Date().toISOString() };
    this.commands = [...this.commands, command].slice(-MAX_COMMANDS);
    this.listeners.forEach((fn) => fn(command));
    this.flushWaiters();
    return command;
  }

  since(seq: number): readonly Command[] {
    return this.commands.filter((c) => c.seq > seq);
  }

  /** Resolves with commands after `since`, or an empty list after `timeoutMs`. */
  wait(since: number, timeoutMs: number, onAbort?: (abort: () => void) => void): Promise<readonly Command[]> {
    const ready = this.since(since);
    if (ready.length > 0) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.release(waiter, []), timeoutMs);
      const waiter: Waiter = { since, resolve, timer };
      this.waiters = [...this.waiters, waiter];
      onAbort?.(() => this.release(waiter, []));
    });
  }

  private release(waiter: Waiter, commands: readonly Command[]): void {
    if (!this.waiters.includes(waiter)) return;
    clearTimeout(waiter.timer);
    this.waiters = this.waiters.filter((w) => w !== waiter);
    waiter.resolve(commands);
  }

  private flushWaiters(): void {
    for (const waiter of this.waiters) {
      const ready = this.since(waiter.since);
      if (ready.length > 0) this.release(waiter, ready);
    }
  }

  find(seq: number): Command | undefined {
    return this.commands.find((c) => c.seq === seq);
  }
}
