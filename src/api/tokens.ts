import type { IncomingMessage, ServerResponse } from 'node:http';
import { scanSessions } from '../services/session-scanner.ts';
import { sendJson, parseQuery } from './utils.ts';

/** Ten years: anything longer is "all time" in practice (use 0). */
export const MAX_HOURS = 24 * 365 * 10;

/** `hours` query value: absent means 0 (all time); null when it is not a whole number in range. */
export function parseHours(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  if (!/^\d{1,6}$/.test(raw)) return null;
  const hours = Number(raw);
  return hours <= MAX_HOURS ? hours : null;
}

/**
 * Handle requests to /api/tokens
 *
 * GET /api/tokens — return real token usage from Claude Code JSONL logs
 */
export async function handleTokens(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  if (method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const hours = parseHours(parseQuery(url).hours);
  if (hours === null) {
    sendJson(res, 400, { error: `hours must be a whole number from 0 (all time) to ${MAX_HOURS}` });
    return;
  }

  const summary = await scanSessions(hours);
  sendJson(res, 200, summary);
}
