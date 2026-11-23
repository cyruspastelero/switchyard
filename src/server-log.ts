import fs from 'node:fs';

// The LaunchAgent appends stdout and stderr to ~/.switchyard/server.log forever (issue #17).
// On each start the server drops old access-code lines and keeps only the newest part of the file.

/** About 512 KB: weeks of normal logging. */
export const LOG_MAX_BYTES = 512 * 1024;

const ANSI = /\x1b\[[0-9;]*m/g;

/** True for a banner line that shows an access code (older builds printed it on every start). */
export function isAccessCodeLine(line: string): boolean {
  return /access code:\s*\d{6}/i.test(line.replace(ANSI, ''));
}

/** Drops access-code lines, then keeps the newest `maxBytes`, cut at a line start. */
export function tidyLogText(text: string, maxBytes: number = LOG_MAX_BYTES): string {
  const kept = text.split('\n').filter((line) => !isAccessCodeLine(line)).join('\n');
  const bytes = Buffer.from(kept, 'utf8');
  if (bytes.length <= maxBytes) return kept;
  const tail = bytes.subarray(bytes.length - maxBytes).toString('utf8');
  const firstBreak = tail.indexOf('\n');
  return firstBreak === -1 ? tail : tail.slice(firstBreak + 1);
}

/**
 * Rewrites the log in place when it holds access codes or is too big. launchd keeps the file open in append
 * mode, so later writes land at the new end. Returns true when the file changed.
 */
export function tidyServerLog(file: string, maxBytes: number = LOG_MAX_BYTES): boolean {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    console.warn(`Switchyard: could not read ${file} to trim it: ${(err as Error).message}`);
    return false;
  }
  const tidy = tidyLogText(text, maxBytes);
  if (tidy === text) return false;
  try {
    fs.writeFileSync(file, tidy, { mode: 0o600 });
  } catch (err) {
    console.warn(`Switchyard: could not trim ${file}: ${(err as Error).message}`);
    return false;
  }
  return true;
}
