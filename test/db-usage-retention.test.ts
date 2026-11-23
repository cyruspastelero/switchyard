import { describe, it, expect, afterAll } from './support/harness.ts';
import { setupTestDb, teardownTestDb } from './helpers.ts';

const tmpDir = setupTestDb();
const db = await import('../src/db.ts');

afterAll(() => teardownTestDb(tmpDir));

// Every call passes a fixed "now" in 2020 so the real clock never purges or windows these events.
const at = (iso: string): number => Date.parse(iso);
const DAY_MS = 86_400_000;

function toolCallAt(iso: string, session = 'retention-session'): void {
  db.insertEvent({
    agent_id: `${session}:main`, session_id: session, event_type: 'PreToolUse', tool_name: 'Read',
    tool_input: null, tool_output: null, mission_id: null, timestamp: iso,
  });
}

function dayOf(stats: ReturnType<typeof db.getUsageStats>, date: string) {
  return stats.dailyCosts.find((d) => d.date === date);
}

describe('usage totals across retention purges', () => {
  it('a_day_split_across_purges_keeps_its_full_total', () => {
    toolCallAt('2020-06-01T06:00:00.000Z');
    toolCallAt('2020-06-01T12:00:00.000Z');
    toolCallAt('2020-06-01T18:00:00.000Z');
    const firstPass = at('2020-06-01T09:00:00.000Z') + db.EVENT_RETENTION_DAYS * DAY_MS;
    const secondPass = at('2020-06-01T20:00:00.000Z') + db.EVENT_RETENTION_DAYS * DAY_MS;

    expect(db.purgeExpiredData(firstPass)).toBe(1);
    expect(dayOf(db.getUsageStats(0, firstPass), '2020-06-01')?.tool_calls).toBe(3);

    expect(db.purgeExpiredData(secondPass)).toBe(2);
    const day = dayOf(db.getUsageStats(0, secondPass), '2020-06-01');
    expect(day?.tool_calls).toBe(3);
    expect(day?.estimated_cost).toBe(0.009);
    expect(day?.sessions).toBe(1);
  });

  it('a_24_hour_window_counts_only_events_from_the_last_24_hours', () => {
    const now = at('2020-06-15T15:00:00.000Z');
    toolCallAt(new Date(now - 30 * 3_600_000).toISOString(), 'window-session');
    toolCallAt(new Date(now - 2 * 3_600_000).toISOString(), 'window-session');

    const stats = db.getUsageStats(24, now);
    expect(stats.totalToolCalls).toBe(1);
    expect(stats.totalEvents).toBe(1);
    expect(stats.totalEstimatedCost).toBe(0.003);
  });

  it('window_totals_equal_the_sum_of_the_daily_series', () => {
    const now = at('2020-06-15T15:00:00.000Z');
    for (const hours of [24, 24 * 7, 24 * 30, 0]) {
      const stats = db.getUsageStats(hours, now);
      const seriesCalls = stats.dailyCosts.reduce((sum, d) => sum + d.tool_calls, 0);
      const seriesCost = stats.dailyCosts.reduce((sum, d) => sum + d.estimated_cost, 0);
      expect(stats.totalToolCalls).toBe(seriesCalls);
      expect(stats.totalEstimatedCost).toBe(parseFloat(seriesCost.toFixed(4)));
    }
  });

  it('a_window_longer_than_retention_counts_purged_days_once', () => {
    const now = at('2020-06-15T15:00:00.000Z');
    // 3 purged on 2020-06-01, 2 live on 2020-06-14/15.
    expect(db.getUsageStats(24 * 30, now).totalToolCalls).toBe(5);
    expect(db.getUsageStats(24 * 30, now).totalSessions).toBe(2);
  });
});
