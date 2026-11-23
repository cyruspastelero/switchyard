import { describe, it, expect, beforeAll, afterAll } from '../support/harness.ts';
import { setupTestDb, teardownTestDb, authenticate, authedFetch } from '../helpers.ts';

const tmpDir = setupTestDb();

const { createServer } = await import('../../src/server.ts');

let stop: () => void;
let f: ReturnType<typeof authedFetch>;
const PORT = 14281;
const BASE = `http://localhost:${PORT}`;

beforeAll(async () => {
  const server = createServer(PORT);
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

async function post(path: string, body: unknown) {
  return f(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patch(path: string, body: unknown) {
  return f(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/missions', () => {
  it('creates a mission', async () => {
    const res = await post('/api/missions', {
      title: 'Build auth module',
      description: 'Implement JWT auth',
      priority: 5,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.title).toBe('Build auth module');
    expect(data.status).toBe('queued');
    expect(data.priority).toBe(5);
  });

  it('rejects missing title', async () => {
    const res = await post('/api/missions', { description: 'No title' });
    expect(res.status).toBe(400);
  });

  it('rejects empty title', async () => {
    const res = await post('/api/missions', { title: '   ' });
    expect(res.status).toBe(400);
  });

  it('rejects title exceeding 500 chars', async () => {
    const res = await post('/api/missions', { title: 'a'.repeat(501) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('maximum length');
  });

  it('rejects description exceeding 5000 chars', async () => {
    const res = await post('/api/missions', {
      title: 'Valid',
      description: 'x'.repeat(5001),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid depends_on format', async () => {
    const res = await post('/api/missions', {
      title: 'Bad deps',
      depends_on: 'not-an-array',
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/missions', () => {
  it('lists all missions', async () => {
    const res = await f(`${BASE}/api/missions`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by status', async () => {
    const res = await f(`${BASE}/api/missions?status=queued`);
    const data = await res.json();
    expect(data.every((m: any) => m.status === 'queued')).toBe(true);
  });
});

describe('GET /api/missions/:id', () => {
  let missionId: string;

  beforeAll(async () => {
    const res = await post('/api/missions', { title: 'Gettable mission', description: 'Details here' });
    const data = await res.json();
    missionId = data.id;
  });

  it('returns a single mission with events array', async () => {
    const res = await f(`${BASE}/api/missions/${missionId}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(missionId);
    expect(data.title).toBe('Gettable mission');
    expect(Array.isArray(data.events)).toBe(true);
  });

  it('returns 404 for nonexistent mission', async () => {
    const res = await f(`${BASE}/api/missions/no-such-id`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});

describe('PATCH /api/missions/:id', () => {
  let missionId: string;

  beforeAll(async () => {
    const res = await post('/api/missions', { title: 'Patchable' });
    const data = await res.json();
    missionId = data.id;
  });

  it('updates status', async () => {
    const res = await patch(`/api/missions/${missionId}`, { status: 'active' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('active');
    expect(data.started_at).not.toBeNull();
  });

  it('updates title', async () => {
    const res = await patch(`/api/missions/${missionId}`, { title: 'Updated title' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.title).toBe('Updated title');
  });

  it('rejects invalid status', async () => {
    const res = await patch(`/api/missions/${missionId}`, { status: 'invalid' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for nonexistent mission', async () => {
    const res = await patch('/api/missions/nonexistent', { status: 'active' });
    expect(res.status).toBe(404);
  });

  it('rejects empty update', async () => {
    const res = await patch(`/api/missions/${missionId}`, {});
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/missions/:id clears nullable fields', () => {
  it('explicit_null_description_clears_it', async () => {
    const { id } = await (await post('/api/missions', { title: 'Clearable', description: 'old text' })).json();
    const res = await patch(`/api/missions/${id}`, { description: null });
    expect(res.status).toBe(200);
    expect((await res.json()).description).toBeNull();
  });

  it('explicit_null_assigned_agent_unassigns_it', async () => {
    const { id } = await (await post('/api/missions', { title: 'Unassignable' })).json();
    await patch(`/api/missions/${id}`, { assigned_agent_id: 'sess:main' });
    const res = await patch(`/api/missions/${id}`, { assigned_agent_id: null });
    expect((await res.json()).assigned_agent_id).toBeNull();
  });

  it('a_non_string_description_is_rejected_rather_than_clearing_it', async () => {
    const { id } = await (await post('/api/missions', { title: 'Typed', description: 'keep' })).json();
    const res = await patch(`/api/missions/${id}`, { description: 42 });
    expect(res.status).toBe(400);
  });

  it('omitted_fields_keep_their_values', async () => {
    const { id } = await (await post('/api/missions', { title: 'Kept', description: 'stay' })).json();
    const res = await patch(`/api/missions/${id}`, { priority: 3 });
    const data = await res.json();
    expect(data.description).toBe('stay');
    expect(data.title).toBe('Kept');
  });
});

describe('PATCH /api/missions/:id completion', () => {
  it('completing_a_prerequisite_unblocks_its_dependents', async () => {
    const { id: first } = await (await post('/api/missions', { title: 'Prerequisite' })).json();
    const dependent = await (await post('/api/missions', { title: 'Dependent', depends_on: [first] })).json();
    expect(dependent.status).toBe('blocked');
    await patch(`/api/missions/${first}`, { status: 'active' });
    await patch(`/api/missions/${first}`, { status: 'completed' });
    const after = await (await f(`${BASE}/api/missions/${dependent.id}`)).json();
    expect(after.status).toBe('queued');
  });
});

describe('DELETE /api/missions/:id', () => {
  it('deletes a queued mission', async () => {
    const createRes = await post('/api/missions', { title: 'Deletable' });
    const { id } = await createRes.json();

    const res = await f(`${BASE}/api/missions/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
  });

  it('allows deleting a non-queued mission', async () => {
    const createRes = await post('/api/missions', { title: 'Active one' });
    const { id } = await createRes.json();
    await patch(`/api/missions/${id}`, { status: 'active' });

    const res = await f(`${BASE}/api/missions/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
  });

  it('returns 404 for nonexistent mission', async () => {
    const res = await f(`${BASE}/api/missions/nonexistent`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
