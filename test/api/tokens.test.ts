import { describe, it, expect, beforeAll, afterAll } from '../support/harness.ts';
import { setupTestDb, teardownTestDb, authenticate, authedFetch } from '../helpers.ts';

const tmpDir = setupTestDb();

const { createServer } = await import('../../src/server.ts');

let stop: () => void;
let f: ReturnType<typeof authedFetch>;
const PORT = 14287;
const BASE = `http://localhost:${PORT}`;

beforeAll(async () => {
  const server = createServer(PORT, true);
  stop = server.stop;
  server.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const cookie = await authenticate(BASE, server.accessCode);
  f = authedFetch(cookie);
});

afterAll(() => {
  stop();
  teardownTestDb(tmpDir);
});

describe('GET /api/tokens', () => {
  it('returns token summary with correct shape', async () => {
    const res = await f(`${BASE}/api/tokens`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('sessions');
    expect(data).toHaveProperty('daily');
    expect(data).toHaveProperty('models');
    expect(data).toHaveProperty('totalInputTokens');
    expect(data).toHaveProperty('totalOutputTokens');
    expect(data).toHaveProperty('totalCost');
    expect(Array.isArray(data.sessions)).toBe(true);
    expect(Array.isArray(data.daily)).toBe(true);
    expect(Array.isArray(data.models)).toBe(true);
  });

  it('accepts hours parameter', async () => {
    const res = await f(`${BASE}/api/tokens?hours=24`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('sessions');
  });

  it('rejects non-GET methods', async () => {
    const res = await f(`${BASE}/api/tokens`, { method: 'POST' });
    // Server returns 404 because POST /api/tokens route doesn't exist
    expect([404, 405]).toContain(res.status);
  });

  it.each([['abc'], ['-1'], ['1.5'], ['99999999'], ['1e9'], ['']])('rejects_hours_%s_with_400', async (hours) => {
    const res = await f(`${BASE}/api/tokens?hours=${hours}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.includes('hours')).toBe(true);
  });

  it('accepts_hours_zero_for_all_time', async () => {
    const res = await f(`${BASE}/api/tokens?hours=0`);
    expect(res.status).toBe(200);
  });
});
