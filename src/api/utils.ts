import type { IncomingMessage, ServerResponse } from 'node:http';
import { eventBus } from '../services/event-bus.ts';

const MAX_BODY_BYTES = 1_048_576; // 1 MB

/**
 * Collect request body chunks and parse as JSON.
 * Rejects if body exceeds MAX_BODY_BYTES or contains invalid JSON.
 */
export function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        eventBus.emit('security:event', {
          layer: 5,
          layerName: 'PAYLOAD SIZE',
          severity: 'warn' as const,
          message: 'Blocked oversized request body',
          detail: `${totalBytes} bytes (max ${MAX_BODY_BYTES})`,
          timestamp: new Date().toISOString(),
        });
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        const value: unknown = JSON.parse(raw);
        // Every endpoint takes a JSON object; arrays, strings and null are never valid bodies.
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          reject(new Error('Invalid JSON body'));
          return;
        }
        resolve(value as Record<string, unknown>);
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Names of fields the endpoint does not accept, as an error message; null when there are none. */
export function unknownFields(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  return extra.length > 0 ? `Unknown field(s): ${extra.join(', ').slice(0, 200)}` : null;
}

/**
 * Send a JSON response with the given status code.
 */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  // Use setHeader (appends) instead of writeHead options (replaces) to preserve
  // any previously set headers like Set-Cookie
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.writeHead(status);
  res.end(body);
}

// ---------------------------------------------------------------------------
// Field length limits
// ---------------------------------------------------------------------------

export const FIELD_LIMITS = {
  title: 500,
  description: 5_000,
  message: 10_000,
  result: 10_000,
  agentId: 500,
  name: 200,
} as const;

/**
 * Truncate a string field to the configured max length.
 * Returns the original value if within limits or if not a string.
 */
export function truncateField(value: unknown, field: keyof typeof FIELD_LIMITS): unknown {
  if (typeof value !== 'string') return value;
  const max = FIELD_LIMITS[field];
  if (value.length > max) {
    eventBus.emit('security:event', {
      layer: 6,
      layerName: 'FIELD LIMIT',
      severity: 'info' as const,
      message: `Truncated ${field} field`,
      detail: `${value.length} chars → ${max} max`,
      timestamp: new Date().toISOString(),
    });
    return value.slice(0, max);
  }
  return value;
}

/**
 * Extract an ID segment from a URL path after a given prefix.
 *
 * Example:
 *   extractId('/api/missions/abc123', '/api/missions/') => 'abc123'
 *   extractId('/api/missions/abc123/events', '/api/missions/') => 'abc123'
 *   extractId('/api/missions', '/api/missions/') => null
 */
export function extractId(url: string, prefix: string): string | null {
  if (!url.startsWith(prefix)) {
    return null;
  }
  const rest = url.slice(prefix.length);
  if (rest.length === 0) {
    return null;
  }
  // Take everything up to the next '/' or '?' or end of string
  const match = rest.match(/^([^/?]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Parse query parameters from a URL string.
 */
export function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx === -1) {
    return {};
  }
  const params: Record<string, string> = {};
  const searchParams = new URLSearchParams(url.slice(idx + 1));
  for (const [key, value] of searchParams) {
    params[key] = value;
  }
  return params;
}
