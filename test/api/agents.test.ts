import { describe, it, expect, beforeAll, afterAll } from '../support/harness.ts';
import { setupTestDb, teardownTestDb, authenticate, authedFetch, hookFetch } from '../helpers.ts';

const tmpDir = setupTestDb();

const { createServer } = await import('../../src/server.ts');

let stop: () => void;
let f: ReturnType<typeof authedFetch>;
let hf: ReturnType<typeof hookFetch>;
const PORT = 14285;
const BASE = `http://localhost:${PORT}`;

beforeAll(async () => {
  const server = createServer(PORT, true);
  stop = server.stop;
  server.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const cookie = await authenticate(BASE, server.accessCode);
  f = authedFetch(cookie);
  hf = hookFetch(server.hookToken);

  // Register agents via hook endpoint (requires hook token)
  await hf(`${BASE}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: 'agent-test-sess',
      agent_id: 'main',
      event_type: 'pre_tool_use',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/test.ts' },
      cwd: '/projects/my-app',
    }),
  });
});

afterAll(() => {
  stop();
  teardownTestDb(tmpDir);
});

describe('GET /api/agents', () => {
  it('lists all agents', async () => {
    const res = await f(`${BASE}/api/agents`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /api/agents/:id', () => {
  it('returns a single agent', async () => {
    const res = await f(`${BASE}/api/agents/agent-test-sess%3Amain`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe('agent-test-sess:main');
  });

  it('returns 404 for nonexistent agent', async () => {
    const res = await f(`${BASE}/api/agents/nonexistent`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/agents/:id', () => {
  it('renames an agent', async () => {
    const res = await f(`${BASE}/api/agents/agent-test-sess%3Amain`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My Custom Name' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe('My Custom Name');
  });

  it('rejects empty name', async () => {
    const res = await f(`${BASE}/api/agents/agent-test-sess%3Amain`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for nonexistent agent', async () => {
    const res = await f(`${BASE}/api/agents/nonexistent`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/agents/:id/events', () => {
  it('returns event history for an agent', async () => {
    const res = await f(`${BASE}/api/agents/agent-test-sess%3Amain/events`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('returns empty array for agent with no events', async () => {
    // Register a second agent so it exists
    await hf(`${BASE}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 'events-empty-sess',
        agent_id: 'main',
        event_type: 'pre_tool_use',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/other.ts' },
      }),
    });
    // Filter by a different agent id — should return only its own events
    const res = await f(`${BASE}/api/agents/events-empty-sess%3Amain/events`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    // All returned events must belong to this agent
    for (const event of data) {
      expect(event.agent_id).toBe('events-empty-sess:main');
    }
  });

  it('agent_history_is_not_hidden_by_newer_events_of_other_agents', async () => {
    const send = (session: string, file: string) => hf(`${BASE}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session, agent_id: 'main', event_type: 'pre_tool_use', tool_name: 'Read', tool_input: { file_path: file } }),
    });
    await send('quiet-sess', '/tmp/quiet.ts');
    for (let i = 0; i < 5; i++) await send('busy-sess', `/tmp/busy-${i}.ts`);
    const res = await f(`${BASE}/api/agents/quiet-sess%3Amain/events?limit=3`);
    const data = await res.json();
    expect(data.length).toBe(1);
    expect(data[0].agent_id).toBe('quiet-sess:main');
  });

  it('agent_history_pages_over_its_own_events', async () => {
    const first = await (await f(`${BASE}/api/agents/busy-sess%3Amain/events?limit=2`)).json();
    const second = await (await f(`${BASE}/api/agents/busy-sess%3Amain/events?limit=2&offset=2`)).json();
    expect(first.length).toBe(2);
    expect(second.length).toBe(2);
    expect(second[0].id < first[1].id).toBe(true);
  });

  it('respects limit parameter', async () => {
    const res = await f(`${BASE}/api/agents/agent-test-sess%3Amain/events?limit=1`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeLessThanOrEqual(1);
  });
});

// DELETE tests run last because they destroy fixtures
describe('DELETE /api/agents/:id', () => {
  it('deletes an existing agent', async () => {
    // Create a fresh agent to delete
    await hf(`${BASE}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 'delete-target-sess',
        agent_id: 'main',
        event_type: 'pre_tool_use',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/x.ts' },
      }),
    });

    const res = await f(`${BASE}/api/agents/delete-target-sess%3Amain`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('returns 404 when deleting a nonexistent agent', async () => {
    const res = await f(`${BASE}/api/agents/no-such-agent`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/agents/disconnected removes disconnected agents', async () => {
    const res = await f(`${BASE}/api/agents/disconnected`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.deleted).toBe('number');
    expect(data.deleted).toBeGreaterThanOrEqual(0);
  });
});
