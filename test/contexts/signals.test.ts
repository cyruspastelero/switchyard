import { describe, it, expect, beforeAll, afterAll } from '../support/harness.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSignalSource, parseCwds, parseListeningPorts, parseRemoteUrl } from '../../src/contexts/signals.ts';

describe('parsers', () => {
  it('ssh_and_https_remotes_become_host_slash_owner_slash_repo', () => {
    expect(parseRemoteUrl('git@github.com:Owner/Repo.git\n')).toBe('github.com/owner/repo');
    expect(parseRemoteUrl('https://github.com/Owner/Repo.git')).toBe('github.com/owner/repo');
    expect(parseRemoteUrl('nonsense')).toBeNull();
  });
  it('lsof_listen_output_yields_pid_port_pairs', () => {
    const out = 'p100\nn*:3000\nn[::1]:3000\np200\nn127.0.0.1:5432\n';
    expect(parseListeningPorts(out)).toEqual([
      { pid: 100, port: 3000 }, { pid: 100, port: 3000 }, { pid: 200, port: 5432 },
    ]);
  });
  it('lsof_cwd_output_yields_pid_to_directory', () => {
    expect([...parseCwds('p100\nfcwd\nn/work/tala\n')]).toEqual([[100, '/work/tala']]);
  });
});

describe('createSignalSource', () => {
  let dir: string;
  let repo: string;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mc-signals-')));
    repo = join(dir, 'proj');
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    mkdirSync(join(repo, '.vercel'), { recursive: true });
    mkdirSync(join(repo, 'supabase', '.temp'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/proj.git'], { cwd: repo });
    writeFileSync(join(repo, '.vercel', 'project.json'), JSON.stringify({ projectName: 'proj-web' }));
    writeFileSync(join(repo, 'supabase', '.temp', 'project-ref'), 'abcdef123\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('folder_is_the_git_root_of_a_subdirectory', async () => {
    const s = createSignalSource();
    expect(await s.folderRoot(join(repo, 'src', 'deep'))).toBe(repo);
  });
  it('folder_falls_back_to_cwd_outside_a_repository', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    expect(await createSignalSource().folderRoot(plain)).toBe(plain);
  });
  it('patterns_come_from_git_remote_vercel_and_supabase', async () => {
    const found = await createSignalSource().patterns(repo);
    expect(found).toContain('github.com/acme/proj');
    expect(found).toContain('vercel.com/*/proj-web');
    expect(found).toContain('supabase.com/dashboard/project/abcdef123');
  });
  it('other_names_of_a_project_come_from_its_package_vercel_and_supabase_config', async () => {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: '@acme/proj-cli' }));
    writeFileSync(join(repo, 'supabase', 'config.toml'), '# local\nproject_id = "proj-db"\n[api]\nport = 54321\n');
    expect([...(await createSignalSource().aliases(repo))].sort()).toEqual(['proj-cli', 'proj-db', 'proj-web']);
  });
  it('a_folder_without_those_files_has_no_other_names', async () => {
    const bare = join(dir, 'bare');
    mkdirSync(bare);
    expect(await createSignalSource().aliases(bare)).toEqual([]);
  });
  it('results_are_cached_for_60_seconds', async () => {
    let clock = 1_000;
    const s = createSignalSource({ now: () => clock });
    const sub = join(repo, 'src');
    expect(await s.folderRoot(sub)).toBe(repo);
    rmSync(join(repo, '.git'), { recursive: true });
    clock += 30_000;
    expect(await s.folderRoot(sub)).toBe(repo);
    clock += 31_000;
    expect(await s.folderRoot(sub)).toBe(sub); // cache expired: not a repo any more, falls back to cwd
  });
  it('session_titles_use_the_last_ai_title_of_known_sessions_only', async () => {
    const claudeDir = join(dir, 'claude');
    mkdirSync(join(claudeDir, '-work-proj'), { recursive: true });
    const lines = [
      '{"type":"ai-title","aiTitle":"First title","sessionId":"s1"}',
      '{"type":"user","message":"hi"}',
      '{"type":"ai-title","aiTitle":"Final title","sessionId":"s1"}',
    ];
    writeFileSync(join(claudeDir, '-work-proj', 's1.jsonl'), lines.join('\n'));
    writeFileSync(join(claudeDir, '-work-proj', 's2.jsonl'), '{"type":"ai-title","aiTitle":"Other"}');
    const titles = await createSignalSource({ claudeDir }).sessionTitles(['s1']);
    expect([...titles]).toEqual([['s1', 'Final title']]);
  });
});

describe('findGitRoot', () => {
  it('a_subfolder_resolves_to_the_nearest_folder_with_a_git_entry', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { findGitRoot } = await import('../../src/contexts/signals.ts');
    const base = mkdtempSync(join(tmpdir(), 'sy-root-'));
    mkdirSync(join(base, 'repo', '.git'), { recursive: true });
    mkdirSync(join(base, 'repo', 'macos', 'Sources'), { recursive: true });
    mkdirSync(join(base, 'wt', 'src'), { recursive: true });
    writeFileSync(join(base, 'wt', '.git'), 'gitdir: elsewhere');
    expect(findGitRoot(join(base, 'repo', 'macos', 'Sources'))).toBe(join(base, 'repo'));
    expect(findGitRoot(join(base, 'wt', 'src'))).toBe(join(base, 'wt'));
    expect(findGitRoot(join(base, 'none'))).toBe(join(base, 'none'));
  });
});
