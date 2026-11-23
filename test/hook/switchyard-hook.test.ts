import { describe, it, expect, beforeAll, afterAll } from '../support/harness.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { setupTestDb, teardownTestDb, authenticate, authedFetch } from '../helpers.ts';

const execFileAsync = promisify(execFile);
const tmpDir = setupTestDb();

const { createServer } = await import('../../src/server.ts');

let stop: () => void;
let f: ReturnType<typeof authedFetch>;
const PORT = 14283;
const BASE = `http://localhost:${PORT}`;
const HOOK_SCRIPT = path.resolve(import.meta.dirname, '../../src/hook/switchyard-hook.js');

const TOKEN_FILE = path.join(tmpDir, 'hook-token');
let previousToken: string | null = null;

beforeAll(async () => {
  const server = createServer(PORT, true);
  stop = server.stop;
  server.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const cookie = await authenticate(BASE, server.accessCode);
  f = authedFetch(cookie);

  // Save any existing token, then write the test server's hook token
  try {
    previousToken = fs.readFileSync(TOKEN_FILE, 'utf-8');
  } catch {
    previousToken = null;
  }
  fs.writeFileSync(TOKEN_FILE, server.hookToken, 'utf-8');
});

afterAll(() => {
  // Restore previous token file state
  if (previousToken !== null) {
    fs.writeFileSync(TOKEN_FILE, previousToken, 'utf-8');
  } else {
    try {
      fs.unlinkSync(TOKEN_FILE);
    } catch {
      // best-effort
    }
  }
  stop();
  teardownTestDb(tmpDir);
});

function runHook(stdin: string, env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      'node',
      [HOOK_SCRIPT],
      {
        env: {
          ...process.env,
          SWITCHYARD_PORT: String(PORT),
          SWITCHYARD_HOST: 'localhost',
          ...env,
        },
        timeout: 5000,
      },
      (error, stdout, stderr) => {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
    if (child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

describe('hook — event posting', () => {
  it('posts an event to the server', async () => {
    await runHook(
      JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/test.ts' },
        session_id: 'hook-test-sess',
        agent_id: 'main',
      }),
      { CLAUDE_HOOK_EVENT_NAME: 'PreToolUse' },
    );

    const res = await f(`${BASE}/api/agents`);
    const agents = await res.json();
    expect(agents.some((a: any) => a.id === 'hook-test-sess:main')).toBe(true);
  });

  it('a_notification_keeps_its_message_and_type_so_idle_reminders_can_be_told_from_prompts', async () => {
    await runHook(
      JSON.stringify({
        session_id: 'hook-notify-sess',
        hook_event_name: 'Notification',
        message: 'Claude is waiting for your input',
        notification_type: 'idle_prompt',
      }),
    );

    const res = await f(`${BASE}/api/events?agent_id=${encodeURIComponent('hook-notify-sess:main')}`);
    const events = await res.json();
    const stored = events.find((e: any) => e.event_type === 'Notification' && e.session_id === 'hook-notify-sess');
    expect(JSON.parse(stored.tool_input)).toEqual({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
  });

  it('handles subagent events', async () => {
    await runHook(
      JSON.stringify({
        session_id: 'hook-test-sess',
        agent_id: 'sub-xyz',
      }),
      { CLAUDE_HOOK_EVENT_NAME: 'SubagentStart' },
    );

    const res = await f(`${BASE}/api/agents`);
    const agents = await res.json();
    expect(agents.some((a: any) => a.id === 'hook-test-sess:sub-xyz')).toBe(true);
  });
});

describe('hook — instruction delivery', () => {
  it('receives pending instructions via stderr on PreToolUse', async () => {
    // Create an instruction (authed)
    await f(`${BASE}/api/instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_agent_id: 'hook-test-sess:main',
        message: 'Switch to tests',
      }),
    });

    const { stderr } = await runHook(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        session_id: 'hook-test-sess',
        agent_id: 'main',
      }),
      { CLAUDE_HOOK_EVENT_NAME: 'PreToolUse' },
    );

    expect(stderr).toContain('[Switchyard]');
    expect(stderr).toContain('Switch to tests');
  });

  it('does not fetch instructions on PostToolUse', async () => {
    await f(`${BASE}/api/instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_agent_id: 'hook-test-sess:main',
        message: 'Should not appear',
      }),
    });

    const { stderr } = await runHook(
      JSON.stringify({
        tool_name: 'Bash',
        session_id: 'hook-test-sess',
        agent_id: 'main',
      }),
      { CLAUDE_HOOK_EVENT_NAME: 'PostToolUse' },
    );

    expect(stderr).not.toContain('Should not appear');
  });
});

describe('hook — resilience', () => {
  it('exits 0 when server is down', async () => {
    const { stderr } = await runHook(
      JSON.stringify({
        tool_name: 'Read',
        session_id: 'offline-sess',
        agent_id: 'main',
      }),
      {
        CLAUDE_HOOK_EVENT_NAME: 'PreToolUse',
        SWITCHYARD_PORT: '19999',
      },
    );
    expect(typeof stderr).toBe('string');
  });

  it('exits 0 with empty stdin', async () => {
    const { stderr } = await runHook('', {
      CLAUDE_HOOK_EVENT_NAME: 'PreToolUse',
    });
    expect(typeof stderr).toBe('string');
  });

  it('exits 0 with invalid JSON stdin', async () => {
    const { stderr } = await runHook('not valid json{{{', {
      CLAUDE_HOOK_EVENT_NAME: 'PreToolUse',
    });
    expect(typeof stderr).toBe('string');
  });
});
