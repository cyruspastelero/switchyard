import { describe, it, expect, beforeEach, afterEach } from './support/harness.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAccessCodeLine, tidyLogText, tidyServerLog } from '../src/server-log.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchyard-log-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('server log tidy (#17)', () => {
  it('recognises_an_old_banner_access_code_line_with_colour_codes', () => {
    expect(isAccessCodeLine('  \x1b[2mAccess Code:\x1b[0m  \x1b[1m\x1b[33m528140\x1b[0m')).toBe(true);
    expect(isAccessCodeLine('  Access code:  not logged. Copy it from the menu bar icon.')).toBe(false);
    expect(isAccessCodeLine('[contexts] app failed command 528140 (moveWindows)')).toBe(false);
  });

  it('drops_every_access_code_line_and_keeps_the_rest', () => {
    const text = 'start\n  Access Code:  111111\nok\n  Access Code:  222222\nend\n';
    expect(tidyLogText(text)).toBe('start\nok\nend\n');
  });

  it('keeps_only_the_newest_bytes_cut_at_a_line_start', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i).padStart(3, '0')}`);
    const out = tidyLogText(lines.join('\n') + '\n', 100);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(100);
    expect(out.startsWith('line ')).toBe(true);
    expect(out.endsWith('line 099\n')).toBe(true);
  });

  it('rewrites_the_file_only_when_something_changes', () => {
    const file = path.join(dir, 'server.log');
    fs.writeFileSync(file, 'a\n  Access Code:  123456\nb\n');
    expect(tidyServerLog(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('a\nb\n');
    expect(tidyServerLog(file)).toBe(false);
  });

  it('later_appends_land_after_the_trimmed_text', () => {
    const file = path.join(dir, 'server.log');
    fs.writeFileSync(file, 'x'.repeat(50) + '\nkeep\n');
    const fd = fs.openSync(file, 'a'); // like launchd's stdout
    expect(tidyServerLog(file, 10)).toBe(true);
    fs.writeSync(fd, 'next\n');
    fs.closeSync(fd);
    expect(fs.readFileSync(file, 'utf8')).toBe('keep\nnext\n');
  });

  it('a_missing_log_is_not_an_error', () => {
    expect(tidyServerLog(path.join(dir, 'none.log'))).toBe(false);
  });
});
