// Usage statistics for the dashboard: live events plus the daily totals kept after events are purged.

import { readEnv } from "./paths.ts";
import { EVENT_RETENTION_DAYS, getDb } from "./db-connection.ts";

const db = getDb();

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
