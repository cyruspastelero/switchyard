// What reaches the disk: a short, redacted summary of each tool call, for a limited time, readable by the owner only.
import { statSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from '../support/harness.ts';
import { setupTestDb, teardownTestDb, hookFetch } from '../helpers.ts';

const tmpDir = setupTestDb();
const { minimizeToolInput, minimizeToolOutput, redactSecrets } = await import('../../src/services/event-privacy.ts');
const db = await import('../../src/db.ts');
const { writeHookToken, ensurePrivateDir } = await import('../../src/paths.ts');
const { createServer } = await import('../../src/server.ts');

const PORT = 14321;
const BASE = `http://127.0.0.1:${PORT}`;
let stop: () => void;
let hf: ReturnType<typeof hookFetch>;

beforeAll(async () => {
  const server = createServer(PORT, true);
  stop = server.stop;
  server.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  hf = hookFetch(server.hookToken);
});

afterAll(() => {
  stop();
  teardownTestDb(tmpDir);
});

const post = (body: unknown): Promise<Response> =>
  hf(`${BASE}/api/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Made-up values in the shape of real credentials. Assembled at run time so secret scanners do not flag this file.
const fake = (prefix: string, rest: string): string => prefix + rest;
const ANTHROPIC = fake('sk-ant', '-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
const STRIPE = fake('sk_live', '_AbCdEfGhIjKlMnOpQrStUvWx');

const mode = (path: string): number => statSync(path).mode & 0o777;

describe('secret redaction', () => {
  const secrets: readonly [string, string][] = [
    ['an Anthropic key', ANTHROPIC],
    ['a GitHub token', fake('ghp', '_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')],
    ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['a Slack token', fake('xoxb', '-123456789012-abcdefghijklmnop')],
    ['a Stripe key', STRIPE],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV'],
    ['a bearer header', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'],
    ['a password in a url', 'postgres://admin:hunter2secret@db.internal:5432/app'],
    ['an env assignment', 'DATABASE_PASSWORD=correct-horse-battery'],
    ['a json secret', '{"client_secret": "s3cr3t-value-123456"}'],
    ['a token in a query string', 'https://example.test/hook?access_token=abcdef0123456789'],
    ['a private key', fake('-----BEGIN RSA PRIVATE', ' KEY-----\nMIIEowIBAAKCAQEA7\n-----END RSA PRIVATE KEY-----')],
  ];

  it.each(secrets)('removes_%s', (_name, secret) => {
    const { text, found } = redactSecrets(`before ${secret} after`);
    const value = secret.includes('hunter2secret') ? 'hunter2secret' : secret.split(/[=: "@]/).filter((part) => part.length >= 8).pop() ?? secret;
    expect(text).not.toContain(value);
    expect(text).toContain('[REDACTED');
    expect(text).toMatch(/^before /);
    expect(found.length).toBeGreaterThan(0);
  });

  it('leaves_ordinary_text_alone', () => {
    const plain = 'git commit -m "fix: token count in src/auth/login.ts" && npm test -- --watch=false';
    expect(redactSecrets(plain)).toEqual({ text: plain, found: [] });
  });
});

describe('tool input kept on disk', () => {
  it('keeps_only_the_fields_the_dashboard_shows', () => {
    const stored = JSON.parse(minimizeToolInput({
      file_path: '/work/app/src/a.ts', old_string: 'const secretSauce = 1;\nline two', new_string: 'x',
      content: 'whole file body', replace_all: false, unknown_field: 'zzz',
    }) ?? '{}');
    expect(stored).toEqual({ file_path: '/work/app/src/a.ts', removed_lines: 2, added_lines: 1 });
  });

  it('counts_written_lines_without_keeping_the_content', () => {
    const stored = minimizeToolInput({ file_path: '/a.ts', content: 'one\ntwo\nthree' }) ?? '';
    expect(JSON.parse(stored)).toEqual({ file_path: '/a.ts', added_lines: 3 });
    expect(stored).not.toContain('two');
  });

  it('truncates_long_commands_and_redacts_secrets_in_them', () => {
    const stored = JSON.parse(minimizeToolInput({
      command: `curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345" https://api.test ${'x'.repeat(5000)}`,
      description: 'call the api',
    }) ?? '{}');
    expect(stored.command.length).toBeLessThanOrEqual(500);
    expect(stored.command).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(stored.description).toBe('call the api');
  });

  it('accepts_json_text_and_ignores_anything_that_is_not_an_object', () => {
    expect(JSON.parse(minimizeToolInput('{"pattern":"TODO","path":"/work"}') ?? '{}')).toEqual({ pattern: 'TODO', path: '/work' });
    expect(minimizeToolInput('not json')).toBeNull();
    expect(minimizeToolInput(null)).toBeNull();
    expect(minimizeToolInput(['a'])).toBeNull();
    expect(minimizeToolInput({ file_path: { nested: true } })).toBeNull();
  });
});

