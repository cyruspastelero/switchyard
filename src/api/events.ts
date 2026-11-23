import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { insertEvent, getEvents, getMissions, updateMission } from '../db.ts';
import { agentTracker } from '../services/agent-tracker.ts';
import { createMission as engineCreateMission, MissionEngineError } from '../services/mission-engine.ts';
import { eventBus } from '../services/event-bus.ts';
import { parseBody, sendJson, parseQuery } from './utils.ts';
import { minimizeToolInput, minimizeToolOutput } from '../services/event-privacy.ts';

// Track which agents already have auto-created missions (avoid duplicates per session)
const agentMissionCreated = new Set<string>();

/**
 * Auto-create a mission from agent activity.
 * - SubagentStart: uses the description field (if it looks like a real task)
 * - Stop: marks the agent's mission as completed
 */

/** Returns true if text looks like a command, path, URL, or other junk — not a mission title. */
function looksLikeJunk(text: string): boolean {
  const t = text.toLowerCase();
  // Starts with a shell command
  if (/^(curl|ls|cat|rm|cd|cp|mv|git|npm|npx|node|python|pip|docker|ssh|wget|grep|find|mkdir|chmod|kill|lsof|echo|sed|awk)\s/.test(t)) return true;
  // Contains path separators, pipes, redirects
  if (t.includes('|') || t.includes('>') || t.includes('2>/dev/null')) return true;
  // Starts with a path
  if (t.startsWith('/') || t.startsWith('~/') || t.startsWith('./')) return true;
  // Contains URLs
  if (t.includes('http://') || t.includes('https://')) return true;
  // Contains file extensions suggesting it's a file path
  if (/\.(ts|js|json|md|css|html|py|go|rs|sh|yml|yaml|toml)\b/.test(t) && t.includes('/')) return true;
  // Looks like "project — command" pattern
  if (/\s—\s/.test(text) && looksLikeJunk(text.split('—')[1]?.trim() || '')) return true;
  return false;
}

function autoMission(
  compositeId: string,
  eventType: string,
  toolName: string | null,
  toolInput: unknown,
  cwd: string | null,
): void {
  try {
    // On Stop: complete any active mission for this agent
    const eventLower = eventType.toLowerCase();
    if (eventLower === 'stop') {
      const missions = getMissions();
      for (const m of missions) {
        if (m.assigned_agent_id === compositeId && m.status === 'active') {
          updateMission(m.id, { status: 'completed', completed_at: new Date().toISOString() });
          eventBus.emit('mission:update', { ...m, status: 'completed', completed_at: new Date().toISOString() });
        }
      }
      agentMissionCreated.delete(compositeId);
      return;
    }

    // Don't create duplicate missions for the same agent
    if (agentMissionCreated.has(compositeId)) return;

    // Also check DB — handles server restarts where in-memory set is empty
    const existingMissions = getMissions();

    // Skip if this exact agent already has an active mission
    const hasActiveMission = existingMissions.some(
      (m) => m.assigned_agent_id === compositeId && (m.status === 'active' || m.status === 'queued')
    );
    if (hasActiveMission) {
      agentMissionCreated.add(compositeId);
      return;
    }

    let title: string | null = null;

    // SubagentStart: use description
    // Only create missions from meaningful sources:
    // 1. SubagentStart — has a human-written description
    // 2. Agent tool — spawning a subagent with a description
    // Main agent tool calls (Read, Bash, etc.) are too low-level to be missions.

    if (eventLower === 'subagent_start' || eventLower === 'subagentstart' || toolName === 'Agent') {
      let input: Record<string, unknown> = {};
      if (typeof toolInput === 'string') {
        try { input = JSON.parse(toolInput) as Record<string, unknown>; } catch {}
      } else if (toolInput && typeof toolInput === 'object') {
        input = toolInput as Record<string, unknown>;
      }
      // Extract candidate title from description or prompt
      var candidate = '';
      if (typeof input.description === 'string' && input.description.length > 0) {
        candidate = input.description.trim();
      } else if (typeof input.prompt === 'string' && input.prompt.length > 0) {
        candidate = input.prompt.trim();
      }

      // Filter out titles that look like commands, paths, or junk
      if (candidate.length >= 10 && !looksLikeJunk(candidate)) {
        title = candidate.length > 80 ? candidate.slice(0, 77) + '...' : candidate;
      }
    }

    // Main agent: create mission from project folder name
    // This gives every session a mission without noisy tool-level details
    if (!title && cwd) {
      const project = cwd.split('/').filter(Boolean).pop();
      if (project && project.length >= 2) {
        title = project;
      }
    }

    if (!title) return;

    // Cap title length
    if (title.length > 100) title = title.slice(0, 97) + '...';

    // Deduplicate by title — don't create if same title exists in any status
    const titleExists = existingMissions.some(
      (m) => m.title === title
    );
    if (titleExists) {
      agentMissionCreated.add(compositeId);
      return;
    }

    agentMissionCreated.add(compositeId);

    const mission = engineCreateMission({
      id: crypto.randomUUID(),
      title,
      description: null,
      priority: 0,
    });

    // Assign the agent and mark active
    updateMission(mission.id, {
      assigned_agent_id: compositeId,
      status: 'active',
      started_at: new Date().toISOString(),
    });

    eventBus.emit('mission:update', {
      ...mission,
      assigned_agent_id: compositeId,
      status: 'active',
      started_at: new Date().toISOString(),
    });
  } catch (err) {
    // Never let auto-mission creation break event processing
    if (!(err instanceof MissionEngineError)) {
      console.error('[auto-mission] Error:', err);
    }
  }
}

