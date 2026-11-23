import { describe, it, expect, beforeAll, afterAll } from '../support/harness.ts';
import { setupTestDb, teardownTestDb, authenticate, authedFetch, hookFetch } from '../helpers.ts';

const tmpDir = setupTestDb();
const { createServer } = await import('../../src/server.ts');
const { authorizeContexts, isLoopbackAddress } = await import('../../src/contexts/api.ts');
const { upsertAgent } = await import('../../src/db.ts');

const PORT = 14291;
const BASE = `http://localhost:${PORT}`;
let stop: () => void;
let f: ReturnType<typeof authedFetch>;
let hf: ReturnType<typeof hookFetch>;
let accessCode: string;

const win = { key: 'w1', app: 'Ghostty', bundleId: 'com.mitchellh.ghostty', pid: 3, title: 'zsh', document: null, browser: null };
const json = (body: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  upsertAgent({ id: 'a1', session_id: 's1', agent_id: 'main', name: 'a1', status: 'active', cwd: tmpDir, model: null, current_mission_id: null, first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString() });
  const server = createServer(PORT, true);
  stop = server.stop;
  accessCode = server.accessCode;
  server.start();
  await new Promise((r) => setTimeout(r, 500));
  f = authedFetch(await authenticate(BASE, server.accessCode));
  hf = hookFetch(server.hookToken);
});
afterAll(() => {
  stop();
  teardownTestDb(tmpDir);
});

describe('authorizeContexts', () => {
  it('bearer_token_rejected_from_non_loopback', () => {
    expect(authorizeContexts({ cookieOk: false, bearerOk: true }, '192.168.1.20', false)).toBe('forbidden');
    expect(authorizeContexts({ cookieOk: false, bearerOk: true }, '192.168.1.20', true)).toBe('forbidden');
  });
  it('bearer_token_accepted_from_loopback_in_all_forms', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackAddress(a)).toBe(true);
      expect(authorizeContexts({ cookieOk: false, bearerOk: true }, a, true)).toBe('ok');
    }
  });
  it('cookie_works_from_anywhere_for_dashboard_routes_but_not_app_routes', () => {
    expect(authorizeContexts({ cookieOk: true, bearerOk: false }, '192.168.1.20', false)).toBe('ok');
    expect(authorizeContexts({ cookieOk: true, bearerOk: false }, '127.0.0.1', true)).toBe('unauthorized');
  });
  it('no_credentials_is_unauthorized', () => {
    expect(authorizeContexts({ cookieOk: false, bearerOk: false }, '127.0.0.1', false)).toBe('unauthorized');
  });
});

