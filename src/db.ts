import { join } from "node:path";
import { ensurePrivateDir, readEnv, resolveDataDir } from "./paths.ts";
import { type Db, openSqlite } from "./sqlite.ts";
import { minimizeToolInput, minimizeToolOutput } from "./services/event-privacy.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Agent {
  readonly id: string;
  readonly session_id: string;
  readonly agent_id: string;
  readonly name: string | null;
  readonly status: string;
  readonly cwd: string | null;
  readonly model: string | null;
  readonly current_mission_id: string | null;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
}

export interface Mission {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly priority: number;
  readonly assigned_agent_id: string | null;
  readonly depends_on: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly result: string | null;
  readonly subtasks: string | null; // JSON: [{id, title, done}]
}

export interface Event {
  readonly id: number;
  readonly agent_id: string | null;
  readonly session_id: string | null;
  readonly event_type: string;
  readonly tool_name: string | null;
  readonly tool_input: string | null;
  readonly tool_output: string | null;
  readonly mission_id: string | null;
  readonly timestamp: string;
}

export interface Instruction {
  readonly id: number;
  readonly target_agent_id: string;
  readonly message: string;
  readonly status: string;
  readonly created_at: string;
  readonly delivered_at: string | null;
}

interface DashboardStats {
  readonly totalAgents: number;
  readonly activeAgents: number;
  readonly idleAgents: number;
  readonly disconnectedAgents: number;
  readonly totalMissions: number;
  readonly queuedMissions: number;
  readonly activeMissions: number;
  readonly completedMissions: number;
  readonly failedMissions: number;
  readonly blockedMissions: number;
  readonly totalEvents: number;
  readonly pendingInstructions: number;
}

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

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

// -- Events -----------------------------------------------------------------

const stmtInsertEvent = db.prepare(`
  INSERT INTO events (agent_id, session_id, event_type, tool_name, tool_input, tool_output, mission_id, timestamp)
  VALUES (@agent_id, @session_id, @event_type, @tool_name, @tool_input, @tool_output, @mission_id, @timestamp)
`);

export function insertEvent(event: Omit<Event, "id">): Event {
  const info = stmtInsertEvent.run(event);
  return { ...event, id: Number(info.lastInsertRowid) };
}

const stmtGetEvents = db.prepare(`
  SELECT * FROM events ORDER BY id DESC LIMIT @limit OFFSET @offset
`);

export function getEvents(limit = 100, offset = 0): readonly Event[] {
  return stmtGetEvents.all({ limit, offset }) as Event[];
}

const stmtGetAgentEvents = db.prepare(`
  SELECT * FROM events WHERE agent_id = @agent_id ORDER BY id DESC LIMIT @limit OFFSET @offset
`);

/** One agent's events, newest first; limit and offset page over that agent's events only. */
export function getAgentEvents(agentId: string, limit = 100, offset = 0): readonly Event[] {
  return stmtGetAgentEvents.all({ agent_id: agentId, limit, offset }) as Event[];
}

// -- Agents -----------------------------------------------------------------

const stmtUpsertAgent = db.prepare(`
  INSERT INTO agents (id, session_id, agent_id, name, status, cwd, model, current_mission_id, first_seen_at, last_seen_at)
  VALUES (@id, @session_id, @agent_id, @name, @status, @cwd, @model, @current_mission_id, @first_seen_at, @last_seen_at)
  ON CONFLICT(id) DO UPDATE SET
    session_id      = COALESCE(@session_id, agents.session_id),
    agent_id        = COALESCE(@agent_id, agents.agent_id),
    name            = COALESCE(@name, agents.name),
    status          = COALESCE(@status, agents.status),
    cwd             = COALESCE(@cwd, agents.cwd),
    model           = COALESCE(@model, agents.model),
    current_mission_id = COALESCE(@current_mission_id, agents.current_mission_id),
    last_seen_at    = COALESCE(@last_seen_at, agents.last_seen_at)
`);

export function upsertAgent(agent: Agent): Agent {
  stmtUpsertAgent.run(agent);
  // Return the actual DB row (reflects COALESCE results, not the input)
  return getAgent(agent.id) ?? agent;
}

const stmtGetAgents = db.prepare("SELECT * FROM agents ORDER BY last_seen_at DESC");

export function getAgents(): readonly Agent[] {
  return stmtGetAgents.all() as Agent[];
}

const stmtGetAgent = db.prepare("SELECT * FROM agents WHERE id = ?");