// --- Request DTO ------------------------------------------------------------

interface HookEvent {
  readonly session_id: string;
  readonly agent_id: string;
  readonly event_type: string;
  readonly tool_name: string | null;
  readonly tool_input: unknown;
  readonly tool_output: unknown;
  readonly cwd: string | null;
  readonly model: string | null;
}

type ParsedEvent = { readonly ok: true; readonly value: HookEvent } | { readonly ok: false; readonly error: string };

const EVENT_FIELDS = ['session_id', 'agent_id', 'event_type', 'tool_name', 'tool_input', 'tool_output', 'cwd', 'model'];
const ID_MAX = 200;
const PATH_MAX = 4_096;

/** A string within `max`, or null when absent. `undefined` in the result means the value is invalid. */
function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function parseEvent(body: unknown): ParsedEvent {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'Body must be an object' };
  const o = body as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !EVENT_FIELDS.includes(k));
  if (extra.length > 0) return { ok: false, error: `Unknown field(s): ${extra.join(', ').slice(0, 200)}` };
  if (!o.session_id || !o.event_type) return { ok: false, error: 'Missing required fields: session_id, event_type' };

  const text = {
    session_id: optionalText(o.session_id, ID_MAX),
    agent_id: o.agent_id === undefined ? 'main' : optionalText(o.agent_id, ID_MAX),
    event_type: optionalText(o.event_type, 100),
    tool_name: optionalText(o.tool_name, ID_MAX),
    cwd: optionalText(o.cwd, PATH_MAX),
    model: optionalText(o.model, ID_MAX),
  };
  const invalid = Object.entries(text).filter(([, v]) => v === undefined).map(([k]) => k);
  if (invalid.length > 0 || text.agent_id === null) {
    return { ok: false, error: `Invalid field(s): ${(invalid.length > 0 ? invalid : ['agent_id']).join(', ')}` };
  }
  return {
    ok: true,
    value: {
      session_id: text.session_id as string,
      agent_id: text.agent_id as string,
      event_type: text.event_type as string,
      tool_name: text.tool_name ?? null,
      tool_input: o.tool_input ?? null,
      tool_output: o.tool_output ?? null,
      cwd: text.cwd ?? null,
      model: text.model ?? null,
    },
  };
}

/**
 * Handle requests to /api/events
 *
 * POST /api/events — ingest a hook event
 * GET  /api/events — query stored events
 */
export async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  if (method === 'POST') {
    await handlePostEvent(req, res);
    return;
  }

  if (method === 'GET') {
    handleGetEvents(url, res);
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
}

async function handlePostEvent(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await parseBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const parsed = parseEvent(body);
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }
  const { session_id, agent_id, event_type, tool_name, tool_input, cwd, model } = parsed.value;

  // Composite key: session_id:agent_id
  const compositeId = `${session_id}:${agent_id}`;
  const now = new Date().toISOString();

  // Store a redacted summary of the tool call, never the raw input or output.
  const inserted = insertEvent({
    agent_id: compositeId,
    session_id,
    event_type,
    tool_name,
    tool_input: minimizeToolInput(tool_input),
    tool_output: minimizeToolOutput(parsed.value.tool_output),
    mission_id: null,
    timestamp: now,
  });

  // Agent tracker is the single owner of agent records — handles upsert,
  // name derivation, status lifecycle, and broadcast.
  agentTracker.trackEvent(inserted, { cwd, model });

  // Broadcast to WebSocket clients via event bus
  eventBus.emit('event:new', inserted);

  // Auto-create mission from agent activity
  autoMission(compositeId, event_type, tool_name, tool_input, cwd);

  sendJson(res, 201, { id: inserted.id, agent_id: compositeId });
}

function handleGetEvents(url: string, res: ServerResponse): void {
  const query = parseQuery(url);
  const limit = Math.min(Math.max(parseInt(query.limit ?? '100', 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(query.offset ?? '0', 10) || 0, 0);

  // Note: getEvents in db.ts accepts (limit, offset) — agent_id filtering
  // can be added later via a dedicated query if needed.
  const events = getEvents(limit, offset);
  sendJson(res, 200, events);
}
