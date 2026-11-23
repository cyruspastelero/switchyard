// The SQLite connection: schema, upgrades and the retention purge. Queries live in db.ts and usage-stats.ts.

import { join } from "node:path";
import { ensurePrivateDir, readEnv, resolveDataDir } from "./paths.ts";
import { type Db, openSqlite } from "./sqlite.ts";
import { minimizeToolInput, minimizeToolOutput } from "./services/event-privacy.ts";

// ---------------------------------------------------------------------------
// Database initialisation
// ---------------------------------------------------------------------------

const DATA_DIR = resolveDataDir();
const DB_PATH = join(DATA_DIR, "data.db");

/** Raw events are kept this many days (SWITCHYARD_EVENT_RETENTION_DAYS). Daily totals outlive them. */
export const EVENT_RETENTION_DAYS = retentionDays(readEnv("EVENT_RETENTION_DAYS"));

function retentionDays(raw: string | undefined): number {
  const days = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : 7;
}

const STORAGE_VERSION = 1;

/**
 * One-time rewrite of events stored before summaries were introduced: each raw tool input and output is
 * replaced by its redacted summary, then the file is rebuilt so the old text is gone from disk.
 */
function minimizeStoredEvents(db: Db): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version >= STORAGE_VERSION) return;
  const rows = db.prepare("SELECT id, tool_input, tool_output FROM events WHERE tool_input IS NOT NULL OR tool_output IS NOT NULL")
    .all() as { id: number; tool_input: string | null; tool_output: string | null }[];
  const update = db.prepare("UPDATE events SET tool_input = ?, tool_output = ? WHERE id = ?");
  db.transaction(() => {
    for (const row of rows) update.run(minimizeToolInput(row.tool_input), minimizeToolOutput(row.tool_output), row.id);
  });
  db.exec(`PRAGMA user_version = ${STORAGE_VERSION}`);
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  if (rows.length > 0) console.log(`  [db] Reduced ${rows.length} stored events to redacted summaries`);
}

/**
 * Adds the events older than the retention limit to their day in usage_daily, then deletes them, in one
 * transaction. usage_daily holds only purged events, so a day purged over several passes sums its slices.
 * The distinct counts (sessions, tools, agents) count a value on the pass that purges its last event of
 * that day, so a session spanning passes is counted once. Returns the number of events deleted.
 */
function purgeExpired(db: Db, now = Date.now()): number {
  const cutoff = new Date(now - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const costPerCall = parseFloat(readEnv("COST_PER_TOOL_CALL") || '0.003');
  // Only the cutoff's own day can still have events left; their values are counted on a later pass.
  const stillLive = (column: string): string =>
    `(strftime('%Y-%m-%d', timestamp) = @cutoffDate AND ${column} IN (SELECT ${column} FROM remaining WHERE ${column} IS NOT NULL))`;
  const isToolCall = "tool_name IS NOT NULL AND tool_name != ''";
  const rollUp = db.prepare(`
    WITH remaining AS (
      SELECT session_id, tool_name, agent_id FROM events
      WHERE timestamp >= @cutoff AND strftime('%Y-%m-%d', timestamp) = @cutoffDate
    )
    INSERT INTO usage_daily (date, tool_calls, total_events, sessions, unique_tools, unique_agents, estimated_cost)
    SELECT
      strftime('%Y-%m-%d', timestamp) AS date,
      SUM(CASE WHEN ${isToolCall} THEN 1 ELSE 0 END),
      COUNT(*),
      COUNT(DISTINCT CASE WHEN NOT ${stillLive("session_id")} THEN session_id END),
      COUNT(DISTINCT CASE WHEN ${isToolCall} AND NOT ${stillLive("tool_name")} THEN tool_name END),
      COUNT(DISTINCT CASE WHEN NOT ${stillLive("agent_id")} THEN agent_id END),
      SUM(CASE WHEN ${isToolCall} THEN 1 ELSE 0 END) * @cost
    FROM events
    WHERE timestamp < @cutoff
    GROUP BY date
    ON CONFLICT(date) DO UPDATE SET
      tool_calls     = usage_daily.tool_calls + excluded.tool_calls,
      total_events   = usage_daily.total_events + excluded.total_events,
      sessions       = usage_daily.sessions + excluded.sessions,
      unique_tools   = usage_daily.unique_tools + excluded.unique_tools,
      unique_agents  = usage_daily.unique_agents + excluded.unique_agents,
      estimated_cost = COALESCE(usage_daily.estimated_cost, 0) + COALESCE(excluded.estimated_cost, 0)
  `);
  const purged = db.transaction(() => {
    rollUp.run({ cutoff, cutoffDate: cutoff.slice(0, 10), cost: costPerCall });
    return db.prepare('DELETE FROM events WHERE timestamp < ?').run(cutoff);
  });
  if (purged.changes > 0) {
    console.log(`  [db] Purged ${purged.changes} events older than ${EVENT_RETENTION_DAYS} days (stats preserved in usage_daily)`);
  }
  // Instructions that reached their agent are history too.
  db.prepare("DELETE FROM instructions WHERE status = 'delivered' AND delivered_at < ?").run(cutoff);
  return purged.changes;
}

const SUMMARY_VERSION = 2;

/**
 * One-time fix for usage_daily rows written before it held purged events only: the old code also copied
 * today's live events into it and merged purge passes with MAX. Subtracting the events still live for
 * that day leaves (approximately) the purged part, so live and summary add up without double counting.
 */
function summaryOnlyHoldsPurgedEvents(db: Db): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version >= SUMMARY_VERSION) return;
  const costPerCall = parseFloat(readEnv("COST_PER_TOOL_CALL") || '0.003');
  db.transaction(() => {
    db.prepare(`
      WITH live AS (
        SELECT strftime('%Y-%m-%d', timestamp) AS date,
          SUM(CASE WHEN tool_name IS NOT NULL AND tool_name != '' THEN 1 ELSE 0 END) AS tool_calls,
          COUNT(*) AS total_events,
          COUNT(DISTINCT session_id) AS sessions,
          COUNT(DISTINCT CASE WHEN tool_name IS NOT NULL AND tool_name != '' THEN tool_name END) AS unique_tools,
          COUNT(DISTINCT agent_id) AS unique_agents
        FROM events GROUP BY date
      )
      UPDATE usage_daily SET
        tool_calls     = MAX(0, usage_daily.tool_calls - live.tool_calls),
        total_events   = MAX(0, usage_daily.total_events - live.total_events),
        sessions       = MAX(0, usage_daily.sessions - live.sessions),
        unique_tools   = MAX(0, usage_daily.unique_tools - live.unique_tools),
        unique_agents  = MAX(0, usage_daily.unique_agents - live.unique_agents),
        estimated_cost = MAX(0, COALESCE(usage_daily.estimated_cost, 0) - live.tool_calls * @cost)
      FROM live WHERE live.date = usage_daily.date
    `).run({ cost: costPerCall });
    db.exec(`PRAGMA user_version = ${SUMMARY_VERSION}`);
  });
}

