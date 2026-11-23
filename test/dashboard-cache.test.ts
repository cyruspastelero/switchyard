import { describe, it, expect, beforeAll, afterAll } from './support/harness.ts';
import { setupTestDb, teardownTestDb } from './helpers.ts';

const tmpDir = setupTestDb();
const { createServer } = await import('../src/server.ts');

const PORT = 14299;
const BASE = `http://localhost:${PORT}`;
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  server = createServer(PORT, true);
  server.start();
  await new Promise((r) => setTimeout(r, 300));
});
afterAll(() => {
  server.stop();
  teardownTestDb(tmpDir);
});

describe('dashboard caching', () => {
  it('dashboard_files_are_never_cached_so_a_restart_cannot_leave_a_blank_page', async () => {
    const auth = await fetch(`${BASE}/api/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: server.accessCode }),
    });
    const cookie = (auth.headers.get('set-cookie') ?? '').split(';')[0];
    for (const path of ['/', '/core.js', '/activity.js', '/usage.js', '/app.js', '/picker.js', '/layouts.js', '/contexts.js']) {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toBe('no-store');
    }
  });
});