export function getAgent(id: string): Agent | undefined {
  return (stmtGetAgent.get(id) as Agent) ?? undefined;
}

const stmtUpdateAgent = db.prepare(`
  UPDATE agents
  SET session_id      = COALESCE(@session_id, session_id),
      agent_id        = COALESCE(@agent_id, agent_id),
      name            = COALESCE(@name, name),
      status          = COALESCE(@status, status),
      cwd             = COALESCE(@cwd, cwd),
      model           = COALESCE(@model, model),
      current_mission_id = COALESCE(@current_mission_id, current_mission_id),
      last_seen_at    = COALESCE(@last_seen_at, last_seen_at)
  WHERE id = @id
`);

export function updateAgent(
  id: string,
  fields: Partial<Omit<Agent, "id" | "first_seen_at">>,
): Agent | undefined {
  stmtUpdateAgent.run({
    id,
    session_id: null,
    agent_id: null,
    name: null,
    status: null,
    cwd: null,
    model: null,
    current_mission_id: null,
    last_seen_at: null,
    ...fields,
  });
  return getAgent(id);
}

export function deleteAgent(id: string): boolean {
  const result = db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  return result.changes > 0;
}

export function deleteDisconnectedAgents(): number {
  const result = db.prepare("DELETE FROM agents WHERE status = 'disconnected'").run();
  return result.changes;
}

// -- Missions ---------------------------------------------------------------

const stmtCreateMission = db.prepare(`
  INSERT INTO missions (id, title, description, status, priority, assigned_agent_id, depends_on, created_at, started_at, completed_at, result)
  VALUES (@id, @title, @description, @status, @priority, @assigned_agent_id, @depends_on, @created_at, @started_at, @completed_at, @result)
`);

export function createMission(mission: Mission): Mission {
  stmtCreateMission.run(mission);
  return mission;
}

const stmtGetMissions = db.prepare(
  "SELECT * FROM missions ORDER BY priority DESC, created_at ASC",
);

export function getMissions(): readonly Mission[] {
  return stmtGetMissions.all() as Mission[];
}

const stmtGetMission = db.prepare("SELECT * FROM missions WHERE id = ?");

export function getMission(id: string): Mission | undefined {
  return (stmtGetMission.get(id) as Mission) ?? undefined;
}

const MISSION_COLUMNS = [
  "title", "description", "status", "priority", "assigned_agent_id", "depends_on", "started_at", "completed_at", "result",
] as const;

/** Updates only the fields given; an explicit null clears that column. */
export function updateMission(
  id: string,
  fields: Partial<Omit<Mission, "id" | "created_at">>,
): Mission | undefined {
  const given = MISSION_COLUMNS.filter((c) => (fields as Record<string, unknown>)[c] !== undefined);
  if (given.length > 0) {
    const values = Object.fromEntries(given.map((c) => [c, (fields as Record<string, unknown>)[c]]));
    db.prepare(`UPDATE missions SET ${given.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`)
      .run({ ...values, id });
  }
  return getMission(id);
}

const stmtDeleteMission = db.prepare("DELETE FROM missions WHERE id = ?");

export function deleteMission(id: string): boolean {
  const info = stmtDeleteMission.run(id);
  return info.changes > 0;
}

// -- Instructions -----------------------------------------------------------

const stmtCreateInstruction = db.prepare(`
  INSERT INTO instructions (target_agent_id, message, status, created_at, delivered_at)
  VALUES (@target_agent_id, @message, @status, @created_at, @delivered_at)
`);

export function createInstruction(
  instruction: Omit<Instruction, "id">,
): Instruction {
  const info = stmtCreateInstruction.run(instruction);
  return { ...instruction, id: Number(info.lastInsertRowid) };
}

const stmtGetPendingInstructions = db.prepare(`
  SELECT * FROM instructions
  WHERE target_agent_id = ? AND status = 'pending'
  ORDER BY created_at ASC
`);

export function getPendingInstructions(
  targetAgentId: string,
): readonly Instruction[] {
  return stmtGetPendingInstructions.all(targetAgentId) as Instruction[];
}

const stmtMarkDelivered = db.prepare(`
  UPDATE instructions SET status = 'delivered', delivered_at = ? WHERE id = ?
`);

const stmtGetInstruction = db.prepare("SELECT * FROM instructions WHERE id = ?");

export function markInstructionDelivered(id: number): Instruction | undefined {
  const now = new Date().toISOString();
  stmtMarkDelivered.run(now, id);
  return (stmtGetInstruction.get(id) as Instruction) ?? undefined;
}