describe('tool output kept on disk', () => {
  it('keeps_a_short_redacted_preview_not_the_output', () => {
    const body = `API_KEY=${ANTHROPIC}\n${'source line\n'.repeat(2000)}`;
    const text = minimizeToolOutput(body) ?? '';
    const stored = JSON.parse(text);
    expect(text.length).toBeLessThan(600);
    expect(stored.preview.length).toBeLessThanOrEqual(200);
    expect(text).not.toContain('AbCdEfGhIjKlMnOpQrStUvWxYz');
    expect(stored.redacted).toContain('Anthropic key');
  });

  it('keeps_the_error_signal_the_dashboard_counts', () => {
    expect(JSON.parse(minimizeToolOutput({ stderr: 'boom', stdout: 'x'.repeat(900), interrupted: false }) ?? '{}'))
      .toEqual({ stderr: 'boom', preview: 'x'.repeat(200) });
    expect(JSON.parse(minimizeToolOutput({ is_error: true, content: 'nope' }) ?? '{}')).toEqual({ is_error: true, preview: 'nope' });
    expect(minimizeToolOutput(null)).toBeNull();
    expect(minimizeToolOutput({ filePath: '/a', structuredPatch: [] })).toBeNull();
  });
});

describe('events over http', () => {
  it('stores_the_summary_never_the_raw_payload', async () => {
    const res = await post({
      session_id: 'privacy', agent_id: 'main', event_type: 'PostToolUse', tool_name: 'Write',
      tool_input: { file_path: '/work/.env', content: `STRIPE_SECRET=${STRIPE}\n` },
      tool_output: `wrote ${STRIPE} ${'y'.repeat(50_000)}`,
      cwd: '/work', model: 'm',
    });
    expect(res.status).toBe(201);
    const row = db.getEvents(1, 0)[0];
    expect(JSON.parse(row.tool_input ?? '')).toEqual({ file_path: '/work/.env', added_lines: 2 });
    expect((row.tool_input ?? '') + (row.tool_output ?? '')).not.toContain('AbCdEfGhIjKlMnOpQrStUvWx');
    expect((row.tool_output ?? '').length).toBeLessThan(600);
  });

  it('rejects_wrong_types_and_unknown_fields', async () => {
    const base = { session_id: 's', event_type: 'PreToolUse' };
    const bad: unknown[] = [
      { ...base, session_id: { a: 1 } }, { ...base, event_type: 7 }, { ...base, tool_name: ['x'] },
      { ...base, cwd: 5 }, { ...base, agent_id: '' }, { ...base, extra: true },
      { ...base, session_id: 'x'.repeat(300) }, ['array'], 'text',
    ];
    for (const body of bad) expect((await post(body)).status).toBe(400);
    expect((await post(base)).status).toBe(201);
  });
});

describe('retention', () => {
  const insertAt = (daysAgo: number, id: string): void => {
    db.insertEvent({
      agent_id: `${id}:main`, session_id: id, event_type: 'PreToolUse', tool_name: 'Read',
      tool_input: null, tool_output: null, mission_id: null,
      timestamp: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    });
  };

  it('keeps_seven_days_by_default', () => {
    expect(db.EVENT_RETENTION_DAYS).toBe(7);
  });

  it('purges_older_events_and_keeps_their_daily_totals', () => {
    insertAt(8, 'old');
    insertAt(6, 'recent');
    const removed = db.purgeExpiredData();
    expect(removed).toBeGreaterThanOrEqual(1);
    const sessions = db.getEvents(1000, 0).map((e) => e.session_id);
    expect(sessions).not.toContain('old');
    expect(sessions).toContain('recent');
    expect(db.getUsageStats(0).totalToolCalls).toBeGreaterThanOrEqual(2);
  });
});

describe('file permissions', () => {
  it('the_database_is_readable_by_the_owner_only', () => {
    expect(mode(join(tmpDir, 'data.db'))).toBe(0o600);
    for (const side of ['data.db-wal', 'data.db-shm']) {
      try { expect(mode(join(tmpDir, side))).toBe(0o600); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    }
  });

  it('the_data_directory_is_closed_to_other_users_even_when_it_already_existed', () => {
    const dir = join(tmpDir, 'open-dir');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    ensurePrivateDir(dir);
    expect(mode(dir)).toBe(0o700);
  });

  it('the_hook_token_is_owner_only_even_when_the_file_already_existed', () => {
    const dir = join(tmpDir, 'token-dir');
    mkdirSync(dir);
    writeFileSync(join(dir, 'hook-token'), 'old', { mode: 0o644 });
    chmodSync(join(dir, 'hook-token'), 0o644);
    writeHookToken(dir, 'new-token');
    expect(mode(join(dir, 'hook-token'))).toBe(0o600);
  });
});
