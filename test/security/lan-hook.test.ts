import { describe, it, expect, beforeAll, afterAll } from '../support/harness.ts';
import { networkInterfaces } from 'node:os';
import { setupTestDb, teardownTestDb } from '../helpers.ts';

const tmpDir = setupTestDb();
const { createServer } = await import('../../src/server.ts');

const PORT = 14297;
/** This machine's own LAN address: a request to it arrives from a non-loopback socket address. */
const lanIp = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
let server: ReturnType<typeof createServer>;

const event = { session_id: 'lan-sess', agent_id: 'main', event_type: 'pre_tool_use', tool_name: 'Read', tool_input: { file_path: '/tmp/a.ts' } };
const hook = (host: string, path: string, init: RequestInit = {}) => fetch(`http://${host}:${PORT}${path}`, {
  ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${server.hookToken}`, 'Content-Type': 'application/json' },
});

beforeAll(async () => {
  server = createServer(PORT, false); // --lan: binds every interface
  server.start();
  await new Promise((r) => setTimeout(r, 300));
});
afterAll(() => {
  server.stop();
  teardownTestDb(tmpDir);
});

describe('hook token in --lan mode', { skip: lanIp ? false : 'no LAN address on this machine' }, () => {
  it('a_hook_event_from_another_address_is_refused_even_with_the_token', async () => {
    const res = await hook(lanIp as string, '/api/events', { method: 'POST', body: JSON.stringify(event) });
    expect(res.status).toBe(403);
  });

  it('an_instruction_poll_from_another_address_is_refused_even_with_the_token', async () => {
    expect((await hook(lanIp as string, '/api/instructions/lan-sess%3Amain')).status).toBe(403);
  });

  it('the_hook_on_this_machine_still_posts_events_over_loopback', async () => {
    const res = await hook('127.0.0.1', '/api/events', { method: 'POST', body: JSON.stringify(event) });
    expect(res.status).toBe(201);
  });
});
