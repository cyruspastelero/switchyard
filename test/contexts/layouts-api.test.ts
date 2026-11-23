// Layout preset routes over HTTP: strict bodies, auth, the Mac app saving a capture.
import { describe, it, expect, beforeAll, afterAll } from '../support/harness.ts';
import { setupTestDb, teardownTestDb, authenticate, authedFetch, hookFetch } from '../helpers.ts';

const tmpDir = setupTestDb();
const { createServer } = await import('../../src/server.ts');

const PORT = 14331;
const BASE = `${'http'}://localhost:${PORT}/api/contexts`;
let stop: () => void;
let f: ReturnType<typeof authedFetch>;
let hf: ReturnType<typeof hookFetch>;

const json = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const slot = { bundleId: 'com.google.Chrome', app: 'Chrome', screen: { uuid: 'U-1', builtin: false }, frame: { x: 0, y: 0, w: 1, h: 1 } };

beforeAll(async () => {
  const server = createServer(PORT, true);
  stop = server.stop;
  server.start();
  await new Promise((r) => setTimeout(r, 500));
  f = authedFetch(await authenticate(`http://localhost:${PORT}`, server.accessCode));
  hf = hookFetch(server.hookToken);
});
afterAll(() => {
  stop();
  teardownTestDb(tmpDir);
});

describe('/api/contexts/layouts', () => {
  it('needs_credentials', async () => {
    expect((await fetch(`${BASE}/layouts`)).status).toBe(401);
    expect((await fetch(`${BASE}/layouts`, json('POST', { name: 'a', slots: [slot] }))).status).toBe(401);
  });

  it('the_app_saves_a_preset_and_the_dashboard_lists_renames_and_deletes_it', async () => {
    const created = await hf(`${BASE}/layouts`, json('POST', { name: 'Desk', slots: [slot] }));
    expect(created.status).toBe(201);
    const preset = await created.json();
    expect(preset).toMatchObject({ name: 'Desk', slots: [slot] });
    expect((await (await f(`${BASE}/layouts`)).json()).map((p: { id: string }) => p.id)).toContain(preset.id);
    const renamed = await f(`${BASE}/layouts/${preset.id}`, json('PATCH', { name: 'Two screens' }));
    expect((await renamed.json()).name).toBe('Two screens');
    expect((await f(`${BASE}/settings`, json('PATCH', { defaultLayoutId: preset.id }))).status).toBe(200);
    expect((await (await f(BASE)).json()).defaultLayoutId).toBe(preset.id);
    expect((await f(`${BASE}/layouts/${preset.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await (await f(BASE)).json()).defaultLayoutId).toBeNull();
  });

  it('bad_bodies_are_400_and_unknown_ids_404', async () => {
    expect((await f(`${BASE}/layouts`, json('POST', { name: 'a', slots: [{ ...slot, frame: { x: 2, y: 0, w: 1, h: 1 } }] }))).status).toBe(400);
    expect((await f(`${BASE}/layouts`, json('POST', { name: 'a' }))).status).toBe(400);
    expect((await f(`${BASE}/layouts/nope`, json('PATCH', { name: 'b' }))).status).toBe(404);
    expect((await f(`${BASE}/layouts/nope`, { method: 'DELETE' })).status).toBe(404);
    expect((await f(`${BASE}/settings`, json('PATCH', { defaultLayoutId: 'nope' }))).status).toBe(404);
    expect((await f(`${BASE}/layouts/capture`, json('POST', { name: '' }))).status).toBe(400);
  });

  it('capture_needs_the_mac_app_reporting', async () => {
    expect((await f(`${BASE}/layouts/capture`, json('POST', {}))).status).toBe(409);
  });
});
