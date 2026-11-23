import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { attachWebSocketServer, type WsClient } from './ws.ts';
import { getDashboardStats, getAgents as dbGetAgents, getEvents as dbGetEvents, getMissions as dbGetMissions, purgeExpiredData } from './db.ts';
import { eventBus, type SecurityEvent } from './services/event-bus.ts';
import { handleEvents } from './api/events.ts';
import { handleAgents } from './api/agents.ts';
import { handleMissions } from './api/missions.ts';
import { handleInstructions } from './api/instructions.ts';
import { handleUsage } from './api/usage.ts';
import { handleTokens } from './api/tokens.ts';
import { parseBody, sendJson, unknownFields } from './api/utils.ts';
import { agentTracker } from './services/agent-tracker.ts';
import { createContextsService, handleContexts, isContextsUrl } from './contexts/index.ts';
import { checkRequestSource, hasJsonBodyOrNone, isBrowserRequest } from './request-guard.ts';

// ---------------------------------------------------------------------------
// Security event helpers
// ---------------------------------------------------------------------------

function emitSecurityEvent(
  layer: number,
  layerName: string,
  severity: SecurityEvent['severity'],
  message: string,
  detail: string | null = null,
): void {
  const event: SecurityEvent = {
    layer,
    layerName,
    severity,
    message,
    detail,
    timestamp: new Date().toISOString(),
  };
  eventBus.emit('security:event', event);
}

const DASHBOARD_DIR = path.resolve(import.meta.dirname, 'dashboard');
const MAX_WS_CLIENTS = 50;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// ---------------------------------------------------------------------------
// Dashboard file serving (with path traversal guard)
// ---------------------------------------------------------------------------