// -- Dashboard stats --------------------------------------------------------

export function getDashboardStats(): DashboardStats {
  const agentCounts = db
    .prepare(
      `SELECT
        COUNT(*)                                                   AS total,
        SUM(CASE WHEN status = 'active'       THEN 1 ELSE 0 END)  AS active,
        SUM(CASE WHEN status = 'idle'         THEN 1 ELSE 0 END)  AS idle,
        SUM(CASE WHEN status = 'disconnected' THEN 1 ELSE 0 END)  AS disconnected
      FROM agents`,
    )
    .get() as { total: number; active: number; idle: number; disconnected: number };

  const missionCounts = db
    .prepare(
      `SELECT
        COUNT(*)                                                    AS total,
        SUM(CASE WHEN status = 'queued'    THEN 1 ELSE 0 END)      AS queued,
        SUM(CASE WHEN status = 'active'    THEN 1 ELSE 0 END)      AS active,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)      AS completed,
        SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END)      AS failed,
        SUM(CASE WHEN status = 'blocked'   THEN 1 ELSE 0 END)      AS blocked
      FROM missions`,
    )
    .get() as {
    total: number;
    queued: number;
    active: number;
    completed: number;
    failed: number;
    blocked: number;
  };

  const eventCount = db
    .prepare("SELECT COUNT(*) AS total FROM events")
    .get() as { total: number };

  const pendingCount = db
    .prepare("SELECT COUNT(*) AS total FROM instructions WHERE status = 'pending'")
    .get() as { total: number };

  return {
    totalAgents: agentCounts.total,
    activeAgents: agentCounts.active,
    idleAgents: agentCounts.idle,
    disconnectedAgents: agentCounts.disconnected,
    totalMissions: missionCounts.total,
    queuedMissions: missionCounts.queued,
    activeMissions: missionCounts.active,
    completedMissions: missionCounts.completed,
    failedMissions: missionCounts.failed,
    blockedMissions: missionCounts.blocked,
    totalEvents: eventCount.total,
    pendingInstructions: pendingCount.total,
  };
}

// -- Usage stats --------------------------------------------------------------

interface ToolUsageStat {
  readonly tool_name: string;
  readonly count: number;
}

interface AgentUsageStat {
  readonly agent_id: string;
  readonly count: number;
}

interface HourlyUsageStat {
  readonly hour: string;
  readonly count: number;
}

interface SessionCostStat {
  readonly session_id: string;
  readonly agent_count: number;
  readonly tool_calls: number;
  readonly first_event: string;
  readonly last_event: string;
  readonly duration_seconds: number;
  readonly estimated_cost: number;
}

interface DailyCostStat {
  readonly date: string;
  readonly tool_calls: number;
  readonly sessions: number;
  readonly estimated_cost: number;
}

interface UsageStats {
  readonly period: string;
  readonly hoursBack: number;
  readonly toolUsage: readonly ToolUsageStat[];
  readonly agentUsage: readonly AgentUsageStat[];
  readonly hourlyActivity: readonly HourlyUsageStat[];
  readonly sessionCosts: readonly SessionCostStat[];
  readonly dailyCosts: readonly DailyCostStat[];
  readonly totalEvents: number;
  readonly totalToolCalls: number;
  readonly totalSessions: number;
  readonly uniqueTools: number;
  readonly uniqueAgents: number;
  readonly totalEstimatedCost: number;
  readonly costPerToolCall: number;
}

// All queries accept a @since param so every stat is scoped to the same window.
// For "all time" we pass a very old date.

const stmtToolUsageFiltered = db.prepare(`
  SELECT tool_name, COUNT(*) AS count
  FROM events
  WHERE tool_name IS NOT NULL AND tool_name != '' AND timestamp >= @since
  GROUP BY tool_name
  ORDER BY count DESC
  LIMIT 20
`);

const stmtAgentUsageFiltered = db.prepare(`
  SELECT agent_id, COUNT(*) AS count
  FROM events
  WHERE agent_id IS NOT NULL AND timestamp >= @since
  GROUP BY agent_id
  ORDER BY count DESC
  LIMIT 20
`);

const stmtHourlyActivity = db.prepare(`
  SELECT strftime('%Y-%m-%dT%H:00:00', timestamp) AS hour, COUNT(*) AS count
  FROM events
  WHERE timestamp >= @since
  GROUP BY hour
  ORDER BY hour ASC
`);

