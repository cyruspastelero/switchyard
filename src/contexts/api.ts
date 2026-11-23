// HTTP layer for /api/contexts*. Auth: session cookie, or the hook bearer token from loopback only.
// App-only routes (snapshot, commands) require the bearer token from loopback; a cookie is not enough.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseBody, parseQuery, sendJson } from '../api/utils.ts';
import {
  LIMITS, parseAck, parseAddDesktop, parseAssign, parseDesktopParam, parseCreateContext, parseEmpty, parseFocusWindow, parsePatchContext, parseSnapshot,
  parseSettings, parseTidy, parseUnassign, parseUndoTidy, parseWindowName, type Parsed,
} from './dto.ts';
import { ICON_MAX_BYTES, isBundleId, isPng } from './icons.ts';
import { parseCaptureLayout, parseCreateLayout, parseRenameLayout } from './layouts.ts';
import { ContextsError } from './types.ts';
import type { ContextsService } from './service.ts';

const LONG_POLL_MS = 25_000;

export interface ContextsAuth {
  /** A browser made the request (it sent Origin or Sec-Fetch-Site). App-only routes refuse those outright. */
  readonly fromBrowser?: boolean;
  readonly cookieOk: boolean;
  readonly bearerOk: boolean;
  /** The dashboard access code, handed only to the loopback app so the owner can copy it from the menu bar. */
  readonly accessCode?: string;
}

export type AuthDecision = 'ok' | 'unauthorized' | 'forbidden';

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.startsWith('::ffff:') ? address.slice(7) : address;
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

export function authorizeContexts(
  auth: ContextsAuth,
  remoteAddress: string | undefined,
  appOnly: boolean,
): AuthDecision {
  const loopbackBearer = auth.bearerOk && isLoopbackAddress(remoteAddress);
  if (appOnly) {
    if (loopbackBearer) return 'ok';
    return auth.bearerOk ? 'forbidden' : 'unauthorized';
  }
  if (auth.cookieOk || loopbackBearer) return 'ok';
  return auth.bearerOk ? 'forbidden' : 'unauthorized';
}

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly appOnly: boolean;
  readonly run: (ctx: RouteContext) => Promise<void>;
}

interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly service: ContextsService;
  readonly params: readonly string[];
  readonly query: Record<string, string>;
  readonly accessCode: string | undefined;
}

async function readBody(ctx: RouteContext): Promise<unknown> {
  const declared = Number(ctx.req.headers['content-length'] ?? 0);
  if (declared > LIMITS.snapshotBytes) throw new ContextsError(413, 'Request body too large');
  try {
    return await parseBody(ctx.req);
  } catch (err) {
    const message = (err as Error).message;
    throw new ContextsError(message.includes('too large') ? 413 : 400, message);
  }
}

async function body<T>(ctx: RouteContext, parse: (b: unknown) => Parsed<T>): Promise<T> {
  const parsed = parse(await readBody(ctx));
  if (!parsed.ok) throw new ContextsError(400, parsed.error);
  return parsed.value;
}

/** Reads a binary body, refusing more than `max` bytes. */
function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > max) return Promise.reject(new ContextsError(413, 'Request body too large'));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        req.destroy();
        reject(new ContextsError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(new ContextsError(400, `reading the request body failed: ${err.message}`)));
  });
}

function bundleIdParam(ctx: RouteContext): string {
  const id = ctx.params[0];
  if (!isBundleId(id)) throw new ContextsError(400, 'bundleId must be a reverse-DNS name like com.example.App');
  return id;
}

async function putIcon(c: RouteContext): Promise<void> {
  const id = bundleIdParam(c);
  if (!/^image\/png\s*(;|$)/i.test(c.req.headers['content-type'] ?? '')) throw new ContextsError(415, 'Icons must be image/png');
  const png = await readRaw(c.req, ICON_MAX_BYTES);
  if (!isPng(png)) throw new ContextsError(400, 'Body is not a PNG');
  c.service.icons.put(id, png);
  ok(c);
}

function getIcon(c: RouteContext): void {
  const png = c.service.icons.get(bundleIdParam(c));
  if (!png) throw new ContextsError(404, 'No icon for this app');
  c.res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'private, max-age=86400' });
  c.res.end(png);
}

const ok = (ctx: RouteContext, extra: object = {}): void => sendJson(ctx.res, 200, { ok: true, ...extra });

function desktopParam(ctx: RouteContext): number {
  const n = parseDesktopParam(ctx.params[0]);
  if (!n.ok) throw new ContextsError(400, n.error);
  return n.value;
}

async function contextView(ctx: RouteContext, id: string) {
  const view = await ctx.service.view();
  return view.contexts.find((c) => c.id === id) ?? null;
}