function serveDashboardFile(filePath: string, res: http.ServerResponse): void {
  const absPath = path.join(DASHBOARD_DIR, filePath);

  // L2: Prevent path traversal — resolved path must stay inside DASHBOARD_DIR
  if (!absPath.startsWith(DASHBOARD_DIR + path.sep) && absPath !== DASHBOARD_DIR) {
    emitSecurityEvent(2, 'PATH TRAVERSAL', 'critical', 'Blocked path traversal attempt', filePath);
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  const ext = path.extname(absPath);
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

  try {
    // Read as bytes so binary files (icon.png) are not mangled by a text decode.
    const content = fs.readFileSync(absPath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      // A cached page outlives the session after a restart and renders blank; always revalidate.
      'Cache-Control': 'no-store',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export interface ServerOptions {
  /** Clock for session expiry; tests move it. */
  readonly now?: () => number;
}

export interface SwitchyardServer {
  start(): void;
  stop(): void;
  readonly accessCode: string;
  readonly hookToken: string;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const RETENTION_SWEEP_MS = 60 * 60 * 1000;

/** `bindLocal` false is the opt-in `--lan` mode: the server also answers on this machine's network addresses. */
export function createServer(port: number = 4280, bindLocal: boolean = true, options: ServerOptions = {}): SwitchyardServer {
  const now = options.now ?? Date.now;
  const lan = !bindLocal;
  // C2 fix: Use CSPRNG for access code
  const accessCode = String(crypto.randomInt(100_000, 1_000_000));
  // H1/H2 fix: Shared secret for hook endpoints
  const hookToken = crypto.randomBytes(24).toString('hex');
  /** Session token -> expiry time. Tokens are made here, never taken from the client. */
  const validSessions = new Map<string, number>();

  // C1 fix: Rate limiting on auth endpoint (per IP)
  const authAttempts = new Map<string, { count: number; resetAt: number }>();
  const AUTH_MAX_ATTEMPTS = 5;
  const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

  // Only wrong codes count toward the lockout; a correct code clears the IP's count.
  function isAuthLockedOut(ip: string): boolean {
    const entry = authAttempts.get(ip);
    if (!entry) return false;
    if (Date.now() > entry.resetAt) {
      authAttempts.delete(ip);
      return false;
    }
    return entry.count >= AUTH_MAX_ATTEMPTS;
  }

  function recordAuthFailure(ip: string): void {
    const now = Date.now();
    const entry = authAttempts.get(ip);
    const fresh = !entry || now > entry.resetAt;
    authAttempts.set(ip, fresh ? { count: 1, resetAt: now + AUTH_WINDOW_MS } : { ...entry, count: entry.count + 1 });
  }

  // L1 fix: Cap concurrent sessions
  const MAX_SESSIONS = 20;

  function parseCookies(req: http.IncomingMessage): Record<string, string> {
    const cookies: Record<string, string> = {};
    const header = req.headers.cookie || '';
    header.split(';').forEach((c) => {
      const [key, ...rest] = c.trim().split('=');
      if (key) cookies[key] = rest.join('=');
    });
    return cookies;
  }

  function isAuthenticated(req: http.IncomingMessage): boolean {
    const cookies = parseCookies(req);
    const token = cookies['switchyard_session'];
    if (!token) return false;
    const expiresAt = validSessions.get(token);
    if (expiresAt === undefined) return false;
    if (now() >= expiresAt) {
      validSessions.delete(token);
      return false;
    }
    return true;
  }

  // H1/H2 fix: Validate hook token (constant-time comparison via crypto)
  function isHookAuthenticated(req: http.IncomingMessage): boolean {
    // The token belongs to the hook and the Mac app. A browser never has a reason to send it.
    if (isBrowserRequest(req)) return false;
    const auth = req.headers.authorization ?? '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (provided.length !== hookToken.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(hookToken));
    } catch {
      return false;
    }
  }

  function setSessionCookie(res: http.ServerResponse, token: string): void {
    res.setHeader('Set-Cookie', `switchyard_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`);
  }

  // H3 fix: Security headers on every response
  function setSecurityHeaders(res: http.ServerResponse, host: string): void {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    // Everything the dashboard loads comes from this server. No inline script, no other host.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      `font-src 'self'; connect-src 'self' ws://${host}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    );
  }

  function refuse(res: http.ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' });
    res.end(message);
  }

  const contexts = createContextsService();

  const server = http.createServer(async (req, res) => {
    // Refuse other host names (DNS rebinding) and other origins before anything else runs.
    const source = checkRequestSource(req, port, lan);
    if (!source.ok) {
      emitSecurityEvent(1, 'ORIGIN', 'critical', `Blocked request (${source.reason} check)`, null);
      refuse(res, 403, 'Forbidden');
      return;
    }
    // H3: Apply security headers to all responses
    setSecurityHeaders(res, source.host);

    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    // Same-origin pages never preflight, and there is no cross-origin access to grant.
    if (method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'GET, POST, PUT, PATCH, DELETE' });
      res.end();
      return;
    }
    if (!hasJsonBodyOrNone(req)) {
      sendJson(res, 415, { error: 'Request bodies must be application/json' });
      return;
    }

    try {
      // ── Auth routes (no auth required) ──
      if (method === 'POST' && url === '/api/auth') {
        const clientIp = req.socket.remoteAddress ?? 'unknown';

        // C1 fix: Rate limit auth attempts
        if (isAuthLockedOut(clientIp)) {
          emitSecurityEvent(1, 'AUTH', 'critical', 'Auth rate limit exceeded — IP locked out', clientIp);
          sendJson(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
          return;
        }

        let body: Record<string, unknown>;
        try {
          body = await parseBody(req);
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        const unknown = unknownFields(body, ['code']);
        if (unknown) {
          sendJson(res, 400, { error: unknown });
          return;
        }
        const code = typeof body.code === 'string' ? body.code.trim() : '';

        // Constant-time comparison for access code. Byte lengths, not string lengths: "é" is one char but two bytes.
        const given = Buffer.from(code);
        const expected = Buffer.from(accessCode);
        const codeMatch = given.length === expected.length && crypto.timingSafeEqual(given, expected);

        if (codeMatch) {
          const token = crypto.randomBytes(32).toString('hex');
          // L1 fix: Evict oldest session if at capacity
          if (validSessions.size >= MAX_SESSIONS) {
            const oldest = validSessions.keys().next().value;
            if (oldest) validSessions.delete(oldest);
          }
          validSessions.set(token, now() + SESSION_TTL_MS);
          authAttempts.delete(clientIp);
          setSessionCookie(res, token);
          sendJson(res, 200, { ok: true });
        } else {
          recordAuthFailure(clientIp);
          emitSecurityEvent(1, 'AUTH', 'warn', 'Invalid access code attempt', clientIp);
          sendJson(res, 401, { error: 'Invalid access code' });
        }
        return;
      }

      // ── Hook endpoints: authenticated by hook token, not cookies ──
      if (url.startsWith('/api/events') && method === 'POST') {
        if (!isHookAuthenticated(req)) {
          emitSecurityEvent(2, 'HOOK AUTH', 'critical', 'Rejected unauthenticated event POST', req.socket.remoteAddress ?? 'unknown');
          sendJson(res, 401, { error: 'Invalid hook token' });
          return;
        }
        await handleEvents(req, res);
        return;
      }
      // Hook fetches pending instructions via GET during PreToolUse
      if (url.startsWith('/api/instructions/') && method === 'GET') {
        if (!isHookAuthenticated(req)) {
          emitSecurityEvent(2, 'HOOK AUTH', 'warn', 'Rejected unauthenticated instruction poll', req.socket.remoteAddress ?? 'unknown');
          sendJson(res, 401, { error: 'Invalid hook token' });
          return;
        }
        await handleInstructions(req, res);
        return;
      }

      // ── Contexts API: session cookie, or hook bearer token from loopback (checked inside) ──
      if (isContextsUrl(url)) {
        await handleContexts(req, res, contexts, {
          fromBrowser: isBrowserRequest(req),
          cookieOk: isAuthenticated(req),
          bearerOk: isHookAuthenticated(req),
          accessCode,
        });
        return;
      }

      // ── Public routes (no auth required) ──
      const urlPath = url.split('?')[0]; // Strip query string for matching

      // Login page
      if (method === 'GET' && (urlPath === '/login' || urlPath === '/login.html')) {
        serveDashboardFile('login.html', res);
        return;
      }
      // Static assets needed by login page
      if (method === 'GET' && (urlPath === '/styles.css' || urlPath === '/login.js')) {
        serveDashboardFile(urlPath.slice(1), res);
        return;
      }
      // App icon: favicon and login-page logo, so it must load before sign-in. Fixed names only.
      if (method === 'GET' && (urlPath === '/icon.svg' || urlPath === '/icon.png')) {
        serveDashboardFile(urlPath.slice(1), res);
        return;
      }
      // Favicon (no auth, return 204 if missing)
      if (method === 'GET' && urlPath === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      // ── Auth check for everything else ──
      if (!isAuthenticated(req)) {
        if (method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
          // Redirect to login
          res.writeHead(302, { 'Location': '/login' });
          res.end();
          return;
        }
        // API calls without auth
        sendJson(res, 401, { error: 'Unauthorized — access code required' });
        return;
      }

      // ── Dashboard routes (authenticated) ──
      if (method === 'GET' && (url === '/' || url === '/index.html')) {
        serveDashboardFile('index.html', res);
        return;
      }
      if (method === 'GET' && url === '/core.js') {
        serveDashboardFile('core.js', res);
        return;
      }
      if (method === 'GET' && url === '/activity.js') {
        serveDashboardFile('activity.js', res);
        return;
      }
      if (method === 'GET' && url === '/usage.js') {
        serveDashboardFile('usage.js', res);
        return;
      }
      if (method === 'GET' && url === '/app.js') {
        serveDashboardFile('app.js', res);
        return;
      }
      if (method === 'GET' && url === '/picker.js') {
        serveDashboardFile('picker.js', res);
        return;
      }
      if (method === 'GET' && url === '/security.js') {
        serveDashboardFile('security.js', res);
        return;
      }
      if (method === 'GET' && url === '/contexts-logic.js') {
        serveDashboardFile('contexts-logic.js', res);
        return;
      }
      if (method === 'GET' && url === '/contexts.js') {
        serveDashboardFile('contexts.js', res);
        return;
      }

      // API routes (authenticated)
      if (url.startsWith('/api/events')) {
        if (method === 'GET') {
          await handleEvents(req, res);
          return;
        }
      }

      if (url.startsWith('/api/agents')) {
        if (method === 'GET' || method === 'PATCH' || method === 'DELETE') {
          await handleAgents(req, res);
          return;
        }
      }

      if (url.startsWith('/api/missions')) {
        if (method === 'GET' || method === 'POST' || method === 'PATCH' || method === 'DELETE') {
          await handleMissions(req, res);
          return;
        }
      }

      if (url.startsWith('/api/instructions')) {
        if (method === 'GET' || method === 'POST') {
          await handleInstructions(req, res);
          return;
        }
      }

      if (url.startsWith('/api/usage')) {
        if (method === 'GET') {
          await handleUsage(req, res);
          return;
        }
      }

      if (url.startsWith('/api/tokens')) {
        if (method === 'GET') {
          await handleTokens(req, res);
          return;
        }
      }

      if (method === 'GET' && url === '/api/dashboard') {
        const stats = getDashboardStats();
        sendJson(res, 200, stats);
        return;
      }

      // 404 fallback
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err) {
      // A broken percent-escape in the path is the client's mistake.
      if (err instanceof URIError) {
        sendJson(res, 400, { error: 'Malformed URL' });
        return;
      }
      // M1: Log the error server-side, return a generic message. The path is logged without its query string.
      console.error(`[server] Error handling ${method} ${url.split('?')[0]}:`, err);
      sendJson(res, 500, { error: 'Internal Server Error' });
    }
  });

  // Handle port-in-use before WSS attaches (WSS re-emits server errors)
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ERROR: Port ${port} is already in use.`);
      console.error(`  Try: kill $(lsof -ti :${port}) or use --port <number>\n`);
      process.exit(1);
    }
    throw err;
  });

  // WebSocket server with origin validation and connection limit
  const wss = attachWebSocketServer(server, {
    maxClients: MAX_WS_CLIENTS,
    verify: (req) => {
      const source = checkRequestSource(req, port, lan);
      if (!source.ok) {
        emitSecurityEvent(3, 'WS ORIGIN', 'critical', `Rejected WebSocket (${source.reason} check)`, null);
        return 403;
      }
      // Check auth cookie for WebSocket too
      if (!isAuthenticated(req)) {
        emitSecurityEvent(1, 'AUTH', 'warn', 'Rejected unauthenticated WebSocket', req.socket.remoteAddress ?? 'unknown');
        return 401;
      }
      return true;
    },
    onConnection: (ws) => onWebSocketConnection(ws),
  });

  function onWebSocketConnection(ws: WsClient): void {
    // Send current state on connect
    const agents = dbGetAgents();
    const recentEvents = dbGetEvents(50);
    const missions = dbGetMissions();

    ws.send(JSON.stringify({ type: 'agents', data: agents }));
    ws.send(JSON.stringify({ type: 'events', data: recentEvents }));
    ws.send(JSON.stringify({ type: 'missions', data: missions }));
    contexts.view().then(
      (view) => {
        if (ws.isOpen) ws.send(JSON.stringify({ type: 'contexts', data: view }));
      },
      (err) => console.error('[ws] Failed to send contexts:', err),
    );
    const unsubscribeContexts = contexts.subscribe((view) => {
      if (ws.isOpen) ws.send(JSON.stringify({ type: 'contexts', data: view }));
    });

    // Forward event bus events to this WebSocket client
    const onAgentUpdate = (d: unknown) => {
      if (ws.isOpen) {
        ws.send(JSON.stringify({ type: 'agent:update', data: d }));
      }
    };
    const onEventNew = (d: unknown) => {
      if (ws.isOpen) {
        ws.send(JSON.stringify({ type: 'event:new', data: d }));
      }
    };
    const onMissionUpdate = (d: unknown) => {
      if (ws.isOpen) {
        ws.send(JSON.stringify({ type: 'mission:update', data: d }));
      }
    };
    const onInstructionNew = (d: unknown) => {
      if (ws.isOpen) {
        ws.send(JSON.stringify({ type: 'instruction:new', data: d }));
      }
    };
    const onInstructionDelivered = (d: unknown) => {
      if (ws.isOpen) {
        ws.send(JSON.stringify({ type: 'instruction:delivered', data: d }));
      }
    };
    const onSecurityEvent = (d: unknown) => {
      if (ws.isOpen) {
        ws.send(JSON.stringify({ type: 'security:event', data: d }));
      }
    };

    eventBus.on('agent:update', onAgentUpdate);
    eventBus.on('event:new', onEventNew);
    eventBus.on('mission:update', onMissionUpdate);
    eventBus.on('instruction:new', onInstructionNew);
    eventBus.on('instruction:delivered', onInstructionDelivered);
    eventBus.on('security:event', onSecurityEvent);

    ws.onClose(() => {
      unsubscribeContexts();
      eventBus.off('agent:update', onAgentUpdate);
      eventBus.off('event:new', onEventNew);
      eventBus.off('mission:update', onMissionUpdate);
      eventBus.off('instruction:new', onInstructionNew);
      eventBus.off('instruction:delivered', onInstructionDelivered);
      eventBus.off('security:event', onSecurityEvent);
    });
  }

  let retentionTimer: ReturnType<typeof setInterval> | null = null;

  return {
    start(): void {
      const host = bindLocal ? '127.0.0.1' : '0.0.0.0';
      server.listen(port, host, () => {
        agentTracker.start();
        contexts.start();
      });
      retentionTimer = setInterval(() => purgeExpiredData(), RETENTION_SWEEP_MS);
      retentionTimer.unref();
    },
    stop(): void {
      if (retentionTimer) clearInterval(retentionTimer);
      agentTracker.stop();
      contexts.stop();
      wss.close();
      server.close();
      server.closeAllConnections();
    },
    accessCode,
    hookToken,
  };
}
