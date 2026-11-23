import { describe, it, expect, beforeAll, afterAll } from './support/harness.ts';
import { setupTestDb, teardownTestDb } from './helpers.ts';

const tmpDir = setupTestDb();
const { createServer } = await import('../src/server.ts');

const PORT = 14295;
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

describe('access codes with multibyte characters', () => {
  // Its own server: the lockout above has already locked this address out of the first one.
  const port = 14294;
  let fresh: ReturnType<typeof createServer>;
  const loginFresh = (code: string) => fetch(`http://localhost:${port}/api/auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
  });
  const multibyte = () => '0'.repeat(fresh.accessCode.length - 1) + '\u00e9';

  beforeAll(async () => {
    fresh = createServer(port, true);
    fresh.start();
    await new Promise((r) => setTimeout(r, 300));
  });
  afterAll(() => fresh.stop());

  it('a_multibyte_code_of_the_right_length_is_a_wrong_code_not_a_server_error', async () => {
    expect((await loginFresh(multibyte())).status).toBe(401);
  });

  it('multibyte_wrong_codes_count_toward_the_lockout', async () => {
    for (let i = 0; i < 4; i++) await loginFresh(multibyte());
    expect((await loginFresh(fresh.accessCode)).status).toBe(429);
  });
});
