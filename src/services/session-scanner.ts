/**
 * Session Scanner — reads Claude Code's JSONL session logs for real token usage.
 *
 * Claude Code writes session transcripts to:
 *   ~/.claude/projects/{path-hash}/{session-id}.jsonl
 *
 * Each assistant message contains a `usage` block with actual token counts
 * and model info, enabling precise cost calculation instead of estimates.
 */

import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Model pricing (per million tokens) — matches Anthropic's published rates
// ---------------------------------------------------------------------------

interface ModelPricing {
  readonly input: number;
  readonly output: number;
  readonly cacheCreation: number;
  readonly cacheRead: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6':   { input: 15,  output: 75,  cacheCreation: 18.75, cacheRead: 1.5 },
  'claude-opus-4-5':   { input: 15,  output: 75,  cacheCreation: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4-6': { input: 3,   output: 15,  cacheCreation: 3.75,  cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3,   output: 15,  cacheCreation: 3.75,  cacheRead: 0.3 },
  'claude-sonnet-4-0': { input: 3,   output: 15,  cacheCreation: 3.75,  cacheRead: 0.3 },
  'claude-haiku-4-5':  { input: 0.8, output: 4,   cacheCreation: 1,     cacheRead: 0.08 },
  'claude-haiku-3-5':  { input: 0.8, output: 4,   cacheCreation: 1,     cacheRead: 0.08 },
};

// Default to Sonnet pricing for unknown models
const DEFAULT_PRICING: ModelPricing = { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3 };

function getPricing(model: string): ModelPricing {
  // Try exact match first
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  // Try fuzzy: check if any known key is contained in the model string
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.includes(key) || key.includes(model)) return pricing;
  }
  // Check by tier keywords
  if (model.includes('opus')) return MODEL_PRICING['claude-opus-4-6'];
  if (model.includes('haiku')) return MODEL_PRICING['claude-haiku-4-5'];
  return DEFAULT_PRICING;
}

function tokenCost(tokens: number, pricePerMillion: number): number {
  return (tokens / 1_000_000) * pricePerMillion;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionTokenUsage {
  readonly sessionId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly totalTokens: number;
  readonly cost: number;
  readonly messageCount: number;
  readonly firstTimestamp: string;
  readonly lastTimestamp: string;
  readonly contextWindowUsed: number;   // last known context usage (tokens)
  readonly contextWindowPercent: number; // 0-100
  readonly isActive: boolean;           // session PID is still running
}

interface DailyTokenUsage {
  readonly date: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly totalTokens: number;
  readonly cost: number;
  readonly messageCount: number;
  readonly sessions: number;
}

interface ModelUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cost: number;
  readonly messageCount: number;
}

interface TokenSummary {
  readonly sessions: readonly SessionTokenUsage[];
  readonly daily: readonly DailyTokenUsage[];
  readonly models: readonly ModelUsage[];
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheCreationTokens: number;
  readonly totalCacheReadTokens: number;
  readonly totalTokens: number;
  readonly totalCost: number;
  readonly totalMessages: number;
  readonly totalSessions: number;
  readonly activeSessions: number;
  readonly cacheHitRate: number;
}

// ---------------------------------------------------------------------------
// Incremental parsing — session logs are append-only, so each request reads only the new bytes
// ---------------------------------------------------------------------------

/** Running totals for one session file. Mutated only by the single read in flight for that file. */
interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  messageCount: number;
  cost: number;
  model: string;
  firstTimestamp: string;
  lastTimestamp: string;
  lastContextUsed: number;
}

interface FileState {
  readonly ino: number;
  readonly size: number;
  readonly mtime: number;
  /** Bytes consumed so far; a trailing half-written line is left for the next read. */
  readonly offset: number;
  readonly totals: Totals;
}

const fileStates = new Map<string, FileState>();
const readsInFlight = new Map<string, Promise<FileState | null>>();

const READ_CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

function emptyTotals(): Totals {
  return {
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, messageCount: 0, cost: 0,
    model: 'unknown', firstTimestamp: '', lastTimestamp: '', lastContextUsed: 0,
  };
}