const stmtTotalSessionsFiltered = db.prepare(`
  SELECT COUNT(DISTINCT session_id) AS total FROM events
  WHERE session_id IS NOT NULL AND timestamp >= @since
`);

const stmtUniqueToolsFiltered = db.prepare(`
  SELECT COUNT(DISTINCT tool_name) AS total FROM events
  WHERE tool_name IS NOT NULL AND tool_name != '' AND timestamp >= @since
`);

const stmtUniqueAgentsFiltered = db.prepare(`
  SELECT COUNT(DISTINCT agent_id) AS total FROM events
  WHERE agent_id IS NOT NULL AND timestamp >= @since
`);

const stmtSessionCostsFiltered = db.prepare(`
  SELECT
    session_id,
    COUNT(DISTINCT agent_id) AS agent_count,
    SUM(CASE WHEN tool_name IS NOT NULL AND tool_name != '' THEN 1 ELSE 0 END) AS tool_calls,
    MIN(timestamp) AS first_event,
    MAX(timestamp) AS last_event
  FROM events
  WHERE session_id IS NOT NULL AND timestamp >= @since
  GROUP BY session_id
  ORDER BY MAX(timestamp) DESC
  LIMIT 20
`);

// Daily costs from live events (for days still in the events table)
const stmtDailyCostsFromEvents = db.prepare(`
  SELECT
    strftime('%Y-%m-%d', timestamp) AS date,
    SUM(CASE WHEN tool_name IS NOT NULL AND tool_name != '' THEN 1 ELSE 0 END) AS tool_calls,
    COUNT(*) AS total_events,
    COUNT(DISTINCT session_id) AS sessions
  FROM events
  WHERE timestamp >= @since
  GROUP BY date
  ORDER BY date ASC
`);

// Daily costs from persisted usage_daily (for historical data beyond retention)
const stmtDailyCostsFromSummary = db.prepare(`
  SELECT date, tool_calls, total_events, sessions, estimated_cost
  FROM usage_daily
  WHERE date >= @sinceDate
  ORDER BY date ASC
`);

// Configurable cost per tool call (default: $0.003 — rough estimate for a typical
// Claude API round-trip with tool use, ~1K input + 500 output tokens at Sonnet rates)
const COST_PER_TOOL_CALL = parseFloat(readEnv("COST_PER_TOOL_CALL") || '0.003');

const ALL_TIME_SINCE = '1970-01-01T00:00:00.000Z';

function periodLabel(hoursBack: number): string {
  if (hoursBack === 0) return 'all';
  if (hoursBack <= 24) return '24h';
  if (hoursBack <= 168) return '7d';
  if (hoursBack <= 720) return '30d';
  return hoursBack + 'h';
}

interface DayTotals {
  readonly date: string;
  readonly tool_calls: number;
  readonly total_events: number;
  readonly sessions: number;
  readonly estimated_cost: number;
}

const round4 = (n: number): number => parseFloat(n.toFixed(4));

/**
 * Per-day totals for the window: live events at or after `since`, plus the purged days in usage_daily.
 * Purged events are all older than the retention cutoff, so a window inside retention adds none; a longer
 * one adds whole purged days from the day `since` falls on.
 */
function dailyTotals(since: string, now: number): { days: DayTotals[]; purgedSessions: number } {
  const cutoff = new Date(now - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const purged = since < cutoff
    ? stmtDailyCostsFromSummary.all({ sinceDate: since.slice(0, 10) }) as DayTotals[]
    : [];
  const live = stmtDailyCostsFromEvents.all({ since }) as Omit<DayTotals, "estimated_cost">[];
  const byDate = new Map<string, DayTotals>();
  for (const d of purged) byDate.set(d.date, { ...d, estimated_cost: d.estimated_cost ?? 0 }); // null: no priced calls
  for (const d of live) {
    const before = byDate.get(d.date);
    byDate.set(d.date, {
      date: d.date,
      tool_calls: (before?.tool_calls ?? 0) + d.tool_calls,
      total_events: (before?.total_events ?? 0) + d.total_events,
      sessions: (before?.sessions ?? 0) + d.sessions,
      estimated_cost: (before?.estimated_cost ?? 0) + d.tool_calls * COST_PER_TOOL_CALL,
    });
  }
  return {
    days: Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date)),
    purgedSessions: purged.reduce((total, d) => total + d.sessions, 0),
  };
}