describe('/api/contexts over http', () => {
  it('requires_credentials', async () => {
    expect((await fetch(`${BASE}/api/contexts`)).status).toBe(401);
  });

  it('get_returns_the_contexts_payload_for_cookie_and_loopback_bearer', async () => {
    for (const fetcher of [f, hf]) {
      const res = await fetcher(`${BASE}/api/contexts`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Object.keys(body).sort()).toEqual(['activeContextId', 'autoTidy', 'contexts', 'defaultLayoutId', 'desktopMode', 'desktopNote', 'desktops', 'lastFailure', 'layouts', 'suggestions', 'toSort', 'unsorted', 'unsortedToMove', 'waitingCount', 'windowControl']);
      expect(body.contexts[0]).toMatchObject({ folder: expect.any(String), key: 1, status: 'idle' });
    }
  });

  it('snapshot_is_app_only', async () => {
    const res = await f(`${BASE}/api/contexts/snapshot`, { method: 'PUT', ...json({ windows: [] }) });
    expect(res.status).toBe(401);
  });

  it('snapshot_rejects_unknown_fields', async () => {
    const res = await hf(`${BASE}/api/contexts/snapshot`, { method: 'PUT', ...json({ windows: [{ ...win, frame: [0, 0, 1, 1] }] }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown field/);
  });

  it('snapshot_over_1mb_is_rejected', async () => {
    const big = { windows: [{ ...win, title: 'x'.repeat(10) }], pad: 'y'.repeat(1_100_000) };
    const res = await hf(`${BASE}/api/contexts/snapshot`, { method: 'PUT', ...json(big) });
    expect(res.status).toBe(413);
  });

  it('accepted_snapshot_turns_window_control_on_and_lists_unsorted_windows', async () => {
    const put = await hf(`${BASE}/api/contexts/snapshot`, { method: 'PUT', ...json({ windows: [win] }) });
    expect(put.status).toBe(200);
    const body = await (await f(`${BASE}/api/contexts`)).json();
    expect(body.windowControl).toBe(true);
    expect(body.unsorted[0]).toEqual({ key: 'w1', app: 'Ghostty', bundleId: 'com.mitchellh.ghostty', title: 'zsh', name: null, tabCount: null, why: null, desktop: null, hidden: false });
  });

  it('create_patch_switch_flow_produces_a_show_command', async () => {
    const created = await f(`${BASE}/api/contexts`, { method: 'POST', ...json({ name: 'Taxes' }) });
    expect(created.status).toBe(201);
    const ctx = await created.json();
    expect(ctx).toMatchObject({ name: 'Taxes', folder: null });
    const patched = await f(`${BASE}/api/contexts/${ctx.id}`, { method: 'PATCH', ...json({ color: '#112233' }) });
    expect((await patched.json()).color).toBe('#112233');
    expect((await f(`${BASE}/api/contexts/${ctx.id}/switch`, { method: 'POST' })).status).toBe(200);
    const cmds = await (await hf(`${BASE}/api/contexts/commands?since=0`)).json();
    expect(cmds.commands.at(-1)).toMatchObject({ type: 'show', contextId: ctx.id, windowKeys: [] });
  });

  it('show_all_queues_a_show_all_command_for_cookie_and_loopback_bearer', async () => {
    for (const fetcher of [f, hf]) {
      expect((await fetcher(`${BASE}/api/contexts/show-all`, { method: 'POST' })).status).toBe(200);
      const cmds = await (await hf(`${BASE}/api/contexts/commands?since=0`)).json();
      expect(cmds.commands.at(-1)).toMatchObject({ type: 'showAll' });
    }
    expect((await (await f(`${BASE}/api/contexts`)).json()).activeContextId).toBeNull();
  });

  it('access_code_is_given_to_the_loopback_app_only_never_to_a_cookie_or_stranger', async () => {
    const res = await hf(`${BASE}/api/contexts/access-code`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accessCode });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await f(`${BASE}/api/contexts/access-code`)).status).toBe(401);
    expect((await fetch(`${BASE}/api/contexts/access-code`)).status).toBe(401);
  });

  it('switch_answers_409_with_a_plain_reason_when_the_mac_app_is_not_connected', async () => {
    const fresh = createServer(PORT + 1, true);
    fresh.start();
    await new Promise((r) => setTimeout(r, 300));
    try {
      const base = `http://localhost:${PORT + 1}`;
      const h2 = hookFetch(fresh.hookToken);
      const id = (await (await h2(`${base}/api/contexts`)).json()).contexts[0].id;
      const res = await h2(`${base}/api/contexts/${id}/switch`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/Mac app isn't reporting windows/);
    } finally {
      fresh.stop();
    }
  });

  it('commands_without_since_returns_the_current_sequence', async () => {
    const body = await (await hf(`${BASE}/api/contexts/commands`)).json();
    expect(body).toEqual({ commands: [], lastSeq: expect.any(Number) });
  });

  it('ack_of_unknown_command_is_404_and_bad_bodies_are_400', async () => {
    expect((await hf(`${BASE}/api/contexts/commands/1/ack`, { method: 'POST', ...json({ ok: true }) })).status).toBe(404);
    expect((await hf(`${BASE}/api/contexts/commands/1/ack`, { method: 'POST', ...json({ ok: 'yes' }) })).status).toBe(400);
    expect((await f(`${BASE}/api/contexts/assign`, { method: 'POST', ...json({ windowKey: 'w1', contextId: 'nope', x: 1 }) })).status).toBe(400);
    expect((await f(`${BASE}/api/contexts/assign`, { method: 'POST', ...json({ windowKey: 'w1', contextId: 'nope' }) })).status).toBe(404);
  });

  it('unassign_takes_a_strict_json_body', async () => {
    expect((await f(`${BASE}/api/contexts/unassign`, { method: 'POST', ...json({ windowKey: 'w1' }) })).status).toBe(200);
    expect((await f(`${BASE}/api/contexts/unassign`, { method: 'POST', ...json({ windowKey: 'w1', x: 1 }) })).status).toBe(400);
    const form = await f(`${BASE}/api/contexts/unassign`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"windowKey":"w1"}' });
    expect(form.status).toBe(415);
    expect((await fetch(`${BASE}/api/contexts/unassign`, { method: 'POST', ...json({ windowKey: 'w1' }) })).status).toBe(401);
  });

  it('renaming_a_window_that_is_not_chrome_is_a_400', async () => {
    await hf(`${BASE}/api/contexts/snapshot`, { method: 'PUT', ...json({ windows: [win] }) });
    const res = await f(`${BASE}/api/contexts/windows/name`, { method: 'POST', ...json({ windowKey: 'w1', name: 'Hello' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Only Chrome windows can be renamed/);
  });

  it('long_poll_returns_as_soon_as_a_command_is_queued', async () => {
    const chromeWin = { ...win, key: 'c1', app: 'Google Chrome', bundleId: 'com.google.Chrome', browser: { windowId: 1, name: null, tabs: [] } };
    await hf(`${BASE}/api/contexts/snapshot`, { method: 'PUT', ...json({ windows: [chromeWin] }) });
    const { lastSeq } = await (await hf(`${BASE}/api/contexts/commands`)).json();
    const poll = hf(`${BASE}/api/contexts/commands?since=${lastSeq}`).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 100));
    await f(`${BASE}/api/contexts/windows/name`, { method: 'POST', ...json({ windowKey: 'c1', name: 'Hello' }) });
    const body = await poll;
    expect(body.commands.find((c: { type: string }) => c.type === 'nameWindow')).toMatchObject({ type: 'nameWindow', windowKey: 'c1', name: 'Hello' });
    expect(body.lastSeq).toBe(Math.max(...body.commands.map((c: { seq: number }) => c.seq)));
  });

  it('switch_reaches_a_waiting_long_poll_without_a_polling_gap', async () => {
    await hf(`${BASE}/api/contexts/snapshot`, { method: 'PUT', ...json({ windows: [win] }) });
    const ctx = await (await f(`${BASE}/api/contexts`, { method: 'POST', ...json({ name: 'Fast' }) })).json();
    const delays: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const { lastSeq } = await (await hf(`${BASE}/api/contexts/commands`)).json();
      let deliveredAt = 0;
      const poll = hf(`${BASE}/api/contexts/commands?since=${lastSeq}`).then(async (r) => {
        const body = await r.json();
        deliveredAt = performance.now();
        return body;
      });
      await new Promise((r) => setTimeout(r, 50));
      const clickedAt = performance.now();
      await hf(`${BASE}/api/contexts/${ctx.id}/switch`, { method: 'POST' });
      const body = await poll;
      expect(body.commands[0]).toMatchObject({ type: 'show', contextId: ctx.id, focus: true });
      delays.push(deliveredAt - clickedAt);
    }
    const median = [...delays].sort((a, b) => a - b)[5];
    console.log(`[timing] switch -> command delivered to the app's long poll: median ${median.toFixed(1)} ms, max ${Math.max(...delays).toFixed(1)} ms`);
    expect(median).toBeLessThan(50);
  });
});

// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const png = (body: Buffer | string = PNG) => ({ headers: { 'Content-Type': 'image/png' }, body });

describe('app icons', () => {
  it('the_app_uploads_an_icon_and_the_dashboard_reads_it_back_privately_cached', async () => {
    expect((await hf(`${BASE}/api/contexts/icons/com.google.Chrome`, { method: 'PUT', ...png() })).status).toBe(200);
    const res = await f(`${BASE}/api/contexts/icons/com.google.Chrome`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toMatch(/^private, max-age=\d+$/);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('icons_are_written_owner_only_under_the_data_dir', async () => {
    const { statSync } = await import('node:fs');
    await hf(`${BASE}/api/contexts/icons/com.mitchellh.ghostty`, { method: 'PUT', ...png() });
    expect(statSync(`${tmpDir}/icons/com.mitchellh.ghostty.png`).mode & 0o777).toBe(0o600);
  });

  it('upload_is_app_only', async () => {
    expect((await f(`${BASE}/api/contexts/icons/com.google.Chrome`, { method: 'PUT', ...png() })).status).toBe(401);
    expect((await fetch(`${BASE}/api/contexts/icons/com.google.Chrome`, { method: 'PUT', ...png() })).status).toBe(401);
  });

  it('upload_checks_the_bundle_id_type_and_size', async () => {
    for (const bad of ['..%2Fetc', 'nodots', 'com.x%2F..', '.com.x', `com.${'a'.repeat(300)}`]) {
      expect((await hf(`${BASE}/api/contexts/icons/${bad}`, { method: 'PUT', ...png() })).status).toBe(400);
    }
    expect((await hf(`${BASE}/api/contexts/icons/com.x.y`, { method: 'PUT', headers: { 'Content-Type': 'image/gif' }, body: PNG })).status).toBe(415);
    expect((await hf(`${BASE}/api/contexts/icons/com.x.y`, { method: 'PUT', ...png('not a png at all') })).status).toBe(400);
    const big = Buffer.concat([PNG, Buffer.alloc(16_384)]);
    expect((await hf(`${BASE}/api/contexts/icons/com.x.y`, { method: 'PUT', ...png(big) })).status).toBe(413);
  });

  it('png_bodies_are_refused_everywhere_but_the_icon_upload', async () => {
    expect((await hf(`${BASE}/api/contexts/snapshot`, { method: 'PUT', ...png() })).status).toBe(415);
  });

  it('reading_needs_a_session_and_an_unknown_icon_is_404', async () => {
    expect((await fetch(`${BASE}/api/contexts/icons/com.google.Chrome`)).status).toBe(401);
    expect((await f(`${BASE}/api/contexts/icons/com.unknown.app`)).status).toBe(404);
  });
});

describe('focus a window', () => {
  it('focus_takes_a_strict_body_and_queues_a_focus_command', async () => {
    await hf(`${BASE}/api/contexts/snapshot`, { method: 'PUT', ...json({ windows: [win] }) });
    expect((await f(`${BASE}/api/contexts/windows/focus`, { method: 'POST', ...json({ windowKey: 'w1', x: 1 }) })).status).toBe(400);
    expect((await f(`${BASE}/api/contexts/windows/focus`, { method: 'POST', ...json({}) })).status).toBe(400);
    expect((await fetch(`${BASE}/api/contexts/windows/focus`, { method: 'POST', ...json({ windowKey: 'w1' }) })).status).toBe(401);
    expect((await f(`${BASE}/api/contexts/windows/focus`, { method: 'POST', ...json({ windowKey: 'w1' }) })).status).toBe(200);
    const cmds = await (await hf(`${BASE}/api/contexts/commands?since=0`)).json();
    expect(cmds.commands.at(-1)).toMatchObject({ type: 'focusWindow', windowKey: 'w1' });
  });

  it('focus_is_409_when_the_mac_app_is_not_connected', async () => {
    const fresh = createServer(PORT + 2, true);
    fresh.start();
    await new Promise((r) => setTimeout(r, 300));
    try {
      const res = await hookFetch(fresh.hookToken)(`http://localhost:${PORT + 2}/api/contexts/windows/focus`, { method: 'POST', ...json({ windowKey: 'w1' }) });
      expect(res.status).toBe(409);
    } finally {
      fresh.stop();
    }
  });
});

describe('arranging endpoints', () => {
  it('tidy_takes_a_strict_body_and_needs_real_desktops', async () => {
    await hf(`${BASE}/api/contexts/snapshot`, { method: 'PUT', ...json({ windows: [win] }) });
    expect((await f(`${BASE}/api/contexts/tidy`, { method: 'POST', ...json({ x: 1 }) })).status).toBe(400);
    expect((await f(`${BASE}/api/contexts/tidy`, { method: 'POST', ...json({ desktop: 0 }) })).status).toBe(400);
    expect((await f(`${BASE}/api/contexts/tidy`, { method: 'POST', ...json({ desktop: 2, contextId: 'c' }) })).status).toBe(400);
    expect((await fetch(`${BASE}/api/contexts/tidy`, { method: 'POST', ...json({}) })).status).toBe(401);
    expect((await f(`${BASE}/api/contexts/tidy`, { method: 'POST', ...json({}) })).status).toBe(409);
    expect((await f(`${BASE}/api/contexts/tidy/undo`, { method: 'POST', ...json({ contextId: 'c' }) })).status).toBe(400);
  });

  it('tidy_on_real_desktops_queues_a_forced_tidy', async () => {
    await hf(`${BASE}/api/contexts/snapshot`, { method: 'PUT', ...json({ windows: [{ ...win, desktop: 3 }], desktops: { count: 6, active: 3 }, canCarry: true }) });
    const res = await f(`${BASE}/api/contexts/tidy`, { method: 'POST', ...json({}) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, desktop: 3 });
    const undo = await f(`${BASE}/api/contexts/tidy/undo`, { method: 'POST', ...json({ desktop: 3 }) });
    expect(await undo.json()).toEqual({ ok: true, desktop: 3 });
    const cmds = await (await hf(`${BASE}/api/contexts/commands?since=0`)).json();
    expect(cmds.commands.at(-1)).toMatchObject({ type: 'undoTidy', desktop: 3 });
  });

  it('auto_tidy_setting_is_strict_and_shows_in_the_view', async () => {
    expect((await f(`${BASE}/api/contexts/settings`, { method: 'PATCH', ...json({ autoTidy: 'no' }) })).status).toBe(400);
    expect((await f(`${BASE}/api/contexts/settings`, { method: 'PATCH', ...json({ autoTidy: true, x: 1 }) })).status).toBe(400);
    const res = await f(`${BASE}/api/contexts/settings`, { method: 'PATCH', ...json({ autoTidy: false }) });
    expect(await res.json()).toEqual({ ok: true, autoTidy: false, defaultLayoutId: null });
    expect((await (await f(`${BASE}/api/contexts`)).json()).autoTidy).toBe(false);
    await f(`${BASE}/api/contexts/settings`, { method: 'PATCH', ...json({ autoTidy: true }) });
  });

  it('unassign_answers_whether_the_window_is_moving', async () => {
    const res = await f(`${BASE}/api/contexts/unassign`, { method: 'POST', ...json({ windowKey: 'w1' }) });
    expect(await res.json()).toMatchObject({ ok: true, moving: true, desktop: 6 });
  });
});