/** Parses one JSONL line; null when it is not valid JSON. */
function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Adds one log entry's usage to `totals`; entries without usage are ignored. */
function addEntry(totals: Totals, entry: Record<string, unknown>): void {
  if (entry.type !== 'assistant') return;
  const msg = entry.message as Record<string, unknown> | undefined;
  const usage = msg?.usage as Record<string, unknown> | undefined;
  if (!msg || !usage) return;

  const msgModel = (msg.model as string) || 'unknown';
  if (totals.model === 'unknown' && msgModel !== 'unknown') totals.model = msgModel;

  const ts = entry.timestamp as string;
  if (ts) {
    if (!totals.firstTimestamp || ts < totals.firstTimestamp) totals.firstTimestamp = ts;
    if (!totals.lastTimestamp || ts > totals.lastTimestamp) totals.lastTimestamp = ts;
  }

  const inTok = (usage.input_tokens as number) || 0;
  const outTok = (usage.output_tokens as number) || 0;
  const cacheTok = (usage.cache_creation_input_tokens as number) || 0;
  const cacheReadTok = (usage.cache_read_input_tokens as number) || 0;
  totals.inputTokens += inTok;
  totals.outputTokens += outTok;
  totals.cacheCreationTokens += cacheTok;
  totals.cacheReadTokens += cacheReadTok;
  totals.messageCount++;

  // Track last known context window usage (cache_read approximates context size)
  const thisContext = inTok + cacheTok + cacheReadTok;
  if (thisContext > 0) totals.lastContextUsed = thisContext;

  const pricing = getPricing(msgModel);
  totals.cost += tokenCost(inTok, pricing.input)
    + tokenCost(outTok, pricing.output)
    + tokenCost(cacheTok, pricing.cacheCreation)
    + tokenCost(cacheReadTok, pricing.cacheRead);
}

/**
 * Streams bytes [from, to) of the file into `totals` in chunks, so no file is too big to read.
 * Returns the offset just past the last line consumed.
 */
async function readLines(filePath: string, from: number, to: number, totals: Totals): Promise<number> {
  const handle = await open(filePath, 'r');
  try {
    let position = from;
    let carry = Buffer.alloc(0);
    while (position < to) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, to - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let lineStart = 0;
      for (let end = data.indexOf(NEWLINE); end !== -1; end = data.indexOf(NEWLINE, lineStart)) {
        if (end - lineStart >= 10) {
          const entry = parseLine(data.toString('utf8', lineStart, end));
          if (entry) addEntry(totals, entry);
        }
        lineStart = end + 1;
      }
      carry = Buffer.from(data.subarray(lineStart));
    }
    // A last line with no newline yet counts only once it is complete JSON; otherwise it is re-read next time.
    const last = carry.length > 0 ? parseLine(carry.toString('utf8')) : null;
    if (last) {
      addEntry(totals, last);
      return position;
    }
    return position - carry.length;
  } finally {
    await handle.close();
  }
}

async function refreshFile(filePath: string): Promise<FileState | null> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return null;
  }
  const previous = fileStates.get(filePath);
  if (previous && previous.ino === info.ino && previous.size === info.size && previous.mtime === info.mtimeMs) {
    return previous;
  }
  // Grown in place: read only the new bytes. Anything else (new, shrunk, replaced) starts over.
  const appended = previous !== undefined && previous.ino === info.ino && info.size > previous.size;
  const totals = appended ? { ...previous.totals } : emptyTotals();
  let offset: number;
  try {
    offset = await readLines(filePath, appended ? previous.offset : 0, info.size, totals);
  } catch (err) {
    console.warn(`Switchyard: could not read session log ${filePath}: ${(err as Error).message}`);
    return previous ?? null;
  }
  const next: FileState = { ino: info.ino, size: info.size, mtime: info.mtimeMs, offset, totals };
  fileStates.set(filePath, next);
  return next;
}

/** One read per file at a time, so concurrent requests never double-count appended lines. */
function refreshFileOnce(filePath: string): Promise<FileState | null> {
  const inFlight = readsInFlight.get(filePath);
  if (inFlight) return inFlight;
  const read = refreshFile(filePath).finally(() => readsInFlight.delete(filePath));
  readsInFlight.set(filePath, read);
  return read;
}

