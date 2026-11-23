// Where a Claude session really works. Sessions are often started in a parent folder that holds many
// repositories; the folders its tools touch say which repository the session belongs to. Pure, no I/O.

const MIN_TOUCHES = 5;
const MIN_SHARE = 0.6;

function parse(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {}; // truncated or non-JSON tool input says nothing about a folder
  }
}

const absolute = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/');

/** Absolute paths a stored tool call points at: the file it reads or edits, or the folder a command changes into. */
export function pathsFromToolInput(raw: string | null): readonly string[] {
  const input = parse(raw);
  const paths = [input.file_path, input.notebook_path, input.path].filter(absolute);
  if (typeof input.command === 'string') {
    const cd = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(input.command);
    const target = cd?.[1] ?? cd?.[2] ?? cd?.[3];
    if (absolute(target)) paths.push(target);
  }
  return paths;
}

function inside(path: string, folder: string): boolean {
  return path.startsWith(`${folder}/`);
}

/**
 * The folder a session belongs to. `base` is the project root of the folder it runs in; `touchedRoots` holds
 * the project root of each path it touched, one entry per touch. The session moves down into a nested
 * project only when that project clearly holds most of its work; it never moves sideways or up.
 */
export function pickWorkFolder(base: string, touchedRoots: readonly string[]): string {
  const relevant = touchedRoots.filter((root) => root === base || inside(root, base));
  const counts = new Map<string, number>();
  for (const root of relevant) if (root !== base) counts.set(root, (counts.get(root) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length === 0) return base;
  const [winner, touches] = ranked[0];
  return touches >= MIN_TOUCHES && touches / relevant.length >= MIN_SHARE ? winner : base;
}
