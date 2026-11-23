import { describe, it, expect, afterAll } from '../support/harness.ts';
import fs from 'node:fs';
import path from 'node:path';
import { setupTestDb, teardownTestDb } from '../helpers.ts';

const tmpDir = setupTestDb();
const projectDir = path.join(process.env.SWITCHYARD_CLAUDE_HOME!, 'projects', 'proj');
fs.mkdirSync(projectDir, { recursive: true });
const { scanSessions } = await import('../../src/services/session-scanner.ts');

afterAll(() => teardownTestDb(tmpDir));

function line(input: number, timestamp = '2026-11-23T10:00:00.000Z'): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: { model: 'claude-sonnet-4-5', usage: { input_tokens: input, output_tokens: 1 } },
  }) + '\n';
}

function session(id: string): string {
  return path.join(projectDir, `${id}.jsonl`);
}

async function usageOf(id: string) {
  return (await scanSessions()).sessions.find((s) => s.sessionId === id)!;
}

describe('session scanner', () => {
  it('scan_is_async_and_sums_usage_per_session', async () => {
    fs.writeFileSync(session('a'), line(100) + 'not json\n' + line(200));
    const pending = scanSessions();
    expect(pending instanceof Promise).toBe(true);
    const a = (await pending).sessions.find((s) => s.sessionId === 'a')!;
    expect(a.inputTokens).toBe(300);
    expect(a.messageCount).toBe(2);
  });

  it('appended_lines_are_parsed_without_rereading_old_bytes', async () => {
    const file = session('b');
    fs.writeFileSync(file, line(100));
    await scanSessions();
    // Same-length edit of the old line: an incremental scan never sees it, a full re-parse would.
    fs.writeFileSync(file, line(900) + line(5));
    const b = await usageOf('b');
    expect(b.inputTokens).toBe(105);
    expect(b.messageCount).toBe(2);
  });

  it('a_half_written_last_line_is_counted_once_it_is_complete', async () => {
    const file = session('c');
    const full = line(7);
    fs.writeFileSync(file, line(1) + full.slice(0, 20));
    expect((await usageOf('c')).inputTokens).toBe(1);
    fs.appendFileSync(file, full.slice(20));
    const c = await usageOf('c');
    expect(c.inputTokens).toBe(8);
    expect(c.messageCount).toBe(2);
  });

  it('a_file_that_shrinks_is_parsed_again_from_the_start', async () => {
    const file = session('d');
    fs.writeFileSync(file, line(10) + line(20));
    await scanSessions();
    fs.writeFileSync(file, line(3));
    expect((await usageOf('d')).inputTokens).toBe(3);
  });

  it('concurrent_scans_of_a_growing_file_count_each_line_once', async () => {
    const file = session('e');
    fs.writeFileSync(file, line(1));
    await scanSessions();
    fs.appendFileSync(file, line(2));
    const [first, second] = await Promise.all([scanSessions(), scanSessions()]);
    for (const summary of [first, second]) {
      expect(summary.sessions.find((s) => s.sessionId === 'e')!.inputTokens).toBe(3);
    }
  });

  it('a_huge_hours_value_does_not_throw', async () => {
    const summary = await scanSessions(Number.MAX_SAFE_INTEGER);
    expect(summary.totalSessions > 0).toBe(true);
  });
});