// Context window size by model (tokens)
const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-6': 200000,
  'claude-opus-4-5': 200000,
  'claude-sonnet-4-6': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-sonnet-4-0': 200000,
  'claude-haiku-4-5': 200000,
  'claude-haiku-3-5': 200000,
};

function toUsage(sessionId: string, t: Totals): SessionTokenUsage {
  const contextWindow = CONTEXT_WINDOWS[t.model] || 200000;
  return {
    sessionId,
    model: t.model,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheCreationTokens: t.cacheCreationTokens,
    cacheReadTokens: t.cacheReadTokens,
    totalTokens: t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens,
    cost: parseFloat(t.cost.toFixed(6)),
    messageCount: t.messageCount,
    firstTimestamp: t.firstTimestamp,
    lastTimestamp: t.lastTimestamp,
    contextWindowUsed: t.lastContextUsed,
    contextWindowPercent: Math.min(100, parseFloat((t.lastContextUsed / contextWindow * 100).toFixed(1))),
    isActive: false, // Set by scanner after checking PIDs
  };
}

async function parseSessionFile(filePath: string, sessionId: string): Promise<SessionTokenUsage | null> {
  const state = await refreshFileOnce(filePath);
  if (!state || state.totals.messageCount === 0) return null;
  return toUsage(sessionId, state.totals);
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

// SWITCHYARD_CLAUDE_HOME lets tests (and unusual setups) point at a different Claude config dir.
const CLAUDE_HOME = process.env.SWITCHYARD_CLAUDE_HOME || join(homedir(), '.claude');
const CLAUDE_DIR = join(CLAUDE_HOME, 'projects');
const SESSIONS_DIR = join(CLAUDE_HOME, 'sessions');

/** Directory entries, or none when the folder is missing or not a folder. */
async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Get active session IDs by reading ~/.claude/sessions/*.json
 * and checking if the PID is still running.
 */
async function getActiveSessionIds(): Promise<Set<string>> {
  const active = new Set<string>();
  const files = (await listDir(SESSIONS_DIR)).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const meta = JSON.parse(await readFile(join(SESSIONS_DIR, file), 'utf-8')) as { pid?: number; sessionId?: string };
      if (meta.pid && meta.sessionId) {
        try {
          process.kill(meta.pid, 0); // Signal 0 = test existence
          active.add(meta.sessionId);
        } catch {
          // PID not running — session is dead
        }
      }
    } catch {
      continue;
    }
  }
  return active;
}

interface SessionFile {
  readonly sessionId: string;
  readonly filePath: string;
}

/** Every session log with its session id, optionally limited to one project folder. */
async function listSessionFiles(projectFilter?: string): Promise<SessionFile[]> {
  let projectDirs = await listDir(CLAUDE_DIR);
  if (projectFilter) projectDirs = projectDirs.filter((d) => d === projectFilter);
  const found: SessionFile[] = [];
  for (const projectDir of projectDirs) {
    const projectPath = join(CLAUDE_DIR, projectDir);
    for (const file of await listDir(projectPath)) {
      if (!file.endsWith('.jsonl')) continue;
      found.push({ sessionId: file.slice(0, -'.jsonl'.length), filePath: join(projectPath, file) });
    }
  }
  return found;
}

/**
 * Scan all Claude Code JSONL session logs and compute token usage.
 * @param hoursBack - 0 means all time
 * @param projectFilter - optional project path hash to scope results
 */