const ROUTES: readonly Route[] = [
  { method: 'GET', pattern: /^$/, appOnly: false, run: async (c) => sendJson(c.res, 200, await c.service.view()) },
  {
    method: 'POST', pattern: /^$/, appOnly: false,
    run: async (c) => {
      const dto = await body(c, parseCreateContext);
      const row = c.service.createTopic(dto.name);
      sendJson(c.res, 201, await contextView(c, row.id));
    },
  },
  { method: 'GET', pattern: /^\/layouts$/, appOnly: false, run: async (c) => sendJson(c.res, 200, c.service.layouts.list()) },
  {
    // The Mac app saves a capture here too (bearer token from loopback).
    method: 'POST', pattern: /^\/layouts$/, appOnly: false,
    run: async (c) => { const d = await body(c, parseCreateLayout); sendJson(c.res, 201, c.service.layouts.create(d)); },
  },
  {
    method: 'POST', pattern: /^\/layouts\/capture$/, appOnly: false,
    run: async (c) => { const d = await body(c, parseCaptureLayout); ok(c, c.service.captureLayout(d)); },
  },
  {
    method: 'PATCH', pattern: /^\/layouts\/([^/]+)$/, appOnly: false,
    run: async (c) => { const d = await body(c, parseRenameLayout); sendJson(c.res, 200, c.service.layouts.rename(c.params[0], d.name)); },
  },
  {
    method: 'DELETE', pattern: /^\/layouts\/([^/]+)$/, appOnly: false,
    run: async (c) => { await body(c, parseEmpty); c.service.layouts.remove(c.params[0]); ok(c); },
  },
  {
    // Before PATCH /:id, which would otherwise take "settings" for a context id.
    method: 'PATCH', pattern: /^\/settings$/, appOnly: false,
    run: async (c) => { const d = await body(c, parseSettings); ok(c, c.service.setSettings(d)); },
  },
  {
    method: 'PATCH', pattern: /^\/([^/]+)$/, appOnly: false,
    run: async (c) => {
      const dto = await body(c, parsePatchContext);
      const row = c.service.patchContext(c.params[0], dto);
      sendJson(c.res, 200, await contextView(c, row.id));
    },
  },
  {
    method: 'POST', pattern: /^\/([^/]+)\/switch$/, appOnly: false,
    run: async (c) => { await body(c, parseEmpty); c.service.switchTo(c.params[0]); ok(c); },
  },
  {
    method: 'POST', pattern: /^\/([^/]+)\/gather$/, appOnly: false,
    run: async (c) => { await body(c, parseEmpty); ok(c, await c.service.gather(c.params[0])); },
  },
  {
    method: 'POST', pattern: /^\/([^/]+)\/park$/, appOnly: false,
    run: async (c) => { await body(c, parseEmpty); ok(c, c.service.park(c.params[0])); },
  },
  {
    method: 'POST', pattern: /^\/([^/]+)\/restore$/, appOnly: false,
    run: async (c) => { await body(c, parseEmpty); ok(c, c.service.restore(c.params[0])); },
  },
  {
    method: 'POST', pattern: /^\/show-all$/, appOnly: false,
    run: async (c) => { await body(c, parseEmpty); c.service.showAll(); ok(c); },
  },
  {
    method: 'POST', pattern: /^\/sort$/, appOnly: false,
    run: async (c) => { await body(c, parseEmpty); ok(c, await c.service.sort()); },
  },
  {
    method: 'POST', pattern: /^\/assign$/, appOnly: false,
    run: async (c) => { const d = await body(c, parseAssign); ok(c, c.service.assign(d.windowKey, d.contextId)); },
  },
  {
    method: 'POST', pattern: /^\/unassign$/, appOnly: false,
    run: async (c) => { const d = await body(c, parseUnassign); ok(c, c.service.unassign(d.windowKey)); },
  },
  {
    method: 'POST', pattern: /^\/tidy$/, appOnly: false,
    run: async (c) => { const d = await body(c, parseTidy); ok(c, c.service.tidy(d)); },
  },
  {
    method: 'POST', pattern: /^\/tidy\/undo$/, appOnly: false,
    run: async (c) => { const d = await body(c, parseUndoTidy); ok(c, c.service.undoTidy(d)); },
  },
  {
    method: 'POST', pattern: /^\/desktops$/, appOnly: false,
    run: async (c) => { const d = await body(c, parseAddDesktop); c.service.desktopAction({ type: 'add', screen: d.screen }); ok(c); },
  },
  {
    method: 'POST', pattern: /^\/desktops\/(\d+)\/(close|show)$/, appOnly: false,
    run: async (c) => {
      const number = desktopParam(c);
      await body(c, parseEmpty);
      c.service.desktopAction({ type: c.params[1] === 'close' ? 'close' : 'show', number });
      ok(c);
    },
  },
  {
    method: 'POST', pattern: /^\/windows\/name$/, appOnly: false,
    run: async (c) => { const d = await body(c, parseWindowName); c.service.renameWindow(d.windowKey, d.name); ok(c); },
  },
  {
    method: 'POST', pattern: /^\/windows\/focus$/, appOnly: false,
    run: async (c) => { const d = await body(c, parseFocusWindow); c.service.focusWindow(d.windowKey); ok(c); },
  },
  { method: 'GET', pattern: /^\/icons\/([^/]+)$/, appOnly: false, run: async (c) => getIcon(c) },
  { method: 'PUT', pattern: /^\/icons\/([^/]+)$/, appOnly: true, run: putIcon },
  {
    method: 'POST', pattern: /^\/suggestions\/([^/]+)\/accept$/, appOnly: false,
    run: async (c) => { await body(c, parseEmpty); await c.service.acceptSuggestion(c.params[0]); ok(c); },
  },
  {
    method: 'PUT', pattern: /^\/snapshot$/, appOnly: true,
    run: async (c) => { await c.service.applySnapshot(await body(c, parseSnapshot)); ok(c); },
  },
  { method: 'GET', pattern: /^\/commands$/, appOnly: true, run: handleCommandPoll },
  {
    // App-only means bearer token + loopback, so the code never leaves this machine.
    method: 'GET', pattern: /^\/access-code$/, appOnly: true,
    run: async (c) => {
      if (!c.accessCode) throw new ContextsError(404, 'Access code is not available');
      c.res.setHeader('Cache-Control', 'no-store');
      sendJson(c.res, 200, { accessCode: c.accessCode });
    },
  },
  {
    method: 'POST', pattern: /^\/commands\/(\d+)\/ack$/, appOnly: true,
    run: async (c) => { const d = await body(c, parseAck); c.service.ack(Number(c.params[0]), d.ok, d.error, d.failedKeys); ok(c); },
  },
];

