// Signals: what identifies a project folder on the web and in running processes.
// All child processes use execFile with argument arrays, a timeout, and a 60 s cache.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 60_000;
const MAX_JSONL_BYTES = 64 * 1024 * 1024;

export interface SignalSource {
  /** Git root of `cwd`, or `cwd` itself when it is not inside a repository. */
  folderRoot(cwd: string): Promise<string>;
  /** URL patterns that identify the folder (git remote, Vercel, Supabase, listening ports). */
  patterns(folder: string): Promise<readonly string[]>;
  /** Other names the project goes by: package name, Vercel project name, Supabase project id. */
  aliases?(folder: string): Promise<readonly string[]>;
  /** Latest ai-title per Claude session id, for the given sessions. */
  sessionTitles(sessionIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

// --- Pure parsers ---------------------------------------------------------

/** "git@github.com:o/r.git" or "https://github.com/o/r.git" -> "github.com/o/r". */
export function parseRemoteUrl(remote: string): string | null {
  const text = remote.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(text);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const url = new URL(text);
    const path = url.pathname.replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
    return path ? `${url.hostname}/${path}`.toLowerCase() : null;
  } catch {
    return null;
  }
}

export interface ListeningPort {
  readonly pid: number;
  readonly port: number;
}

/** Parse `lsof -iTCP -sTCP:LISTEN -nP -Fpn` output. */
export function parseListeningPorts(output: string): readonly ListeningPort[] {
  const result: ListeningPort[] = [];
  let pid: number | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number.parseInt(line.slice(1), 10);
    else if (line.startsWith('n') && pid !== null) {
      const m = /:(\d+)$/.exec(line);
      if (m) result.push({ pid, port: Number.parseInt(m[1], 10) });
    }
  }
  return result;
}

/** Parse `lsof -a -p <pids> -d cwd -Fpn` output into pid -> cwd. */
export function parseCwds(output: string): ReadonlyMap<number, string> {
  const map = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number.parseInt(line.slice(1), 10);
    else if (line.startsWith('n') && pid !== null) map.set(pid, line.slice(1));
  }
  return map;
}

function insideFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

// --- Cache ------------------------------------------------------------------

class TtlCache<V> {
  private readonly entries = new Map<string, { value: Promise<V>; at: number }>();
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }

  get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = load();
    this.entries.set(key, { value, at: this.now() });
    return value;
  }
}

// --- Process helpers --------------------------------------------------------

async function run(file: string, args: readonly string[], cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, [...args], { timeout: EXEC_TIMEOUT_MS, cwd, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
    // Non-zero exit (not a repo, no matches) is an expected answer; anything else is worth a warning.
    if (typeof e.code === 'number') return null;
    console.warn(`[contexts] ${file} ${args.join(' ')} failed: ${e.message}`);
    return null;
  }
}

/**
 * Nearest folder at or above `cwd` holding a `.git` entry (a directory, or a file in worktrees).
 * A filesystem walk rather than `git rev-parse`: no subprocess, so it can't time out under load
 * and turn a subfolder into a context of its own. Falls back to `cwd`.
 */
/** A repository reached through a symlink (an old folder name, say) is the same project as its real path. */
function realRoot(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir; // vanished between the existsSync and here: the path walk's answer is still the best guess
  }
}

export function findGitRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return realRoot(dir);
    const parent = dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

async function gitRoot(cwd: string): Promise<string> {
  return findGitRoot(cwd);
}

async function gitRemotePattern(folder: string): Promise<string[]> {
  const out = await run('git', ['remote', 'get-url', 'origin'], folder);
  const parsed = out ? parseRemoteUrl(out) : null;
  return parsed ? [parsed] : [];
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null; // file absent: the project simply does not use this service
  }
}

function filePatterns(folder: string): string[] {
  const patterns: string[] = [];
  const name = vercelProjectName(folder);
  if (name) patterns.push(`vercel.com/*/${name}`);
  const ref = readText(join(folder, 'supabase', '.temp', 'project-ref'))?.trim();
  if (ref && /^[a-z0-9]+$/.test(ref)) patterns.push(`supabase.com/dashboard/project/${ref}`);
  return patterns;
}

