// Agent status and "last action" derived from the agent's latest hook event.

import type { AgentStatus } from './types.ts';
import type { LatestEvent } from './store.ts';

const WORKING_WINDOW_MS = 2 * 60_000;
const ASKING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog']);

const text = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase() : '');

/**
 * Whether a Notification asks the owner for something. Claude Code also sends one as a reminder a minute
 * after a turn ends ("Claude is waiting for your input"); that is a finished agent, not a blocked one.
 * The type decides when the hook stored one, then the message, then what happened just before:
 * a notification straight after a Stop is the reminder, one in the middle of a turn is a prompt.
 */
function notificationAsks(latest: LatestEvent, before: string | null | undefined): boolean {
  const input = parseInput(latest.tool_input);
  const kind = text(input.notification_type);
  if (kind) return ASKING_NOTIFICATIONS.has(kind);
  const message = text(input.message);
  if (message.includes('waiting for your input')) return false;
  if (message.includes('permission') || message.includes('approv')) return true;
  return typeof before === 'string' && before.toLowerCase() !== 'stop';
}

type Standing = 'asks' | 'finished' | 'active';

function standing(latest: LatestEvent, before: string | null | undefined): Standing {
  const type = latest.event_type.toLowerCase();
  if (type === 'permissionrequest') return 'asks';
  if (type === 'notification') return notificationAsks(latest, before) ? 'asks' : 'finished';
  return type === 'stop' ? 'finished' : 'active';
}

/**
 * waiting: the agent asked for permission or an answer. working: activity in the last 2 minutes.
 * `before` is the type of the agent's latest event that is not a Notification.
 */
export function deriveAgentStatus(latest: LatestEvent | undefined, nowMs: number, before?: string | null): AgentStatus {
  if (!latest) return 'idle';
  const state = standing(latest, before);
  if (state === 'asks') return 'waiting';
  if (state === 'finished') return 'idle';
  const age = nowMs - new Date(latest.timestamp).getTime();
  return age <= WORKING_WINDOW_MS ? 'working' : 'idle';
}

function shortPath(p: string): string {
  return p.split('/').filter(Boolean).slice(-2).join('/');
}

function parseInput(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {}; // tool_input is stored as JSON text, but older rows may not be
  }
}

function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function describeAction(latest: LatestEvent | undefined, before?: string | null): string | null {
  if (!latest) return null;
  const state = standing(latest, before);
  if (state === 'asks') return 'needs your input';
  if (state === 'finished') return 'finished';
  if (!latest.tool_name) return null;
  const input = parseInput(latest.tool_input);
  const path = typeof input.file_path === 'string' ? shortPath(input.file_path) : null;
  if (path) return `${latest.tool_name} ${path}`;
  if (typeof input.command === 'string') return clip(`Bash: ${input.command}`);
  if (typeof input.description === 'string') return clip(`${latest.tool_name}: ${input.description}`);
  return latest.tool_name;
}
