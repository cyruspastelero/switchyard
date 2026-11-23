import { describe, it, expect, beforeAll, afterAll } from './support/harness.ts';
import { setupTestDb, teardownTestDb } from './helpers.ts';

const tmpDir = setupTestDb();
const { createServer } = await import('../src/server.ts');

const PORT = 14292;
const BASE = `http://localhost:${PORT}`;
let server: ReturnType<typeof createServer>;

const login = (code: string) =>
  fetch(`${BASE}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });

beforeAll(async () => {
  server = createServer(PORT, true);
  server.start();
  await new Promise((r) => setTimeout(r, 300));
});
afterAll(() => {
  server.stop();
  teardownTestDb(tmpDir);
});

describe('access code rate limit', () => {
  it('successful_logins_do_not_count_toward_the_lockout', async () => {
    for (let i = 0; i < 8; i++) expect((await login(server.accessCode)).status).toBe(200);
  });

  it('repeated_wrong_codes_are_locked_out', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await login('000000')).status);
    expect(statuses).toContain(429);
  });
});
