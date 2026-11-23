import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, afterAll } from './support/harness.ts';
import { setupTestDb, teardownTestDb } from './helpers.ts';

const tmpDir = setupTestDb();

// A database as the previous version left it: today's live events were also copied into usage_daily.
const now = new Date();
const today = now.toISOString().slice(0, 10);
const legacy = new DatabaseSync(join(tmpDir, 'data.db'));
legacy.exec(`
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, session_id TEXT, event_type TEXT NOT NULL,
    tool_name TEXT, tool_input TEXT, tool_output TEXT, mission_id TEXT, timestamp TEXT);
  CREATE TABLE usage_daily (date TEXT PRIMARY KEY, tool_calls INTEGER DEFAULT 0, total_events INTEGER DEFAULT 0,
    sessions INTEGER DEFAULT 0, unique_tools INTEGER DEFAULT 0, unique_agents INTEGER DEFAULT 0, estimated_cost REAL DEFAULT 0);
  PRAGMA user_version = 1;
`);
const insert = legacy.prepare("INSERT INTO events (agent_id, session_id, event_type, tool_name, timestamp) VALUES ('s:main', 's', 'PreToolUse', 'Read', ?)");
insert.run(now.toISOString());
insert.run(now.toISOString());
legacy.prepare('INSERT INTO usage_daily VALUES (?, 2, 2, 1, 1, 1, 0.006)').run(today);
legacy.close();

const db = await import('../src/db.ts');
afterAll(() => teardownTestDb(tmpDir));

describe('usage summary upgrade', () => {
  it('a_legacy_copy_of_live_events_is_not_counted_twice', () => {
    const stats = db.getUsageStats(0);
    expect(stats.totalToolCalls).toBe(2);
    expect(stats.dailyCosts.find((d) => d.date === today)?.tool_calls).toBe(2);
  });
});
