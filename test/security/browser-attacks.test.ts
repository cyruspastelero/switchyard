// What a web page the owner visits (or a rebound DNS name) may do to the localhost API: nothing.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from '../support/harness.ts';
import { setupTestDb, teardownTestDb, authenticate } from '../helpers.ts';

const tmpDir = setupTestDb();
const { createServer } = await import('../../src/server.ts');

const PORT = 14301;
const BASE = `http://127.0.0.1:${PORT}`;
let stop: () => void;
let cookie = '';
let hookToken = '';
let accessCode = '';
let clock = Date.now();

interface Reply { readonly status: number; readonly headers: http.IncomingHttpHeaders; readonly body: string }

/** Raw request, so the Host header and every other header is exactly what the test says. */
function send(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path, headers: { Host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const json = { 'Content-Type': 'application/json' };

beforeAll(async () => {
  const server = createServer(PORT, true, { now: () => clock });
  stop = server.stop;
  server.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  cookie = await authenticate(BASE, server.accessCode);
  hookToken = server.hookToken;
  accessCode = server.accessCode;
});

afterAll(() => {
  stop();
  teardownTestDb(tmpDir);
});

describe('dns rebinding', () => {
  it('a_request_for_another_host_name_is_refused', async () => {
    const res = await send('GET', '/api/agents', { Host: `evil.example:${PORT}`, Cookie: cookie });
    expect(res.status).toBe(403);
  });

  it('the_login_page_is_not_served_to_a_rebound_name', async () => {
    expect((await send('GET', '/login', { Host: 'evil.example' })).status).toBe(403);
  });

  it('the_right_host_on_the_wrong_port_is_refused', async () => {
    expect((await send('GET', '/login', { Host: '127.0.0.1:9' })).status).toBe(403);
  });

  it('localhost_and_loopback_names_are_served', async () => {
    for (const host of [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]) {
      expect((await send('GET', '/login', { Host: host })).status).toBe(200);
    }
  });
});

describe('cross-origin requests', () => {
  it('a_page_on_the_local_network_cannot_guess_the_access_code', async () => {
    const res = await send('POST', '/api/auth', { ...json, Origin: 'http://192.168.1.50:8080' }, '{"code":"000000"}');
    expect(res.status).toBe(403);
  });

  it('another_app_on_localhost_cannot_use_the_session', async () => {
    const res = await send('POST', '/api/contexts/show-all', { ...json, Cookie: cookie, Origin: 'http://localhost:3000' }, '{}');
    expect(res.status).toBe(403);
  });

  it('a_cross_site_request_without_an_origin_header_is_refused', async () => {
    const res = await send('GET', '/api/agents', { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' });
    expect(res.status).toBe(403);
    const sameSite = await send('GET', '/api/agents', { Cookie: cookie, 'Sec-Fetch-Site': 'same-site' });
    expect(sameSite.status).toBe(403);
  });

  it('the_dashboard_itself_still_works', async () => {
    const headers = { Cookie: cookie, Origin: `http://127.0.0.1:${PORT}`, 'Sec-Fetch-Site': 'same-origin' };
    expect((await send('GET', '/api/agents', headers)).status).toBe(200);
  });

  it('no_cors_headers_are_sent_at_all', async () => {
    const res = await send('GET', '/api/agents', { Cookie: cookie, Origin: `http://127.0.0.1:${PORT}` });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    const preflight = await send('OPTIONS', '/api/contexts/snapshot', { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'PUT' });
    expect(preflight.status).toBe(403);
  });

  it('a_form_post_cannot_carry_a_json_body', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const res = await send('POST', '/api/missions', { Cookie: cookie, 'Content-Type': type }, '{"title":"from a form"}');
      expect(res.status).toBe(415);
    }
    const login = await send('POST', '/api/auth', { 'Content-Type': 'text/plain' }, '{"code":"000000"}');
    expect(login.status).toBe(415);
  });
});

describe('session cookie', () => {
  it('is_http_only_strict_and_expires', async () => {
    const server = await send('POST', '/api/auth', json, JSON.stringify({ code: 'nope00' }));
    expect(server.headers['set-cookie']).toBeUndefined();
    const fresh = createServer(PORT + 50, true);
    fresh.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 50}/api/auth`, { method: 'POST', headers: json, body: JSON.stringify({ code: fresh.accessCode }) });
      const set = res.headers.get('set-cookie') ?? '';
      expect(set).toMatch(/^switchyard_session=[0-9a-f]{64};/);
      expect(set).toContain('HttpOnly');
      expect(set).toContain('SameSite=Strict');
      expect(set).toContain('Path=/');
      expect(set).toMatch(/Max-Age=\d+/);
    } finally {
      fresh.stop();
    }
  });

  it('a_session_stops_working_on_the_server_after_a_day', async () => {
    expect((await send('GET', '/api/agents', { Cookie: cookie })).status).toBe(200);
    clock += 25 * 60 * 60 * 1000;
    expect((await send('GET', '/api/agents', { Cookie: cookie })).status).toBe(401);
    clock -= 25 * 60 * 60 * 1000;
    cookie = await authenticate(BASE, accessCode);
  });

  it('a_cookie_chosen_by_someone_else_is_never_accepted', async () => {
    const planted = `switchyard_session=${'a'.repeat(64)}`;
    await send('POST', '/api/auth', { ...json, Cookie: planted }, JSON.stringify({ code: '000000' }));
    expect((await send('GET', '/api/agents', { Cookie: planted })).status).toBe(401);
  });
});

describe('app-only access code', () => {
  it('a_signed_in_browser_cannot_read_it', async () => {
    expect((await send('GET', '/api/contexts/access-code', { Cookie: cookie })).status).toBe(401);
  });

  it('a_browser_request_is_refused_even_with_the_token', async () => {
    const auth = { Authorization: `Bearer ${hookToken}` };
    expect((await send('GET', '/api/contexts/access-code', auth)).status).toBe(200);
    expect((await send('GET', '/api/contexts/access-code', { ...auth, Origin: `http://127.0.0.1:${PORT}` })).status).toBe(403);
    expect((await send('GET', '/api/contexts/access-code', { ...auth, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(403);
  });
});

describe('input handling', () => {
  it('a_broken_percent_escape_is_a_bad_request_not_a_server_error', async () => {
    expect((await send('GET', '/api/agents/%E0%A4%A', { Cookie: cookie })).status).toBe(400);
    expect((await send('PATCH', '/api/contexts/%E0%A4%A', { ...json, Cookie: cookie }, '{"name":"x"}')).status).toBe(400);
  });

  it('legacy_routes_reject_unknown_fields_wrong_shapes_and_oversized_text', async () => {
    const auth = { ...json, Cookie: cookie };
    const cases: readonly [string, string, unknown][] = [
      ['POST', '/api/missions', { title: 'ok', admin: true }],
      ['POST', '/api/missions', ['not', 'an', 'object']],
      ['POST', '/api/missions', null],
      ['POST', '/api/instructions', { target_agent_id: 'a', message: 'm', extra: 1 }],
      ['POST', '/api/instructions', { target_agent_id: 'a'.repeat(600), message: 'm' }],
      ['POST', '/api/auth', { code: '000000', remember: true }],
    ];
    for (const [method, path, body] of cases) {
      expect((await send(method, path, auth, JSON.stringify(body))).status).toBe(400);
    }
    const created = await send('POST', '/api/missions', auth, JSON.stringify({ title: 'limits' }));
    const id = (JSON.parse(created.body) as { id: string }).id;
    for (const patch of [{ title: 'x'.repeat(501) }, { result: 'x'.repeat(10_001) }, { description: 'x'.repeat(5_001) }, { owner: 'me' }, { priority: 1.5 }]) {
      expect((await send('PATCH', `/api/missions/${id}`, auth, JSON.stringify(patch))).status).toBe(400);
    }
  });

  it('static_files_cannot_be_reached_by_traversal', async () => {
    for (const path of ['/../package.json', '/..%2f..%2fpackage.json', '/icon.svg/../../package.json', '/%2e%2e/package.json', '/package.json']) {
      const res = await send('GET', path, { Cookie: cookie });
      expect(res.body).not.toContain('"devDependencies"');
      expect([400, 404]).toContain(res.status);
    }
  });
});

describe('no outbound network from the dashboard', () => {
  const dashboard = join(import.meta.dirname, '../../src/dashboard');
  const files = ['index.html', 'login.html', 'styles.css', 'core.js', 'activity.js', 'usage.js', 'app.js', 'picker.js', 'contexts.js', 'contexts-logic.js', 'layouts.js', 'desktops.js', 'suggestions.js', 'security.js', 'login.js'];

  it('no_page_script_or_style_loads_anything_from_another_host', () => {
    for (const file of files) {
      const text = readFileSync(join(dashboard, file), 'utf-8');
      const external = text.match(/(?:src|href)\s*=\s*["'](?:https?:)?\/\/[^"']+|@import\s+[^;]+|url\(\s*["']?(?:https?:)?\/\//gi) ?? [];
      expect(external).toEqual([]);
      expect(text).not.toContain('fonts.googleapis.com');
    }
  });

  it('the_content_security_policy_allows_only_this_origin_and_no_inline_script', async () => {
    const csp = String((await send('GET', '/login')).headers['content-security-policy']);
    expect(csp).not.toMatch(/https?:\/\//);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'self'(;|$)/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(readFileSync(join(dashboard, 'login.html'), 'utf-8')).not.toMatch(/<script(?![^>]*\ssrc=)/);
  });
});
