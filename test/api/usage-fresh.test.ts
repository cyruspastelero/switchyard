import { describe, it, expect, beforeAll, afterAll } from '../support/harness.ts';
import { setupTestDb, teardownTestDb, authenticate, authedFetch } from '../helpers.ts';

const tmpDir = setupTestDb();
const { createServer } = await import('../../src/server.ts');

const PORT = 14296;
const BASE = `http://localhost:${PORT}`;
let stop: () => void;
let f: ReturnType<typeof authedFetch>;

beforeAll(async () => {
  const server = createServer(PORT, true);
  stop = server.stop;
  server.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
  f = authedFetch(await authenticate(BASE, server.accessCode));
});
afterAll(() => {
  stop();
  teardownTestDb(tmpDir);
});

describe('usage on a fresh install', () => {
  it('a_server_with_no_events_answers_with_zero_usage_not_an_error', async () => {
    const res = await f(`${BASE}/api/usage?hours=24`);
    expect(res.status).toBe(200);
    expect((await res.json()).totalToolCalls).toBe(0);
  });
});
