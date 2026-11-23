import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Create a fresh temp directory for SWITCHYARD_DATA_DIR.
 * Must be called BEFORE importing any src/ modules (they read env on import).
 */
export function setupTestDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'switchyard-test-'));
  process.env.SWITCHYARD_DATA_DIR = dir;
  // Never scan the developer's real ~/.claude logs in tests: slow and nondeterministic.
  process.env.SWITCHYARD_CLAUDE_HOME = join(dir, 'claude-home');
  return dir;
}

/**
 * Clean up the temp directory.
 */
export function teardownTestDb(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/**
 * Authenticate with the server and return the session cookie string.
 * Use this in test beforeAll after starting the server.
 */
export async function authenticate(base: string, accessCode: string): Promise<string> {
  const res = await fetch(`${base}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: accessCode }),
    redirect: 'manual',
  });
  if (!res.ok) {
    throw new Error(`Auth failed: ${res.status}`);
  }
  // Extract Set-Cookie header
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/switchyard_session=([^;]+)/);
  if (!match) {
    throw new Error('No session cookie returned');
  }
  return `switchyard_session=${match[1]}`;
}

/**
 * Create an authenticated fetch wrapper (session cookie).
 */
export function authedFetch(cookie: string) {
  return function (url: string, opts?: RequestInit): Promise<Response> {
    const headers = new Headers(opts?.headers);
    headers.set('Cookie', cookie);
    return fetch(url, { ...opts, headers });
  };
}

/**
 * Create a hook-authenticated fetch wrapper (Bearer token).
 * Use this for POST /api/events and GET /api/instructions/:agentId.
 */
export function hookFetch(hookToken: string) {
  return function (url: string, opts?: RequestInit): Promise<Response> {
    const headers = new Headers(opts?.headers);
    headers.set('Authorization', `Bearer ${hookToken}`);
    return fetch(url, { ...opts, headers });
  };
}
