// Tool calls can carry source code, commands and credentials. Only a short summary is stored: the few fields
// the dashboard shows, truncated, with anything that looks like a secret replaced. Nothing else reaches disk.

interface SecretRule {
  readonly name: string;
  readonly pattern: RegExp;
  /** Replacement text; `$1`-style groups keep the harmless part (a key name, a URL scheme). */
  readonly replace: string;
}

const mark = (name: string): string => `[REDACTED:${name}]`;

const SECRET_RULES: readonly SecretRule[] = [
  { name: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replace: mark('private key') },
  { name: 'Anthropic key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, replace: mark('Anthropic key') },
  { name: 'Stripe key', pattern: /\b[spr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: mark('Stripe key') },
  { name: 'API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, replace: mark('API key') },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, replace: mark('GitHub token') },
  { name: 'Slack token', pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g, replace: mark('Slack token') },
  { name: 'AWS key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: mark('AWS key') },
  { name: 'Google key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g, replace: mark('Google key') },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: mark('JWT') },
  { name: 'auth header', pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, replace: `$1 ${mark('auth header')}` },
  { name: 'URL password', pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, replace: `$1${mark('URL password')}@` },
  {
    name: 'secret value',
    pattern: /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)(?!\[REDACTED)[^\s"'&;,]{6,}/gi,
    replace: `$1${mark('secret value')}`,
  },
];

export interface Redaction {
  readonly text: string;
  /** Names of the kinds of secret that were removed. */
  readonly found: readonly string[];
}

export function redactSecrets(text: string): Redaction {
  const found: string[] = [];
  let out = text;
  for (const rule of SECRET_RULES) {
    const next = out.replace(rule.pattern, rule.replace);
    if (next !== out) found.push(rule.name);
    out = next;
  }
  return { text: out, found };
}

/** Redacts, then cuts to `max`. Redaction sees a little more than is kept, so a cut never exposes half a secret. */
function clean(value: string, max: number, found: string[]): string {
  const redacted = redactSecrets(value.slice(0, max * 4));
  found.push(...redacted.found);
  return redacted.text.slice(0, max);
}

/** Input fields kept, with their length limits. Everything else (file contents, edit text) is dropped. */
const INPUT_FIELDS: Readonly<Record<string, number>> = {
  file_path: 500,
  notebook_path: 500,
  path: 500,
  command: 500,
  description: 200,
  pattern: 200,
  prompt: 200,
  url: 500,
  query: 200,
  skill: 100,
  to: 100,
  subagent_type: 100,
  message: 500,
  notification_type: 100,
};

const PREVIEW_CHARS = 200;

function asRecord(value: unknown): Record<string, unknown> | null {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null; // not JSON: nothing structured to keep
    }
  }
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const lineCount = (value: unknown): number | null => (typeof value === 'string' ? value.split('\n').length : null);

/** The stored form of a tool input: JSON text of the kept fields, or null when none apply. */
export function minimizeToolInput(input: unknown): string | null {
  const source = asRecord(input);
  if (!source) return null;
  const kept: Record<string, string | number> = {};
  const found: string[] = [];
  for (const [field, max] of Object.entries(INPUT_FIELDS)) {
    const value = source[field];
    if (typeof value === 'string' && value.length > 0) kept[field] = clean(value, max, found);
  }
  // Edit sizes for the dashboard's +/- line counts, instead of the edited text itself.
  const removed = lineCount(source.old_string) ?? (typeof source.removed_lines === 'number' ? source.removed_lines : null);
  const added = lineCount(source.new_string) ?? lineCount(source.content)
    ?? (typeof source.added_lines === 'number' ? source.added_lines : null);
  if (removed !== null) kept.removed_lines = removed;
  if (added !== null) kept.added_lines = added;
  return Object.keys(kept).length > 0 ? JSON.stringify(kept) : null;
}

const OUTPUT_TEXT_FIELDS = ['preview', 'stdout', 'content', 'output', 'result', 'text'] as const;

/** The stored form of a tool output: whether it failed and a short redacted preview. Never the output itself. */
export function minimizeToolOutput(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  const found: string[] = [];
  const kept: Record<string, unknown> = {};
  const source = asRecord(output);
  if (source) {
    if (source.is_error === true) kept.is_error = true;
    if (typeof source.error === 'string' && source.error) kept.error = clean(source.error, PREVIEW_CHARS, found);
    else if (source.error === true) kept.is_error = true;
    if (typeof source.stderr === 'string' && source.stderr) kept.stderr = clean(source.stderr, PREVIEW_CHARS, found);
    const text = OUTPUT_TEXT_FIELDS.map((f) => source[f]).find((v): v is string => typeof v === 'string' && v.length > 0);
    if (text) kept.preview = clean(text, PREVIEW_CHARS, found);
    if (Array.isArray(source.redacted)) found.push(...source.redacted.filter((r): r is string => typeof r === 'string'));
  } else if (typeof output === 'string' && output.length > 0) {
    kept.preview = clean(output, PREVIEW_CHARS, found);
  }
  if (found.length > 0) kept.redacted = [...new Set(found)];
  return Object.keys(kept).length > 0 ? JSON.stringify(kept) : null;
}