export async function scanSessions(hoursBack = 0, projectFilter?: string): Promise<TokenSummary> {
  const sinceMs = Date.now() - hoursBack * 60 * 60 * 1000;
  const since = hoursBack <= 0 || !(sinceMs > 0)
    ? '1970-01-01T00:00:00.000Z'
    : new Date(sinceMs).toISOString();
  const sinceDate = since.slice(0, 10);

  const activeIds = await getActiveSessionIds();
  const files = await listSessionFiles(projectFilter);
  if (!projectFilter) {
    // Forget logs that were deleted.
    const present = new Set(files.map((f) => f.filePath));
    for (const cached of fileStates.keys()) if (!present.has(cached)) fileStates.delete(cached);
  }

  const sessions: SessionTokenUsage[] = [];
  for (const { sessionId, filePath } of files) {
    const usage = await parseSessionFile(filePath, sessionId);
    if (!usage || usage.lastTimestamp < since) continue;
    sessions.push(activeIds.has(sessionId) ? { ...usage, isActive: true } : usage);
  }

  // Sort by most recent first
  sessions.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));

  // Aggregate daily
  const dailyMap = new Map<string, {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    cost: number;
    messageCount: number;
    sessionIds: Set<string>;
  }>();

  for (const s of sessions) {
    // Use the date of the last activity for bucketing
    const date = s.lastTimestamp.slice(0, 10);
    if (date < sinceDate) continue;

    const existing = dailyMap.get(date);
    if (existing) {
      existing.inputTokens += s.inputTokens;
      existing.outputTokens += s.outputTokens;
      existing.cacheCreationTokens += s.cacheCreationTokens;
      existing.cacheReadTokens += s.cacheReadTokens;
      existing.cost += s.cost;
      existing.messageCount += s.messageCount;
      existing.sessionIds.add(s.sessionId);
    } else {
      dailyMap.set(date, {
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheCreationTokens: s.cacheCreationTokens,
        cacheReadTokens: s.cacheReadTokens,
        cost: s.cost,
        messageCount: s.messageCount,
        sessionIds: new Set([s.sessionId]),
      });
    }
  }

  const daily: DailyTokenUsage[] = Array.from(dailyMap.entries())
    .map(([date, d]) => ({
      date,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheCreationTokens: d.cacheCreationTokens,
      cacheReadTokens: d.cacheReadTokens,
      totalTokens: d.inputTokens + d.outputTokens + d.cacheCreationTokens + d.cacheReadTokens,
      cost: parseFloat(d.cost.toFixed(6)),
      messageCount: d.messageCount,
      sessions: d.sessionIds.size,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Aggregate by model
  const modelMap = new Map<string, {
    inputTokens: number;
    outputTokens: number;
    cost: number;
    messageCount: number;
  }>();

  for (const s of sessions) {
    const existing = modelMap.get(s.model);
    if (existing) {
      existing.inputTokens += s.inputTokens;
      existing.outputTokens += s.outputTokens;
      existing.cost += s.cost;
      existing.messageCount += s.messageCount;
    } else {
      modelMap.set(s.model, {
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cost: s.cost,
        messageCount: s.messageCount,
      });
    }
  }

  const models: ModelUsage[] = Array.from(modelMap.entries())
    .map(([model, m]) => ({
      model,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      totalTokens: m.inputTokens + m.outputTokens,
      cost: parseFloat(m.cost.toFixed(6)),
      messageCount: m.messageCount,
    }))
    .sort((a, b) => b.cost - a.cost);

  // Totals
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCost = 0;
  let totalMessages = 0;

  for (const s of sessions) {
    totalInputTokens += s.inputTokens;
    totalOutputTokens += s.outputTokens;
    totalCacheCreationTokens += s.cacheCreationTokens;
    totalCacheReadTokens += s.cacheReadTokens;
    totalCost += s.cost;
    totalMessages += s.messageCount;
  }

  const totalBillableInput = totalInputTokens + totalCacheCreationTokens + totalCacheReadTokens;
  const cacheHitRate = totalBillableInput > 0
    ? parseFloat((totalCacheReadTokens / totalBillableInput * 100).toFixed(1))
    : 0;

  return {
    sessions: sessions.slice(0, 20), // Top 20 most recent
    daily,
    models,
    totalInputTokens,
    totalOutputTokens,
    totalCacheCreationTokens,
    totalCacheReadTokens,
    totalTokens: totalInputTokens + totalOutputTokens + totalCacheCreationTokens + totalCacheReadTokens,
    totalCost: parseFloat(totalCost.toFixed(6)),
    totalMessages,
    totalSessions: sessions.length,
    activeSessions: sessions.filter((s) => s.isActive).length,
    cacheHitRate,
  };
}
