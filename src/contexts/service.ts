// Contexts service: auto-creates contexts from agent folders, sorts windows, and
// turns owner actions (switch, park, restore, rename, assign) into app commands.

import crypto from 'node:crypto';
import type { Db } from '../sqlite.ts';
import type { Agent } from '../db.ts';
import { CommandQueue, type Command, type CommandBody } from './commands.ts';
import { isBrowserBundle, learnPattern, matchWindow, ruleIsSpecific, type Match, type MatchableContext, type TitleEntry } from './matcher.ts';
import { ViewNotifier } from './notifier.ts';
import { createSignalSource, type SignalSource } from './signals.ts';
import { createContextStore, type ContextRow, type ContextStore } from './store.ts';
import { deriveAgentStatus, describeAction } from './agents.ts';
import { desktopFor, desktopMode, misplaced, offscreenReason, tidyPlan, unsortedSweep, type WindowMove } from './desktops.ts';
import { buildView, canBeNamed, computeSuggestions, SNAPSHOT_FRESH_MS, type ViewInput } from './view.ts';
import {
  ContextsError, type AgentView, type CommandFailure, type ContextsView, type Snapshot, type SnapshotWindow,
} from './types.ts';
import { readEnv } from '../paths.ts';
import { IconStore } from './icons.ts';
import { pathsFromToolInput, pickWorkFolder } from './workfolder.ts';

const PALETTE = ['#4f8cff', '#e8833a', '#3fb68b', '#b46bff', '#e5566d', '#d4a72c', '#2fb5c9', '#8c8f99', '#6dbb3f'] as const;

export interface ContextsDeps {
  readonly db: Db;
  readonly listAgents: () => readonly Agent[];
  readonly signals?: SignalSource;
  readonly now?: () => number;
  readonly costPerToolCall?: number;
  /** Only agents seen within this window create new contexts (default 12 h), so old history doesn't take keys 1–9. */
  readonly autoContextWindowMs?: number;
  /** Where uploaded app icons are kept; memory only when absent. */
  readonly iconDir?: string;
}

interface MatchState {
  readonly matchables: readonly MatchableContext[];
  readonly titles: readonly TitleEntry[];
  readonly agentFolder: ReadonlyMap<string, string>;
}

const OWNER_REASON = 'assigned by you';
/** How many of a session's latest tool calls say where it works. */
const WORK_SAMPLE = 300;

const basename = (folder: string): string => folder.split('/').filter(Boolean).pop() ?? folder;

export class ContextsService {
  readonly store: ContextStore;
  private readonly notifier = new ViewNotifier(() => this.view());
  readonly commands = new CommandQueue();
  readonly icons: IconStore;
  private readonly signals: SignalSource;
  private readonly now: () => number;
  private readonly costPerCall: number;
  private snapshot: Snapshot | null = null;
  private snapshotAt: number | null = null;
  private activeContextId: string | null = null;
  private lastFailure: CommandFailure | null = null;
  private match: MatchState = { matchables: [], titles: [], agentFolder: new Map() };
  private refreshing: Promise<void> | null = null;
  /** Work folder per session, valid while the agent has logged nothing new. */
  private readonly workFolders = new Map<string, { seenAt: string; folder: string }>();
  /** Windows the app could not carry to their desktop. They fall back to off-screen hiding where they sit. */
  private readonly carryFailed = new Set<string>();
  /** Windows the last show moved off-screen. */
  private hiddenKeys: ReadonlySet<string> = new Set();
  /** Last report of every window, so one on another desktop stays on its card when the app stops listing it. */
  private readonly lastSeen = new Map<string, SnapshotWindow>();
  /** The desktop a focusWindow goes to. Landing there must not make its context active. */
  private focusDesktop: number | null = null;

  private readonly deps: ContextsDeps;

  constructor(deps: ContextsDeps) {
    this.deps = deps;
    this.store = createContextStore(deps.db);
    this.icons = new IconStore(deps.iconDir ?? null);
    for (const w of this.store.lastSeenWindows()) this.lastSeen.set(w.key, w);
    this.signals = deps.signals ?? createSignalSource();
    this.now = deps.now ?? Date.now;
    this.costPerCall = deps.costPerToolCall ?? parseFloat(readEnv("COST_PER_TOOL_CALL") || '0.003');
  }