function openDatabase(): Db {
  ensurePrivateDir(DATA_DIR);

  const db = openSqlite(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id              TEXT PRIMARY KEY,
      session_id      TEXT,
      agent_id        TEXT DEFAULT 'main',
      name            TEXT,
      status          TEXT DEFAULT 'active',
      cwd             TEXT,
      model           TEXT,
      current_mission_id TEXT,
      first_seen_at   TEXT,
      last_seen_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS missions (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      description     TEXT,
      status          TEXT DEFAULT 'queued',
      priority        INTEGER DEFAULT 0,
      assigned_agent_id TEXT,
      depends_on      TEXT,
      created_at      TEXT,
      started_at      TEXT,
      completed_at    TEXT,
      result          TEXT
    );

    -- subtasks: JSON array of {id, title, done} for progress tracking
    CREATE TABLE IF NOT EXISTS events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id        TEXT,
      session_id      TEXT,
      event_type      TEXT NOT NULL,
      tool_name       TEXT,
      tool_input      TEXT,
      tool_output     TEXT,
      mission_id      TEXT,
      timestamp       TEXT
    );

    CREATE TABLE IF NOT EXISTS instructions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      target_agent_id TEXT NOT NULL,
      message         TEXT NOT NULL,
      status          TEXT DEFAULT 'pending',
      created_at      TEXT,
      delivered_at    TEXT
    );
  `);

  // Migration: add subtasks column to missions (JSON array of {id, title, done})
  try {
    db.exec(`ALTER TABLE missions ADD COLUMN subtasks TEXT`);
  } catch (err) {
    // Already added on an earlier start; any other failure (locked, read-only, corrupt) must surface.
    if (!(err instanceof Error && err.message.includes("duplicate column name"))) {
      throw new Error("Adding missions.subtasks failed", { cause: err });
    }
  }

  // Usage summary table — persists aggregated daily stats even after raw events are purged
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_daily (
      date            TEXT PRIMARY KEY,
      tool_calls      INTEGER DEFAULT 0,
      total_events    INTEGER DEFAULT 0,
      sessions        INTEGER DEFAULT 0,
      unique_tools    INTEGER DEFAULT 0,
      unique_agents   INTEGER DEFAULT 0,
      estimated_cost  REAL DEFAULT 0
    );
  `);

  minimizeStoredEvents(db);
  summaryOnlyHoldsPurgedEvents(db);
  purgeExpired(db);

  return db;
}

const db: Db = openDatabase();

/** Shared handle for modules that own their own tables (e.g. src/contexts). */
export function getDb(): Db {
  return db;
}

/** Applies the retention limit now. The server calls this hourly, so a long-running server keeps to it. */
export function purgeExpiredData(now = Date.now()): number {
  return purgeExpired(db, now);
}