function sessionCostsSince(since: string): SessionCostStat[] {
  const rows = stmtSessionCostsFiltered.all({ since }) as Array<Omit<SessionCostStat, "duration_seconds" | "estimated_cost">>;
  return rows.map((s) => ({
    ...s,
    duration_seconds: Math.max(0, Math.round((new Date(s.last_event).getTime() - new Date(s.first_event).getTime()) / 1000)),
    estimated_cost: round4(s.tool_calls * COST_PER_TOOL_CALL),
  }));
}

/** Usage over the last `hoursBack` hours (0 = all time). Totals are the sums of the daily series. */
export function getUsageStats(hoursBack = 24, now = Date.now()): UsageStats {
  const since = hoursBack === 0
    ? ALL_TIME_SINCE
    : new Date(now - hoursBack * 60 * 60 * 1000).toISOString();

  const { days, purgedSessions } = dailyTotals(since, now);
  const sum = (pick: (d: DayTotals) => number): number => days.reduce((total, d) => total + pick(d), 0);
  const liveSessions = (stmtTotalSessionsFiltered.get({ since }) as { total: number }).total;

  return {
    period: periodLabel(hoursBack),
    hoursBack,
    toolUsage: stmtToolUsageFiltered.all({ since }) as ToolUsageStat[],
    agentUsage: stmtAgentUsageFiltered.all({ since }) as AgentUsageStat[],
    hourlyActivity: stmtHourlyActivity.all({ since }) as HourlyUsageStat[],
    sessionCosts: sessionCostsSince(since),
    dailyCosts: days.map((d) => ({
      date: d.date, tool_calls: d.tool_calls, sessions: d.sessions, estimated_cost: round4(d.estimated_cost),
    })),
    totalEvents: sum((d) => d.total_events),
    totalToolCalls: sum((d) => d.tool_calls),
    // Live sessions are counted once across the window; purged days only kept a count per day.
    totalSessions: purgedSessions + liveSessions,
    uniqueTools: (stmtUniqueToolsFiltered.get({ since }) as { total: number }).total,
    uniqueAgents: (stmtUniqueAgentsFiltered.get({ since }) as { total: number }).total,
    totalEstimatedCost: round4(sum((d) => d.estimated_cost)),
    costPerToolCall: COST_PER_TOOL_CALL,
  };
}

// -- Agent-scoped usage stats -------------------------------------------------

export function getAgentUsageStats(agentId: string, hoursBack = 24): UsageStats {
  const since = hoursBack === 0
    ? ALL_TIME_SINCE
    : new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  const toolUsage = db.prepare(`
    SELECT tool_name, COUNT(*) AS count
    FROM events
    WHERE tool_name IS NOT NULL AND tool_name != '' AND agent_id = @agentId AND timestamp >= @since
    GROUP BY tool_name ORDER BY count DESC LIMIT 20
  `).all({ agentId, since }) as ToolUsageStat[];

  const hourlyActivity = db.prepare(`
    SELECT strftime('%Y-%m-%dT%H:00:00', timestamp) AS hour, COUNT(*) AS count
    FROM events
    WHERE agent_id = @agentId AND timestamp >= @since
    GROUP BY hour ORDER BY hour ASC
  `).all({ agentId, since }) as HourlyUsageStat[];

  const totalEvents = (db.prepare(
    `SELECT COUNT(*) AS total FROM events WHERE agent_id = @agentId AND timestamp >= @since`
  ).get({ agentId, since }) as { total: number }).total;

  const totalToolCalls = (db.prepare(
    `SELECT COUNT(*) AS total FROM events WHERE tool_name IS NOT NULL AND tool_name != '' AND agent_id = @agentId AND timestamp >= @since`
  ).get({ agentId, since }) as { total: number }).total;

  const uniqueTools = (db.prepare(
    `SELECT COUNT(DISTINCT tool_name) AS total FROM events WHERE tool_name IS NOT NULL AND tool_name != '' AND agent_id = @agentId AND timestamp >= @since`
  ).get({ agentId, since }) as { total: number }).total;

  const totalEstimatedCost = parseFloat((totalToolCalls * COST_PER_TOOL_CALL).toFixed(4));

  return {
    period: periodLabel(hoursBack),
    hoursBack,
    toolUsage,
    agentUsage: [{ agent_id: agentId, count: totalEvents }],
    hourlyActivity,
    sessionCosts: [],
    dailyCosts: [],
    totalEvents,
    totalToolCalls,
    totalSessions: 1,
    uniqueTools,
    uniqueAgents: 1,
    totalEstimatedCost,
    costPerToolCall: COST_PER_TOOL_CALL,
  };
}

// db instance is module-private; consumers use named query functions above