  // --- Lifecycle ----------------------------------------------------------

  start(): void {
    this.notifier.start();
  }

  stop(): void {
    this.notifier.stop();
  }

  subscribe(fn: (view: ContextsView) => void): () => void {
    return this.notifier.subscribe(fn);
  }

  scheduleEmit(): void {
    this.notifier.schedule();
  }

  // --- Refresh: contexts, patterns, session titles ---------------------------

  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const agents = [...this.deps.listAgents()]
      .filter((a) => a.cwd)
      .sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at));
    const windowMs = this.deps.autoContextWindowMs ?? 12 * 3600_000;
    const recent = agents.map((a) => this.now() - Date.parse(a.last_seen_at) <= windowMs);
    const roots = await Promise.all(agents.map((a, i) => (recent[i] ? this.workFolder(a) : this.signals.folderRoot(a.cwd as string))));
    const agentFolder = new Map(agents.map((a, i) => [a.id, roots[i]]));
    const recentRoots = roots.filter((_, i) => recent[i]);
    this.ensureContexts([...new Set(recentRoots)]);
    const rows = this.store.listContexts();
    const rules = this.store.listRules();
    const matchables = await Promise.all(
      rows.map(async (row): Promise<MatchableContext> => {
        const signalPatterns = row.folder ? await this.signals.patterns(row.folder) : [];
        const aliases = row.folder ? ((await this.signals.aliases?.(row.folder)) ?? []) : [];
        // A rule as wide as "github.com/owner" would pull every repo of that owner into one context.
        const learned = rules.filter((r) => r.context_id === row.id && ruleIsSpecific(r.pattern)).map((r) => r.pattern);
        return { id: row.id, name: row.name, folder: row.folder, patterns: [...signalPatterns, ...learned], aliases };
      }),
    );
    const titles = await this.loadTitles(agents, agentFolder, rows);
    this.match = { matchables, titles, agentFolder };
  }

  /**
   * The project a session belongs to: the root of the folder it runs in, or a project nested inside it
   * when that is where its tools (subagents included) do most of their work. Sessions are often started
   * in a parent folder of many repositories; without this they would all land in the parent's context.
   */
  private async workFolder(agent: Agent): Promise<string> {
    const base = await this.signals.folderRoot(agent.cwd as string);
    if (!isMainAgent(agent.agent_id) || !agent.session_id) return base;
    const cached = this.workFolders.get(agent.id);
    if (cached?.seenAt === agent.last_seen_at) return cached.folder;
    const paths = this.store.recentToolInputs(agent.session_id, WORK_SAMPLE).flatMap(pathsFromToolInput);
    const touched = await Promise.all(paths.map((p) => this.signals.folderRoot(p)));
    const folder = pickWorkFolder(base, touched);
    this.workFolders.set(agent.id, { seenAt: agent.last_seen_at, folder });
    return folder;
  }

  private ensureContexts(folders: readonly string[]): void {
    for (const folder of folders) {
      if (this.store.getContextByFolder(folder)) continue;
      const count = this.store.listContexts().length;
      this.store.insertContext({
        id: crypto.randomUUID(), name: basename(folder), folder, key: this.store.nextFreeKey(),
        color: PALETTE[count % PALETTE.length], parked: false,
        created_at: new Date(this.now()).toISOString(), last_active_at: null,
      });
    }
  }

  private async loadTitles(
    agents: readonly Agent[],
    folders: ReadonlyMap<string, string>,
    rows: readonly ContextRow[],
  ): Promise<readonly TitleEntry[]> {
    const mains = agents.filter((a) => isMainAgent(a.agent_id) && a.session_id);
    let titles: ReadonlyMap<string, string>;
    try {
      titles = await this.signals.sessionTitles(mains.map((a) => a.session_id));
    } catch (err) {
      console.warn(`[contexts] reading Claude session titles failed: ${(err as Error).message}`);
      return [];
    }
    const entries: TitleEntry[] = [];
    for (const a of mains) {
      const title = titles.get(a.session_id);
      const ctx = rows.find((r) => r.folder === folders.get(a.id));
      if (title && ctx) entries.push({ title, contextId: ctx.id });
    }
    return entries;
  }

  // --- View --------------------------------------------------------------------

  private agentsByContext(rows: readonly ContextRow[]): ReadonlyMap<string, readonly AgentView[]> {
    const dayStart = new Date(this.now());
    dayStart.setHours(0, 0, 0, 0);
    const map = new Map<string, AgentView[]>();
    for (const a of this.deps.listAgents()) {
      if (!isMainAgent(a.agent_id) || a.status === 'disconnected') continue;
      const ctx = rows.find((r) => r.folder !== null && r.folder === this.match.agentFolder.get(a.id));
      if (!ctx) continue;
      const latest = this.store.latestEvent(a.id);
      const before = latest?.event_type === 'Notification' ? this.store.eventBeforeNotification(a.id) : null;
      const calls = this.store.toolCallsSince(a.id, dayStart.toISOString());
      const view: AgentView = {
        id: a.id, name: a.name ?? a.id, status: deriveAgentStatus(latest, this.now(), before),
        lastAction: describeAction(latest, before), costToday: Math.round(calls * this.costPerCall * 10_000) / 10_000,
      };
      map.set(ctx.id, [...(map.get(ctx.id) ?? []), view]);
    }
    return map;
  }

  private viewInput(): ViewInput {
    const rows = this.store.listContexts();
    return {
      contexts: rows, agentsByContext: this.agentsByContext(rows), snapshot: this.snapshot,
      hiddenKeys: this.hiddenKeys,
      snapshotAt: this.snapshotAt, assignments: this.store.getAssignments(), names: this.store.getNames(),
      parkedCounts: this.store.parkedCounts(), matchables: this.match.matchables,
      activeContextId: this.activeContextId, lastFailure: this.lastFailure, nowMs: this.now(),
      desktops: this.desktopCount() === null ? null : (this.snapshot?.desktops ?? null),
      desktopNote: offscreenReason(this.snapshot), toSort: this.moves().length,
      unsortedToMove: this.sweep().length, autoTidy: this.store.autoTidy(),
    };
  }

  async view(): Promise<ContextsView> {
    await this.refresh();
    return buildView(this.viewInput());
  }

  // --- Snapshot + sorting --------------------------------------------------------

  /**
   * The last report of each window, so a Move or focus right after a snapshot still finds it. The app lists every
   * window on every desktop, so a window it stops listing was closed and is forgotten.
   */
  private rememberWindows(snapshot: Snapshot): void {
    const listed = new Set(snapshot.windows.map((w) => w.key));
    const drop = [...this.lastSeen.keys()].filter((key) => !listed.has(key));
    const save = snapshot.windows.filter((w) => {
      const before = this.lastSeen.get(w.key);
      return !before || before.title !== w.title || before.pid !== w.pid || (before.desktop ?? null) !== (w.desktop ?? null);
    });
    for (const key of drop) this.lastSeen.delete(key);
    for (const w of snapshot.windows) this.lastSeen.set(w.key, w);
    this.store.rememberWindows(save, drop);
  }

  async applySnapshot(snapshot: Snapshot): Promise<void> {
    await this.refresh();
    const previousActive = this.desktopCount() === null ? null : (this.snapshot?.desktops?.active ?? null);
    this.rememberWindows(snapshot);
    this.snapshot = snapshot;
    this.snapshotAt = this.now();
    const changed = this.sortWindows(snapshot.windows, { onlyNew: true });
    this.followDesktop(previousActive);
    if (changed > 0) this.reshowActive();
    this.scheduleEmit();
  }

  /**
   * Assigns as before. With real desktops it then queues one `moveWindows` for every sorted window on the
   * wrong desktop. New windows are only ever carried here, on request: a carry takes the screen away.
   */
  async sort(): Promise<{ sorted: number; toMove: number }> {
    this.requireApp();
    await this.refresh();
    const sorted = this.sortWindows(this.snapshot?.windows ?? [], { onlyNew: false });
    // Project moves first, then unsorted windows off project desktops (the app's carry cap keeps that order).
    const moves = [...this.moves(), ...this.sweep()];
    if (moves.length > 0) this.commands.enqueue({ type: 'moveWindows', moves });
    this.reshowActive();
    this.tidyChanged(moves);
    this.scheduleEmit();
    return { sorted, toMove: moves.length };
  }

  // --- Real desktops ----------------------------------------------------------------

  private desktopCount(): number | null {
    return desktopMode(this.snapshot);
  }

  private contextDesktop(row: ContextRow | undefined): number | null {
    return row ? desktopFor(row.key, this.desktopCount()) : null;
  }

  /** Target desktop of every window assigned to a known context. Empty in off-screen mode. */
  private desktopTargets(): Map<string, number> {
    const targets = new Map<string, number>();
    if (this.desktopCount() === null) return targets;
    const rows = new Map(this.store.listContexts().map((c) => [c.id, c]));
    for (const [key, a] of this.store.getAssignments()) {
      const desktop = this.contextDesktop(rows.get(a.contextId));
      if (desktop !== null) targets.set(key, desktop);
    }
    return targets;
  }

  private moves(): readonly WindowMove[] {
    return misplaced(this.snapshot?.windows ?? [], this.desktopTargets());
  }

  /** Unsorted windows on a desktop an unparked context owns; Sort carries them to the shared desktop. */
  private sweep(): readonly WindowMove[] {
    const count = this.desktopCount();
    if (count === null) return [];
    const known = new Set(this.store.listContexts().map((c) => c.id));
    const sorted = new Set([...this.store.getAssignments()].filter(([, a]) => known.has(a.contextId)).map(([k]) => k));
    const owned = new Set(this.store.listContexts().filter((c) => !c.parked).map((c) => desktopFor(c.key, count) as number));
    return unsortedSweep(this.snapshot?.windows ?? [], sorted, owned, count);
  }

  /** After a Sort or Move: lay out the desktops the moves leave or reach, when the owner has autoTidy on. */
  private tidyChanged(moves: readonly WindowMove[]): void {
    if (moves.length === 0 || !this.store.autoTidy()) return;
    const windows = this.snapshot?.windows ?? [];
    const from = moves.map((m) => windows.find((w) => w.key === m.windowKey)?.desktop).filter((d): d is number => typeof d === 'number');
    const desktops = tidyPlan([...from, ...moves.map((m) => m.desktop)], windows, this.desktopTargets(), moves, this.hiddenKeys);
    if (desktops.length > 0) this.commands.enqueue({ type: 'tidy', desktops, force: false });
  }

  /** Carries one window the owner just moved, when it sits on another known desktop. The screen stays where it is. */
  private carryMoved(windowKey: string, target: number | null): { moving: boolean; desktop: number | null } {
    const from = (this.snapshot?.windows.find((w) => w.key === windowKey) ?? this.lastSeen.get(windowKey))?.desktop;
    if (target === null || typeof from !== 'number' || from === target) return { moving: false, desktop: target };
    this.commands.enqueue({ type: 'moveWindows', moves: [{ windowKey, desktop: target }] });
    return { moving: true, desktop: target };
  }

  /** The desktop a Tidy or Undo acts on: the context's, the one given, or the one on screen. */
  private tidyTarget(target: { contextId?: string; desktop?: number }): number {
    const ctx = target.contextId === undefined ? undefined : this.requireContext(target.contextId);
    this.requireApp();
    const count = this.desktopCount();
    if (count === null) throw new ContextsError(409, 'Tidy needs real desktops. Add a second desktop in Mission Control.');
    const desktop = ctx ? this.contextDesktop(ctx) : (target.desktop ?? this.snapshot?.desktops?.active ?? null);
    if (desktop === null) throw new ContextsError(409, 'The desktop on screen is not known (a fullscreen app?). Name a desktop to tidy.');
    if (desktop > count) throw new ContextsError(400, `There are only ${count} desktops`);
    return desktop;
  }

  /** Explicit Tidy: lays out what is on the desktop now, even if it was tidied with the same windows before. */
  tidy(target: { contextId?: string; desktop?: number }): { desktop: number; windows: number } {
    const desktop = this.tidyTarget(target);
    const desktops = tidyPlan([desktop], this.snapshot?.windows ?? [], this.desktopTargets(), [], this.hiddenKeys);
    if (desktops.length > 0) this.commands.enqueue({ type: 'tidy', desktops, force: true });
    return { desktop, windows: desktops[0]?.windowKeys.length ?? 0 };
  }

  undoTidy(target: { desktop?: number }): { desktop: number } {
    const desktop = this.tidyTarget(target);
    this.commands.enqueue({ type: 'undoTidy', desktop });
    return { desktop };
  }

  setSettings(settings: { autoTidy: boolean }): { autoTidy: boolean } {
    this.store.setAutoTidy(settings.autoTidy);
    this.scheduleEmit();
    return { autoTidy: this.store.autoTidy() };
  }

  /** The owner swiped to another desktop: the context that alone owns it becomes active. No window moves. */
  private followDesktop(previousActive: number | null): void {
    const count = this.desktopCount();
    const active = this.snapshot?.desktops?.active ?? null;
    if (count === null || active === null || active === previousActive) return;
    const focused = active === this.focusDesktop;
    this.focusDesktop = null;
    if (focused) return;
    const owners = this.store.listContexts().filter((c) => !c.parked && desktopFor(c.key, count) === active);
    if (owners.length === 1) this.activeContextId = owners[0].id;
  }

  private autoMatch(w: SnapshotWindow): Match | null {
    return matchWindow(w, this.match.matchables, this.match.titles);
  }

  /**
   * Owner assignments are never touched. With onlyNew (every snapshot), a window that is already sorted
   * moves only on a strong signal for another context, and never if it is a browser: its title follows
   * the active tab, and a window must not jump because the owner looked at another project's page.
   */
  private sortWindows(windows: readonly SnapshotWindow[], opts: { onlyNew: boolean }): number {
    const assignments = this.store.getAssignments();
    const keptUnsorted = this.store.ownerUnsorted();
    const at = new Date(this.now()).toISOString();
    let changed = 0;
    for (const w of windows) {
      if (keptUnsorted.has(w.key)) continue;
      const existing = assignments.get(w.key);
      if (existing?.source === 'owner') {
        this.nameChromeWindow(w, existing.contextId);
        continue;
      }
      const isBrowser = w.browser !== null || isBrowserBundle(w.bundleId);
      if (existing && isBrowser && this.reasonGone(w, existing.contextId)) {
        this.reassignStale(w, at);
        continue;
      }
      const match = this.autoMatch(w);
      if (!match) continue;
      const movable = !existing || !opts.onlyNew || (match.strong && !isBrowser);
      if (existing?.contextId !== match.contextId) {
        if (!movable) continue;
        this.store.setAssignment(w.key, match.contextId, 'auto', at, match.reason);
        changed += 1;
      } else if (existing.reason !== match.reason) {
        this.store.setAssignment(w.key, match.contextId, 'auto', at, match.reason);
      }
      this.nameChromeWindow(w, match.contextId);
    }
    return changed;
  }

  /**
   * True when nothing in the window's tabs or title points at the context it was auto-sorted into any more.
   * Only for windows whose tabs can be read: with the active tab's title alone, switching tabs would move it.
   */
  private reasonGone(w: SnapshotWindow, contextId: string): boolean {
    if (!w.browser || w.browser.tabs.length === 0) return false;
    const own = this.match.matchables.filter((c) => c.id === contextId);
    if (own.length === 0) return false; // matchables not loaded yet: decide nothing
    return matchWindow(w, own, this.match.titles) === null;
  }

  /** Data only: the window is not carried or hidden while the owner may be looking at it. */
  private reassignStale(w: SnapshotWindow, at: string): void {
    const match = this.autoMatch(w);
    if (!match) {
      this.store.clearAssignment(w.key);
      return;
    }
    this.store.setAssignment(w.key, match.contextId, 'auto', at, match.reason);
    this.nameChromeWindow(w, match.contextId);
  }

  /** Names a Chrome window after its context, unless the owner (or anyone but us) named it. */
  private nameChromeWindow(w: SnapshotWindow, contextId: string): void {
    if (!w.browser || !canBeNamed(w.bundleId)) return;
    const ctx = this.store.getContext(contextId);
    if (!ctx) return;
    const record = this.store.getNames().get(w.key);
    if (record?.set_by === 'owner') return;
    const current = w.browser.name;
    if (current && current !== record?.name) {
      this.store.setName(w.key, current, 'owner'); // someone named it: keep their name
      return;
    }
    if (current === ctx.name) return;
    // Already asked. If the browser did not take the name, asking again on every snapshot only queues
    // slow browser scripts in front of the next switch.
    if (record?.set_by === 'switchyard' && record.name === ctx.name) return;
    this.store.setName(w.key, ctx.name, 'switchyard');
    this.commands.enqueue({ type: 'nameWindow', windowKey: w.key, name: ctx.name });
  }

  /** Re-applies the active context after sorting changed. Never takes focus: the owner may be typing. */
  private reshowActive(): void {
    if (this.activeContextId && this.store.getContext(this.activeContextId)) this.enqueueShow(this.activeContextId, false);
  }

  private enqueueShow(contextId: string, focus: boolean): Command {
    const assignments = this.store.getAssignments();
    const known = new Set(this.store.listContexts().map((c) => c.id));
    const rows = new Map(this.store.listContexts().map((c) => [c.id, c]));
    const desktop = this.contextDesktop(rows.get(contextId));
    const windowKeys: string[] = [];
    const hideKeys: string[] = [];
    const strayKeys: string[] = [];
    for (const w of this.snapshot?.windows ?? []) {
      const owner = assignments.get(w.key)?.contextId;
      // Raising a window on another desktop makes macOS follow it there: the switch would bounce back.
      if (owner === contextId) (desktop === null || w.desktop === desktop ? windowKeys : strayKeys).push(w.key);
      else if (!owner || !known.has(owner)) continue; // unsorted windows are left alone
      // With real desktops only contexts sharing the target's desktop are hidden, plus windows that could not
      // be carried away from it.
      else if (desktop === null || this.contextDesktop(rows.get(owner)) === desktop
        || (this.carryFailed.has(w.key) && w.desktop === desktop)) hideKeys.push(w.key);
    }
    this.hiddenKeys = new Set(hideKeys);
    if (desktop === null) return this.commands.enqueue({ type: 'show', contextId, windowKeys, hideKeys, focus });
    return this.commands.enqueue({ type: 'show', contextId, windowKeys, hideKeys, focus, desktop, strayKeys });
  }

  // --- Owner actions ----------------------------------------------------------------

  /**
   * Window actions need the Mac app. Without a recent snapshot a queued command would never run
   * (the app starts from "now" when it connects), so say so instead of pretending it worked.
   */
  private requireApp(): void {
    if (this.snapshotAt !== null && this.now() - this.snapshotAt < SNAPSHOT_FRESH_MS) return;
    throw new ContextsError(
      409,
      "The Switchyard Mac app isn't reporting windows. Open it from the menu bar and allow it under Privacy & Security › Accessibility.",
    );
  }

  private requireContext(id: string): ContextRow {
    const ctx = this.store.getContext(id);
    if (!ctx) throw new ContextsError(404, `Context not found: ${id}`);
    return ctx;
  }

  createTopic(name: string): ContextRow {
    const row = this.store.insertContext({
      id: crypto.randomUUID(), name, folder: null, key: this.store.nextFreeKey(),
      color: PALETTE[this.store.listContexts().length % PALETTE.length], parked: false,
      created_at: new Date(this.now()).toISOString(), last_active_at: null,
    });
    this.scheduleEmit();
    return row;
  }

  patchContext(id: string, patch: { name?: string; color?: string; key?: number | null }): ContextRow {
    this.requireContext(id);
    if (patch.key !== undefined && patch.key !== null) {
      const holder = this.store.listContexts().find((c) => c.key === patch.key && c.id !== id);
      if (holder) throw new ContextsError(409, `Key ${patch.key} is already used by "${holder.name}"`);
    }
    const updated = this.store.updateContext(id, patch) as ContextRow;
    this.scheduleEmit();
    return updated;
  }

  switchTo(id: string): Command {
    const ctx = this.requireContext(id);
    if (ctx.parked) throw new ContextsError(409, 'Context is parked; restore it first');
    this.requireApp();
    this.store.updateContext(id, { last_active_at: new Date(this.now()).toISOString() });
    this.activeContextId = id;
    const command = this.enqueueShow(id, true);
    this.scheduleEmit();
    return command;
  }

  showAll(): Command {
    this.activeContextId = null;
    this.hiddenKeys = new Set();
    const command = this.commands.enqueue({ type: 'showAll' });
    this.scheduleEmit();
    return command;
  }

  /** Saves every browser window's tabs first; only then are close commands queued. */
  park(id: string): { parkedWindows: number } {
    this.requireContext(id);
    this.requireApp();
    const assignments = this.store.getAssignments();
    const names = this.store.getNames();
    const windows = (this.snapshot?.windows ?? []).filter(
      (w) => w.browser !== null && assignments.get(w.key)?.contextId === id,
    );
    this.store.saveParked(
      id,
      windows.map((w) => ({
        browser: w.app,
        name: names.get(w.key)?.name ?? w.browser?.name ?? null,
        urls: (w.browser?.tabs ?? []).map((t) => t.url),
      })),
      new Date(this.now()).toISOString(),
    );
    this.store.updateContext(id, { parked: true });
    if (this.activeContextId === id) this.activeContextId = null;
    this.store.rememberWindows([], windows.map((w) => w.key));
    for (const w of windows) {
      this.lastSeen.delete(w.key);
      this.commands.enqueue({ type: 'closeWindow', windowKey: w.key });
    }
    this.scheduleEmit();
    return { parkedWindows: windows.length };
  }

  /** Reopens saved windows. Saved rows are deleted only when the app acks the open. */
  restore(id: string): { restoredWindows: number } {
    this.requireContext(id);
    this.requireApp();
    const saved = this.store.listParked(id);
    this.store.updateContext(id, { parked: false });
    // With real desktops, go to the context's desktop first so the windows open there. No carry.
    const desktopFirst = this.desktopCount() !== null;
    if (desktopFirst) this.switchTo(id);
    for (const p of saved) {
      const command = this.commands.enqueue({
        type: 'openWindow', browser: p.browser, name: p.name, urls: p.urls, contextId: id,
      });
      this.pendingParked.set(command.seq, p.id);
    }
    if (!desktopFirst) this.switchTo(id);
    return { restoredWindows: saved.length };
  }

  private readonly pendingParked = new Map<number, number>();

  ack(seq: number, ok: boolean, error: string | null, failedKeys: readonly string[] = []): void {
    const command = this.commands.find(seq);
    if (!command) throw new ContextsError(404, `Unknown command: ${seq}`);
    if (command.type === 'moveWindows') this.noteCarries(command.moves.map((m) => m.windowKey), failedKeys);
    const parkedId = this.pendingParked.get(seq);
    this.pendingParked.delete(seq);
    if (!ok) {
      console.warn(`[contexts] app failed command ${seq} (${command.type}): ${error ?? 'no detail'}`);
      this.lastFailure = { action: command.type, error: error ?? 'no detail', at: new Date(this.now()).toISOString() };
      this.scheduleEmit();
      return;
    }
    if (this.lastFailure) {
      this.lastFailure = null;
      this.scheduleEmit();
    }
    if (parkedId !== undefined) {
      this.store.deleteParked(parkedId);
      this.scheduleEmit();
    }
  }

  /** Failed windows are hidden off-screen from now on; the active context is re-applied so that happens now. */
  private noteCarries(attempted: readonly string[], failed: readonly string[]): void {
    for (const key of attempted) this.carryFailed.delete(key);
    for (const key of failed) this.carryFailed.add(key);
    if (failed.length > 0) this.reshowActive();
  }

  /** Owner's Move. The window is carried to the context's desktop at once; the owner stays where they are. */
  assign(windowKey: string, contextId: string): { moving: boolean; desktop: number | null } {
    const ctx = this.requireContext(contextId);
    const win = this.snapshot?.windows.find((w) => w.key === windowKey);
    this.store.setAssignment(windowKey, contextId, 'owner', new Date(this.now()).toISOString(), OWNER_REASON);
    if (win?.browser) {
      for (const tab of win.browser.tabs) {
        const pattern = learnPattern(tab.url);
        if (pattern) this.store.learnRule(pattern, contextId);
      }
      this.nameChromeWindow(win, contextId);
    }
    this.refresh().then(() => undefined, () => undefined);
    return this.afterMove(windowKey, this.contextDesktop(ctx));
  }

  private afterMove(windowKey: string, target: number | null): { moving: boolean; desktop: number | null } {
    const result = this.carryMoved(windowKey, target);
    this.reshowActive();
    if (result.moving) this.tidyChanged([{ windowKey, desktop: target as number }]);
    this.scheduleEmit();
    return result;
  }

  /**
   * The owner moved a window to Unsorted. Auto-sort leaves it there, and the rules its tabs taught the old
   * context are forgotten so they don't pull it (or its twins) straight back.
   */
  unassign(windowKey: string): { moving: boolean; desktop: number | null } {
    const previous = this.store.getAssignments().get(windowKey)?.contextId;
    const win = this.snapshot?.windows.find((w) => w.key === windowKey);
    const forget = previous === undefined ? [] : (win?.browser?.tabs ?? [])
      .map((t) => learnPattern(t.url))
      .filter((p): p is string => p !== null)
      .map((pattern) => ({ pattern, contextId: previous }));
    this.store.unsortWindow(windowKey, new Date(this.now()).toISOString(), forget);
    this.refresh().then(() => undefined, () => undefined);
    return this.afterMove(windowKey, this.desktopCount());
  }

  /** Brings one window to the front. Hides nothing and leaves the active context as it is. */
  focusWindow(windowKey: string): void {
    this.requireApp();
    const win = this.lastSeen.get(windowKey);
    if (!win) throw new ContextsError(404, 'Window not found. Is the Switchyard Mac app running?');
    const active = this.snapshot?.desktops?.active ?? null;
    this.focusDesktop = this.desktopCount() !== null && typeof win.desktop === 'number' && win.desktop !== active ? win.desktop : null;
    this.hiddenKeys = new Set([...this.hiddenKeys].filter((k) => k !== windowKey));
    this.commands.enqueue({ type: 'focusWindow', windowKey });
    this.scheduleEmit();
  }

  renameWindow(windowKey: string, name: string): void {
    const win = this.snapshot?.windows.find((w) => w.key === windowKey);
    if (!win) throw new ContextsError(404, 'Window not found. Is the Switchyard Mac app running?');
    if (!canBeNamed(win.bundleId)) throw new ContextsError(400, `Only Chrome windows can be renamed; this is ${win.app}`);
    this.store.setName(windowKey, name, 'owner');
    this.commands.enqueue({ type: 'nameWindow', windowKey, name });
    this.scheduleEmit();
  }

  async acceptSuggestion(id: string): Promise<void> {
    this.requireApp();
    await this.refresh();
    const suggestion = computeSuggestions(this.viewInput()).find((s) => s.id === id);
    if (!suggestion) throw new ContextsError(404, `Suggestion not found: ${id}`);
    const source = this.snapshot?.windows.find((w) => w.key === suggestion.fromWindowKey);
    const tab = source?.browser?.tabs.find((t) => t.url === suggestion.url);
    if (!source?.browser || !tab) throw new ContextsError(409, 'Source tab is gone');
    const assignments = this.store.getAssignments();
    const target = (this.snapshot?.windows ?? []).find(
      (w) => w.browser && w.bundleId === source.bundleId && assignments.get(w.key)?.contextId === suggestion.toContextId,
    );
    const ctx = this.requireContext(suggestion.toContextId);
    const open: CommandBody = target
      ? { type: 'openTab', windowKey: target.key, url: tab.url }
      : { type: 'openWindow', browser: source.app, name: ctx.name, urls: [tab.url], contextId: ctx.id };
    this.commands.enqueue(open);
    this.commands.enqueue({ type: 'closeTab', windowKey: source.key, tabId: tab.id });
    this.scheduleEmit();
  }
}

/** The tracker stores main agents as "main" or "<session>:main"; anything else is a subagent. */
function isMainAgent(agentId: string): boolean {
  return agentId === 'main' || agentId.endsWith(':main');
}