function vercelProjectName(folder: string): string | null {
  const vercel = readText(join(folder, '.vercel', 'project.json'));
  if (!vercel) return null;
  try {
    const name = (JSON.parse(vercel) as { projectName?: unknown }).projectName;
    return typeof name === 'string' && name.length > 0 ? name : null;
  } catch (err) {
    console.warn(`[contexts] invalid .vercel/project.json in ${folder}: ${(err as Error).message}`);
    return null;
  }
}

function packageName(folder: string): string | null {
  const pkg = readText(join(folder, 'package.json'));
  if (!pkg) return null;
  try {
    const name = (JSON.parse(pkg) as { name?: unknown }).name;
    return typeof name === 'string' && name.length > 0 ? name.replace(/^@[^/]+\//, '') : null;
  } catch (err) {
    console.warn(`[contexts] invalid package.json in ${folder}: ${(err as Error).message}`);
    return null;
  }
}

/** Names a page title may use for the project when it does not use the folder name. */
function fileAliases(folder: string): string[] {
  const supabaseId = /^\s*project_id\s*=\s*"([^"]+)"/m.exec(readText(join(folder, 'supabase', 'config.toml')) ?? '')?.[1] ?? null;
  const names = [packageName(folder), vercelProjectName(folder), supabaseId];
  return [...new Set(names.filter((n): n is string => n !== null))];
}

async function listeningPortsByFolder(): Promise<ReadonlyMap<number, string>> {
  const out = await run('lsof', ['-iTCP', '-sTCP:LISTEN', '-nP', '-Fpn']);
  const ports = out ? parseListeningPorts(out) : [];
  if (ports.length === 0) return new Map();
  const pids = [...new Set(ports.map((p) => p.pid))];
  const cwdOut = await run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn']);
  const cwds = cwdOut ? parseCwds(cwdOut) : new Map<number, string>();
  const byPort = new Map<number, string>();
  for (const { pid, port } of ports) {
    const cwd = cwds.get(pid);
    if (cwd) byPort.set(port, cwd);
  }
  return byPort;
}

function portPatterns(folder: string, byPort: ReadonlyMap<number, string>): string[] {
  const out: string[] = [];
  for (const [port, cwd] of byPort) {
    if (insideFolder(cwd, folder)) out.push(`localhost:${port}`);
  }
  return out;
}

// --- Claude session titles ----------------------------------------------------

function lastAiTitle(path: string): string | null {
  if (statSync(path).size > MAX_JSONL_BYTES) return null;
  let title: string | null = null;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.includes('"type":"ai-title"')) continue;
    try {
      const rec = JSON.parse(line) as { aiTitle?: unknown };
      if (typeof rec.aiTitle === 'string') title = rec.aiTitle;
    } catch {
      // partially written trailing line: keep the previous title
    }
  }
  return title;
}

function readSessionTitles(sessionIds: readonly string[], claudeDir: string): Map<string, string> {
  const titles = new Map<string, string>();
  if (!existsSync(claudeDir) || sessionIds.length === 0) return titles;
  for (const project of readdirSync(claudeDir)) {
    for (const id of sessionIds) {
      const file = join(claudeDir, project, `${id}.jsonl`);
      if (!existsSync(file)) continue;
      const title = lastAiTitle(file);
      if (title) titles.set(id, title);
    }
  }
  return titles;
}

export interface SignalOptions {
  readonly now?: () => number;
  readonly claudeDir?: string;
}

export function createSignalSource(options: SignalOptions = {}): SignalSource {
  const now = options.now ?? Date.now;
  const claudeDir = options.claudeDir ?? join(homedir(), '.claude', 'projects');
  const roots = new TtlCache<string>(now);
  const patterns = new TtlCache<readonly string[]>(now);
  const ports = new TtlCache<ReadonlyMap<number, string>>(now);
  const titles = new TtlCache<ReadonlyMap<string, string>>(now);
  const aliases = new TtlCache<readonly string[]>(now);

  return {
    folderRoot: (cwd) => roots.get(cwd, () => gitRoot(cwd)),
    patterns: (folder) =>
      patterns.get(folder, async () => {
        const byPort = await ports.get('all', listeningPortsByFolder);
        const remote = await gitRemotePattern(folder);
        return [...remote, ...filePatterns(folder), ...portPatterns(folder, byPort)];
      }),
    aliases: (folder) => aliases.get(folder, async () => fileAliases(folder)),
    sessionTitles: (ids) =>
      titles.get([...ids].sort().join(','), async () => readSessionTitles(ids, claudeDir)),
  };
}