/** GET /commands?since=<seq>. Without `since`, returns the current seq so the app can start from "now". */
async function handleCommandPoll(c: RouteContext): Promise<void> {
  const queue = c.service.commands;
  if (c.query.since === undefined) {
    sendJson(c.res, 200, { commands: [], lastSeq: queue.lastSeq });
    return;
  }
  const since = Number(c.query.since);
  if (!Number.isSafeInteger(since) || since < 0) throw new ContextsError(400, 'since must be a non-negative integer');
  const commands = await queue.wait(since, LONG_POLL_MS, (abort) => c.res.on('close', abort));
  if (!c.res.writableEnded && !c.res.destroyed) {
    sendJson(c.res, 200, { commands, lastSeq: Math.max(since, ...commands.map((x) => x.seq)) });
  }
}

function findRoute(method: string, rest: string): { route: Route; params: string[] } | 'method' | null {
  let pathMatched = false;
  for (const route of ROUTES) {
    const m = route.pattern.exec(rest);
    if (!m) continue;
    pathMatched = true;
    if (route.method === method) return { route, params: m.slice(1).map(decodeURIComponent) };
  }
  return pathMatched ? 'method' : null;
}

const PREFIX = '/api/contexts';

/** True when this module owns the URL. */
export function isContextsUrl(url: string): boolean {
  const path = url.split('?')[0];
  return path === PREFIX || path.startsWith(`${PREFIX}/`);
}

export async function handleContexts(
  req: IncomingMessage,
  res: ServerResponse,
  service: ContextsService,
  auth: ContextsAuth,
): Promise<void> {
  const url = req.url ?? '/';
  const rest = url.split('?')[0].slice(PREFIX.length).replace(/\/$/, '');
  const found = findRoute(req.method ?? 'GET', rest);
  if (found === null) return sendJson(res, 404, { error: 'Not found' });
  if (found === 'method') return sendJson(res, 405, { error: 'Method not allowed' });
  if (found.route.appOnly && auth.fromBrowser) return sendJson(res, 403, { error: 'This endpoint is for the Switchyard app only' });
  const decision = authorizeContexts(auth, req.socket.remoteAddress, found.route.appOnly);
  if (decision === 'unauthorized') return sendJson(res, 401, { error: 'Unauthorized' });
  if (decision === 'forbidden') return sendJson(res, 403, { error: 'Bearer token is only accepted from loopback' });
  try {
    await found.route.run({ req, res, service, params: found.params, query: parseQuery(url), accessCode: auth.accessCode });
  } catch (err) {
    if (err instanceof ContextsError) return sendJson(res, err.status, { error: err.message });
    throw err;
  }
}
