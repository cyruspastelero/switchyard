import { describe, it, expect, beforeEach, afterEach } from '../support/harness.ts';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionTitleReader } from '../../src/contexts/session-titles.ts';

const title = (text: string) => `{"type":"ai-title","aiTitle":"${text}","sessionId":"s1"}`;

let claudeDir: string;
let project: string;
beforeEach(() => {
  claudeDir = mkdtempSync(join(tmpdir(), 'sy-titles-'));
  project = join(claudeDir, '-work-proj');
  mkdirSync(project);
});
afterEach(() => rmSync(claudeDir, { recursive: true, force: true }));

describe('session titles', () => {
  it('a_session_id_that_is_not_a_plain_name_is_never_read', async () => {
    writeFileSync(join(claudeDir, 'secret.jsonl'), `${title('Outside')}\n`);
    const titles = await createSessionTitleReader(claudeDir)(['../secret', '..', 'a/b']);
    expect([...titles]).toEqual([]);
  });

  it('a_title_appended_later_replaces_the_earlier_one', async () => {
    const file = join(project, 's1.jsonl');
    writeFileSync(file, `${title('First')}\n{"type":"user","message":"hi"}\n`);
    const read = createSessionTitleReader(claudeDir);
    expect([...(await read(['s1']))]).toEqual([['s1', 'First']]);
    appendFileSync(file, `${title('Second')}\n{"type":"user","message":"more"}\n`);
    expect([...(await read(['s1']))]).toEqual([['s1', 'Second']]);
  });

  it('a_line_still_being_written_is_read_again_once_complete', async () => {
    const file = join(project, 's1.jsonl');
    const full = title('Done');
    writeFileSync(file, `${title('First')}\n${full.slice(0, 20)}`);
    const read = createSessionTitleReader(claudeDir);
    expect([...(await read(['s1']))]).toEqual([['s1', 'First']]);
    appendFileSync(file, `${full.slice(20)}\n`);
    expect([...(await read(['s1']))]).toEqual([['s1', 'Done']]);
  });

  it('a_rewritten_shorter_file_is_read_from_the_start', async () => {
    const file = join(project, 's1.jsonl');
    writeFileSync(file, `${title('A long first title that takes room')}\n{"type":"user","message":"padding padding"}\n`);
    const read = createSessionTitleReader(claudeDir);
    await read(['s1']);
    writeFileSync(file, `${title('New')}\n`);
    expect([...(await read(['s1']))]).toEqual([['s1', 'New']]);
  });

  it('a_title_split_across_read_chunks_is_still_found', async () => {
    const file = join(project, 's1.jsonl');
    const filler = `{"type":"user","message":"${'é'.repeat(300_000)}"}\n`;
    writeFileSync(file, `${filler}${filler}${title('Héllo')}\n`);
    expect([...(await createSessionTitleReader(claudeDir)(['s1']))]).toEqual([['s1', 'Héllo']]);
  });

  it('a_missing_claude_folder_gives_no_titles', async () => {
    expect([...(await createSessionTitleReader(join(claudeDir, 'nope'))(['s1']))]).toEqual([]);
  });
});
