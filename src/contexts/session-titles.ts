// Claude session titles: the latest ai-title line of each session's JSONL file.
// Session files are append-only and can reach tens of MB, so each file is read once and then only its new
// bytes, in chunks with async fs, never blocking the event loop on a whole file.

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Session ids join into a path: anything but a plain name could leave the project folder. */
const SESSION_ID = /^[\w-]+$/;
const CHUNK_BYTES = 1024 * 1024;
/** More unread bytes than this in one file are skipped, as before (a title is a nicety). */
const MAX_UNREAD_BYTES = 64 * 1024 * 1024;
const NEWLINE = 0x0a;
const MARKER = Buffer.from('"type":"ai-title"');

interface FileState {
  readonly size: number;
  readonly mtimeMs: number;
  /** Bytes read up to the end of the last complete line. */
  readonly offset: number;
  /** Latest title among the complete lines read so far. */
  readonly title: string | null;
  /** Title of an unfinished last line, which is read again once complete. */
  readonly pendingTitle: string | null;
}

function titleOf(line: Buffer): string | null {
  if (!line.includes(MARKER)) return null;
  try {
    const rec = JSON.parse(line.toString('utf-8')) as { aiTitle?: unknown };
    return typeof rec.aiTitle === 'string' ? rec.aiTitle : null;
  } catch {
    return null; // partially written line: keep the previous title
  }
}

/** Reads bytes [start, end) line by line; returns the new offset and the latest title found. */
async function readLines(path: string, start: number, end: number, title: string | null): Promise<Omit<FileState, 'size' | 'mtimeMs'>> {
  const handle = await open(path, 'r');
  try {
    let offset = start;
    let rest = Buffer.alloc(0);
    let position = start;
    while (position < end) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, end - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = rest.length > 0 ? Buffer.concat([rest, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let lineStart = 0;
      for (let nl = data.indexOf(NEWLINE); nl !== -1; nl = data.indexOf(NEWLINE, lineStart)) {
        title = titleOf(data.subarray(lineStart, nl)) ?? title;
        lineStart = nl + 1;
      }
      offset += lineStart;
      rest = Buffer.from(data.subarray(lineStart));
    }
    return { offset, title, pendingTitle: rest.length > 0 ? titleOf(rest) : null };
  } finally {
    await handle.close();
  }
}

async function readFileState(path: string, prev: FileState | undefined): Promise<FileState | null> {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (prev && prev.size === info.size && prev.mtimeMs === info.mtimeMs) return prev;
  // A file shorter than what was read was rewritten: start over.
  const resume = prev !== undefined && info.size >= prev.offset;
  const start = resume ? prev.offset : 0;
  const base = resume ? prev.title : null;
  if (info.size - start > MAX_UNREAD_BYTES) {
    return { size: info.size, mtimeMs: info.mtimeMs, offset: start, title: base, pendingTitle: null };
  }
  return { size: info.size, mtimeMs: info.mtimeMs, ...(await readLines(path, start, info.size, base)) };
}

async function projectFolders(claudeDir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(claudeDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(claudeDir, e.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Returns a reader of the latest ai-title per session id. It remembers how far each file was read
 * (only for the files of the latest call, so memory stays bounded by the sessions asked about).
 */
export function createSessionTitleReader(claudeDir: string): (sessionIds: readonly string[]) => Promise<Map<string, string>> {
  let files = new Map<string, FileState>();
  return async (sessionIds) => {
    const titles = new Map<string, string>();
    const wanted = new Set(sessionIds.filter((id) => SESSION_ID.test(id)).map((id) => `${id}.jsonl`));
    if (wanted.size === 0) return titles;
    const next = new Map<string, FileState>();
    for (const folder of await projectFolders(claudeDir)) {
      const names = await readdir(folder).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return [] as string[];
        throw err;
      });
      for (const name of names) {
        if (!wanted.has(name)) continue;
        const path = join(folder, name);
        const state = await readFileState(path, files.get(path));
        if (!state) continue;
        next.set(path, state);
        const title = state.pendingTitle ?? state.title;
        if (title) titles.set(name.slice(0, -'.jsonl'.length), title);
      }
    }
    files = next;
    return titles;
  };
}
