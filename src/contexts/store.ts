// SQLite persistence for contexts. Tables are created against the shared DB handle.

import type { Db } from '../sqlite.ts';
import type { AssignSource, NameSetBy, SnapshotWindow } from './types.ts';

export interface ContextRow {
  readonly id: string;
  readonly name: string;
  readonly folder: string | null;
  readonly key: number | null;
  readonly color: string;
  readonly parked: boolean;
  readonly created_at: string;
  readonly last_active_at: string | null;
}

export interface RuleRow {
  readonly pattern: string;
  readonly context_id: string;
  readonly source: 'learned' | 'manual';
}

export interface NameRow {
  readonly window_key: string;
  readonly name: string;
  readonly set_by: NameSetBy;
}

export interface ParkedRow {
  readonly id: number;
  readonly context_id: string;
  readonly browser: string;
  readonly name: string | null;
  readonly urls: readonly string[];
  readonly saved_at: string;
}

export interface ParkedInput {
  readonly browser: string;
  readonly name: string | null;
  readonly urls: readonly string[];
}

export interface LatestEvent {
  readonly event_type: string;
  readonly tool_name: string | null;
  readonly tool_input: string | null;
  readonly timestamp: string;
}

export type ContextPatch = Partial<Pick<ContextRow, 'name' | 'color' | 'key' | 'parked' | 'last_active_at'>>;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS contexts (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    folder         TEXT UNIQUE,
    key            INTEGER CHECK (key IS NULL OR (key >= 1 AND key <= 9)),
    color          TEXT NOT NULL,
    parked         INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    last_active_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contexts_key ON contexts(key) WHERE key IS NOT NULL;

  CREATE TABLE IF NOT EXISTS context_rules (
    pattern    TEXT NOT NULL,
    context_id TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
    source     TEXT NOT NULL CHECK (source IN ('learned','manual')),
    PRIMARY KEY (pattern, context_id)
  );

  CREATE TABLE IF NOT EXISTS window_assignments (
    window_key  TEXT PRIMARY KEY,
    context_id  TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
    source      TEXT NOT NULL CHECK (source IN ('auto','owner')),
    assigned_at TEXT NOT NULL
  );

  -- Windows the owner moved to Unsorted: auto-sort leaves them there until the owner assigns them again.
  CREATE TABLE IF NOT EXISTS window_unsorted (
    window_key  TEXT PRIMARY KEY,
    unsorted_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS window_names (
    window_key TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    set_by     TEXT NOT NULL CHECK (set_by IN ('owner','switchyard'))
  );

  -- Last report of each window, so a card still lists windows on other desktops after a restart. No tab URLs.
  CREATE TABLE IF NOT EXISTS window_last_seen (
    window_key TEXT PRIMARY KEY,
    app        TEXT NOT NULL,
    bundle_id  TEXT NOT NULL,
    pid        INTEGER NOT NULL,
    title      TEXT NOT NULL,
    desktop    INTEGER
  );

  -- One row of owner settings for arranging windows.
  CREATE TABLE IF NOT EXISTS context_settings (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    auto_tidy INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS parked_windows (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    context_id TEXT NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
    browser    TEXT NOT NULL,
    name       TEXT,
    urls       TEXT NOT NULL,
    saved_at   TEXT NOT NULL
  );
`;

type Raw = Omit<ContextRow, 'parked'> & { parked: number };
const toContext = (r: Raw): ContextRow => ({ ...r, parked: r.parked === 1 });

/** Databases created before windows carried a matched-by reason gain the column here. */
function migrate(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(window_assignments)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'reason')) db.exec('ALTER TABLE window_assignments ADD COLUMN reason TEXT');
}

export interface Assignment {
  readonly contextId: string;
  readonly source: AssignSource;
  /** Why the window is in this context; null for automatic assignments made before reasons were recorded. */
  readonly reason: string | null;
}

export function createContextStore(db: Db) {
  db.exec(SCHEMA);
  migrate(db);

  const q = {
    contexts: db.prepare('SELECT * FROM contexts ORDER BY created_at, rowid'),
    context: db.prepare('SELECT * FROM contexts WHERE id = ?'),
    byFolder: db.prepare('SELECT * FROM contexts WHERE folder = ?'),
    usedKeys: db.prepare('SELECT key FROM contexts WHERE key IS NOT NULL'),
    insert: db.prepare(
      `INSERT INTO contexts (id, name, folder, key, color, parked, created_at, last_active_at)
       VALUES (@id, @name, @folder, @key, @color, @parked, @created_at, @last_active_at)`,
    ),
    rules: db.prepare('SELECT * FROM context_rules'),
    dropRule: db.prepare("DELETE FROM context_rules WHERE pattern = ? AND source = 'learned'"),
    forgetRule: db.prepare("DELETE FROM context_rules WHERE pattern = ? AND context_id = ? AND source = 'learned'"),
    addRule: db.prepare('INSERT OR REPLACE INTO context_rules (pattern, context_id, source) VALUES (?, ?, ?)'),
    assignments: db.prepare('SELECT window_key, context_id, source, reason FROM window_assignments'),
    setAssignment: db.prepare(
      `INSERT INTO window_assignments (window_key, context_id, source, assigned_at, reason) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(window_key) DO UPDATE SET context_id = excluded.context_id, source = excluded.source,
         assigned_at = excluded.assigned_at, reason = excluded.reason`,
    ),
    dropAssignment: db.prepare('DELETE FROM window_assignments WHERE window_key = ?'),
    unsorted: db.prepare('SELECT window_key FROM window_unsorted'),
    autoTidy: db.prepare('SELECT auto_tidy FROM context_settings WHERE id = 1'),
    setAutoTidy: db.prepare('INSERT INTO context_settings (id, auto_tidy) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET auto_tidy = excluded.auto_tidy'),
    markUnsorted: db.prepare('INSERT OR REPLACE INTO window_unsorted (window_key, unsorted_at) VALUES (?, ?)'),
    clearUnsorted: db.prepare('DELETE FROM window_unsorted WHERE window_key = ?'),
    seen: db.prepare('SELECT * FROM window_last_seen'),
    saveSeen: db.prepare('INSERT OR REPLACE INTO window_last_seen (window_key, app, bundle_id, pid, title, desktop) VALUES (?, ?, ?, ?, ?, ?)'),
    dropSeen: db.prepare('DELETE FROM window_last_seen WHERE window_key = ?'),
    names: db.prepare('SELECT * FROM window_names'),
    setName: db.prepare(
      `INSERT INTO window_names (window_key, name, set_by) VALUES (?, ?, ?)
       ON CONFLICT(window_key) DO UPDATE SET name = excluded.name, set_by = excluded.set_by`,
    ),
    parked: db.prepare('SELECT * FROM parked_windows WHERE context_id = ? ORDER BY id'),
    parkedCount: db.prepare('SELECT context_id, COUNT(*) AS n FROM parked_windows GROUP BY context_id'),
    addParked: db.prepare('INSERT INTO parked_windows (context_id, browser, name, urls, saved_at) VALUES (?, ?, ?, ?, ?)'),
    dropParked: db.prepare('DELETE FROM parked_windows WHERE id = ?'),
    clearParked: db.prepare('DELETE FROM parked_windows WHERE context_id = ?'),
    latestEvent: db.prepare(
      'SELECT event_type, tool_name, tool_input, timestamp FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT 1',
    ),
    eventBefore: db.prepare(
      "SELECT event_type FROM events WHERE agent_id = ? AND event_type != 'Notification' ORDER BY id DESC LIMIT 1",
    ),
    sessionInputs: db.prepare(
      'SELECT tool_input FROM events WHERE session_id = ? AND tool_input IS NOT NULL ORDER BY id DESC LIMIT ?',
    ),
    toolCalls: db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE agent_id = ? AND timestamp >= ? AND tool_name IS NOT NULL AND tool_name != ''",
    ),
  };

  return {
    listContexts: (): readonly ContextRow[] => (q.contexts.all() as Raw[]).map(toContext),

    getContext(id: string): ContextRow | undefined {
      const r = q.context.get(id) as Raw | undefined;
      return r ? toContext(r) : undefined;
    },

    getContextByFolder(folder: string): ContextRow | undefined {
      const r = q.byFolder.get(folder) as Raw | undefined;
      return r ? toContext(r) : undefined;
    },

    /** Lowest free key 1-9, or null when all nine are taken. */
    nextFreeKey(): number | null {
      const used = new Set((q.usedKeys.all() as { key: number }[]).map((r) => r.key));
      for (let k = 1; k <= 9; k++) if (!used.has(k)) return k;
      return null;
    },

    insertContext(row: ContextRow): ContextRow {
      q.insert.run({ ...row, parked: row.parked ? 1 : 0 });
      return row;
    },

    updateContext(id: string, patch: ContextPatch): ContextRow | undefined {
      const current = this.getContext(id);
      if (!current) return undefined;
      const next: ContextRow = { ...current, ...patch };
      db.prepare('UPDATE contexts SET name = ?, color = ?, key = ?, parked = ?, last_active_at = ? WHERE id = ?').run(
        next.name, next.color, next.key, next.parked ? 1 : 0, next.last_active_at, id,
      );
      return next;
    },

    listRules: (): readonly RuleRow[] => q.rules.all() as RuleRow[],

    /** A learned pattern belongs to one context: relearning moves it. */
    learnRule(pattern: string, contextId: string): void {
      db.transaction(() => {
        q.dropRule.run(pattern);
        q.addRule.run(pattern, contextId, 'learned');
      });
    },

    getAssignments(): ReadonlyMap<string, Assignment> {
      const rows = q.assignments.all() as { window_key: string; context_id: string; source: AssignSource; reason: string | null }[];
      // Hand assignments made before reasons were recorded still have an obvious one.
      const reason = (r: (typeof rows)[number]): string | null => r.reason ?? (r.source === 'owner' ? 'assigned by you' : null);
      return new Map(rows.map((r) => [r.window_key, { contextId: r.context_id, source: r.source, reason: reason(r) }]));
    },

    /** Any assignment ends an earlier "leave it unsorted" choice. */
    setAssignment(windowKey: string, contextId: string, source: AssignSource, at: string, reason: string): void {
      db.transaction(() => {
        q.clearUnsorted.run(windowKey);
        q.setAssignment.run(windowKey, contextId, source, at, reason);
      });
    },

    /** Auto-sort found nothing for the window any more: it goes back to Unsorted (auto-sort may pick it up later). */
    clearAssignment(windowKey: string): void {
      q.dropAssignment.run(windowKey);
    },

    /** The owner moved the window to Unsorted: drop its assignment and the rules it taught that context. */
    unsortWindow(windowKey: string, at: string, forget: readonly { pattern: string; contextId: string }[]): void {
      db.transaction(() => {
        q.dropAssignment.run(windowKey);
        for (const r of forget) q.forgetRule.run(r.pattern, r.contextId);
        q.markUnsorted.run(windowKey, at);
      });
    },

    /** Tidy after Sort and Move. On unless the owner turned it off. */
    autoTidy(): boolean {
      return (q.autoTidy.get() as { auto_tidy: number } | undefined)?.auto_tidy !== 0;
    },

    setAutoTidy(on: boolean): void {
      q.setAutoTidy.run(on ? 1 : 0);
    },

    ownerUnsorted(): ReadonlySet<string> {
      return new Set((q.unsorted.all() as { window_key: string }[]).map((r) => r.window_key));
    },

    getNames(): ReadonlyMap<string, NameRow> {
      return new Map((q.names.all() as NameRow[]).map((r) => [r.window_key, r]));
    },

    setName(windowKey: string, name: string, setBy: NameSetBy): void {
      q.setName.run(windowKey, name, setBy);
    },

    /** Windows as last reported, without their tabs. */
    lastSeenWindows(): readonly SnapshotWindow[] {
      const rows = q.seen.all() as { window_key: string; app: string; bundle_id: string; pid: number; title: string; desktop: number | null }[];
      return rows.map((r) => ({
        key: r.window_key, app: r.app, bundleId: r.bundle_id, pid: r.pid, title: r.title, document: null, browser: null, desktop: r.desktop,
      }));
    },

    /** Replaces the remembered windows in one transaction. */
    rememberWindows(save: readonly SnapshotWindow[], drop: readonly string[]): void {
      if (save.length === 0 && drop.length === 0) return;
      db.transaction(() => {
        for (const key of drop) q.dropSeen.run(key);
        for (const w of save) q.saveSeen.run(w.key, w.app, w.bundleId, w.pid, w.title, w.desktop ?? null);
      });
    },

    listParked(contextId: string): readonly ParkedRow[] {
      const rows = q.parked.all(contextId) as (Omit<ParkedRow, 'urls'> & { urls: string })[];
      return rows.map((r) => ({ ...r, urls: JSON.parse(r.urls) as string[] }));
    },

    parkedCounts(): ReadonlyMap<string, number> {
      const rows = q.parkedCount.all() as { context_id: string; n: number }[];
      return new Map(rows.map((r) => [r.context_id, r.n]));
    },

    /**
     * Replaces the context's saved windows in one transaction, so rows left by a restore the app never acked
     * are not reopened twice. Callers close windows only after this returns.
     */
    saveParked(contextId: string, windows: readonly ParkedInput[], at: string): void {
      db.transaction(() => {
        q.clearParked.run(contextId);
        for (const w of windows) q.addParked.run(contextId, w.browser, w.name, JSON.stringify(w.urls), at);
      });
    },

    deleteParked(id: number): void {
      q.dropParked.run(id);
    },

    latestEvent: (agentId: string): LatestEvent | undefined => q.latestEvent.get(agentId) as LatestEvent | undefined,

    /** Type of the agent's latest event that is not a Notification: tells a prompt from the idle reminder. */
    eventBeforeNotification: (agentId: string): string | null =>
      (q.eventBefore.get(agentId) as { event_type: string } | undefined)?.event_type ?? null,

    /** Tool inputs of a session's latest tool calls, subagents included, newest first. */
    recentToolInputs: (sessionId: string, limit: number): readonly string[] =>
      (q.sessionInputs.all(sessionId, limit) as { tool_input: string }[]).map((r) => r.tool_input),

    toolCallsSince: (agentId: string, sinceIso: string): number =>
      (q.toolCalls.get(agentId, sinceIso) as { n: number }).n,
  };
}

export type ContextStore = ReturnType<typeof createContextStore>;
