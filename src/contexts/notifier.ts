// Debounced "view changed" notifier: recomputes the view and calls listeners only on change.

import { eventBus } from '../services/event-bus.ts';
import type { ContextsView } from './types.ts';

const TICK_MS = 15_000;
const DEBOUNCE_MS = 250;

export class ViewNotifier {
  private listeners: readonly ((view: ContextsView) => void)[] = [];
  private lastJson = '';
  private timers: ReturnType<typeof setTimeout>[] = [];
  private tick: ReturnType<typeof setInterval> | null = null;
  private readonly onBus = (): void => this.schedule();

  private readonly compute: () => Promise<ContextsView>;

  constructor(compute: () => Promise<ContextsView>) {
    this.compute = compute;
  }

  /** Listen to agent activity and a periodic tick (status decays from working to idle with time). */
  start(): void {
    eventBus.on('agent:update', this.onBus);
    eventBus.on('event:new', this.onBus);
    this.tick = setInterval(() => this.schedule(), TICK_MS);
    this.tick.unref?.();
  }

  stop(): void {
    eventBus.off('agent:update', this.onBus);
    eventBus.off('event:new', this.onBus);
    if (this.tick) clearInterval(this.tick);
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.tick = null;
  }

  subscribe(fn: (view: ContextsView) => void): () => void {
    this.listeners = [...this.listeners, fn];
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  schedule(): void {
    const timer = setTimeout(() => {
      this.timers = this.timers.filter((t) => t !== timer);
      this.compute().then(
        (view) => this.emitIfChanged(view),
        (err) => console.error('[contexts] view refresh failed:', err),
      );
    }, DEBOUNCE_MS);
    timer.unref?.();
    this.timers = [...this.timers, timer];
  }

  private emitIfChanged(view: ContextsView): void {
    const json = JSON.stringify(view);
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.listeners.forEach((fn) => fn(view));
  }
}
