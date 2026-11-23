// Decides whether a request may be handled at all, before auth. A browser on another site, or a DNS name
// rebound to this machine, must not reach the API: the server answers only for its own host names, and only
// requests that come from its own pages or from non-browser clients (the hook, the Mac app, curl).

import type { IncomingMessage } from 'node:http';
import os from 'node:os';

export type GuardVerdict = { readonly ok: true; readonly host: string } | { readonly ok: false; readonly reason: string };

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];

/** Addresses of this machine's network interfaces, in Host-header form. Used only with `--lan`. */
function interfaceNames(): string[] {
  const names: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) names.push(net.family === 'IPv6' ? `[${net.address}]` : net.address);
  }
  return names;
}

export function allowedHosts(port: number, lan: boolean): ReadonlySet<string> {
  const names = lan ? [...LOOPBACK_NAMES, ...interfaceNames()] : LOOPBACK_NAMES;
  const hosts = names.map((name) => `${name}:${port}`.toLowerCase());
  // Browsers leave the default port out of the Host header.
  return new Set(port === 80 ? [...hosts, ...names.map((n) => n.toLowerCase())] : hosts);
}

function isPageNavigation(req: IncomingMessage): boolean {
  const path = (req.url ?? '/').split('?')[0];
  return req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && !path.startsWith('/api/');
}

export function checkRequestSource(req: IncomingMessage, port: number, lan: boolean): GuardVerdict {
  const host = (req.headers.host ?? '').toLowerCase();
  if (!allowedHosts(port, lan).has(host)) return { ok: false, reason: 'host' };

  const origin = req.headers.origin;
  if (origin !== undefined && origin.toLowerCase() !== `http://${host}`) return { ok: false, reason: 'origin' };

  // Browsers label every request. Following a link to the dashboard is fine (it carries no session);
  // anything else from another site, or from another port on this machine, is not.
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none' && !isPageNavigation(req)) {
    return { ok: false, reason: 'fetch-site' };
  }
  return { ok: true, host };
}

/** True when a browser made the request. The Mac app and the hook never send these headers. */
export function isBrowserRequest(req: IncomingMessage): boolean {
  return req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined;
}

/** A request body must be declared as JSON: an HTML form cannot do that, so it cannot post to the API. */
export function hasJsonBodyOrNone(req: IncomingMessage): boolean {
  const length = Number(req.headers['content-length'] ?? 0);
  const hasBody = length > 0 || req.headers['transfer-encoding'] !== undefined;
  if (!hasBody) return true;
  const type = req.headers['content-type'] ?? '';
  // The one binary upload: the Mac app's app icons (the route itself is app-only).
  if (req.method === 'PUT' && /^\/api\/contexts\/icons\/[^/?]+$/.test(req.url ?? '') && /^image\/png\s*(;|$)/i.test(type)) return true;
  return /^application\/json\s*(;|$)/i.test(type);
}
