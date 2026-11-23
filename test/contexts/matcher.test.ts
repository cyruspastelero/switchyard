import { describe, it, expect } from '../support/harness.ts';
import {
  matchUrl, matchBrowserWindow as matchBrowser, matchAppWindow as matchApp, matchWindow, learnPattern, ruleIsSpecific,
  type AppWindowLike, type MatchableContext, type TitleEntry,
} from '../../src/contexts/matcher.ts';
import { liveContexts, liveSessionTitles, liveWindows } from './fixtures/live-snapshot.ts';

// Most cases only care where the window lands; the reason has its own cases below.
const matchBrowserWindow = (tabs: readonly { url: string }[], ctxs: readonly MatchableContext[], title = ''): string | null =>
  matchBrowser({ title, tabs }, ctxs)?.contextId ?? null;
const matchAppWindow = (win: AppWindowLike, ctxs: readonly MatchableContext[], titles: readonly TitleEntry[]): string | null =>
  matchApp(win, ctxs, titles)?.contextId ?? null;

const tala: MatchableContext = {
  id: 'tala', name: 'tala', folder: '/work/tala',
  patterns: ['github.com/cyrus/tala', 'vercel.com/*/tala-web', 'localhost:3000', 'supabase.com/dashboard/project/abc123'],
};
const arki: MatchableContext = { id: 'arki', name: 'shea-coach', folder: '/work/shea-coach', patterns: ['github.com/cyrus/shea-coach', 'localhost:3001'] };
const contexts = [tala, arki];

describe('matchUrl', () => {
  it('matches_github_repo_pages_by_prefix', () => {
    expect(matchUrl('https://github.com/cyrus/tala/pull/12', contexts)).toBe('tala');
  });
  it('wildcard_segment_matches_any_vercel_team', () => {
    expect(matchUrl('https://vercel.com/my-team/tala-web/deployments', contexts)).toBe('tala');
  });
  it('loopback_hosts_are_equivalent', () => {
    expect(matchUrl('http://127.0.0.1:3001/dashboard', contexts)).toBe('arki');
  });
  it('unknown_sites_do_not_match', () => {
    expect(matchUrl('https://mail.google.com/mail/u/0/', contexts)).toBeNull();
  });
  it('non_web_urls_do_not_match', () => {
    expect(matchUrl('chrome://newtab', contexts)).toBeNull();
  });
  it('most_specific_pattern_wins_over_a_learned_prefix', () => {
    const learned: MatchableContext = { id: 'other', name: 'other', folder: null, patterns: ['github.com/cyrus'] };
    expect(matchUrl('https://github.com/cyrus/tala', [learned, tala])).toBe('tala');
  });
  it('equally_specific_patterns_from_two_contexts_are_ambiguous', () => {
    const a: MatchableContext = { id: 'a', name: 'a', folder: null, patterns: ['example.com/x'] };
    const b: MatchableContext = { id: 'b', name: 'b', folder: null, patterns: ['example.com/x'] };
    expect(matchUrl('https://example.com/x/1', [a, b])).toBeNull();
  });
});

describe('matchBrowserWindow', () => {
  it('browser_window_follows_majority_of_matched_tabs', () => {
    const tabs = [
      { url: 'https://github.com/cyrus/tala' },
      { url: 'http://localhost:3000' },
      { url: 'https://github.com/cyrus/shea-coach' },
    ];
    expect(matchBrowserWindow(tabs, contexts)).toBe('tala');
  });
  it('unmatched_tabs_do_not_vote', () => {
    const tabs = [
      { url: 'https://mail.google.com' }, { url: 'https://youtube.com/watch?v=1' },
      { url: 'https://google.com/search?q=x' }, { url: 'http://localhost:3001' },
    ];
    expect(matchBrowserWindow(tabs, contexts)).toBe('arki');
  });
  it('a_tie_between_contexts_leaves_the_window_unsorted', () => {
    const tabs = [{ url: 'http://localhost:3000' }, { url: 'http://localhost:3001' }];
    expect(matchBrowserWindow(tabs, contexts)).toBeNull();
  });
  it('no_matched_tabs_leaves_the_window_unsorted', () => {
    expect(matchBrowserWindow([{ url: 'https://news.ycombinator.com' }], contexts)).toBeNull();
  });
});

describe('matchAppWindow', () => {
  it('document_inside_a_folder_wins_over_a_name_merely_mentioned_in_the_title', () => {
    const win = { title: 'notes about shea-coach.md', document: '/work/tala/src/index.ts' };
    expect(matchAppWindow(win, contexts, [])).toBe('tala');
  });
  it('editor_workspace_folder_in_the_title_wins_over_the_open_file', () => {
    // "file — folder": the window belongs to the workspace even while a file from another repo is open.
    const win = { title: 'index.ts — shea-coach', document: '/work/tala/src/index.ts' };
    expect(matchAppWindow(win, contexts, [])).toBe('arki');
  });
  it('a_file_named_like_another_project_does_not_confuse_the_workspace_match', () => {
    expect(matchAppWindow({ title: 'tala-notes.md — shea-coach', document: null }, contexts, [])).toBe('arki');
    expect(matchAppWindow({ title: 'tala — shea-coach', document: null }, contexts, [])).toBeNull();
  });
  it('file_url_documents_are_decoded', () => {
    expect(matchAppWindow({ title: '', document: 'file:///work/shea-coach/a%20b.ts' }, contexts, [])).toBe('arki');
  });
  it('title_with_folder_path_matches', () => {
    expect(matchAppWindow({ title: 'zsh /work/tala/src', document: null }, contexts, [])).toBe('tala');
  });
  it('title_with_folder_basename_matches_on_word_boundary', () => {
    expect(matchAppWindow({ title: 'claude — shea-coach', document: null }, contexts, [])).toBe('arki');
    expect(matchAppWindow({ title: 'metalanguage', document: null }, contexts, [])).toBeNull();
  });
  it('title_equal_to_a_known_claude_session_title_matches_ignoring_status_glyph', () => {
    const titles = [{ title: 'Multi-project workspace workflow design', contextId: 'arki' }];
    const win = { title: '◑ Multi-project workspace workflow design', document: null };
    expect(matchAppWindow(win, contexts, titles)).toBe('arki');
  });
  it('unrelated_windows_stay_unsorted', () => {
    expect(matchAppWindow({ title: 'Spotify', document: null }, contexts, [])).toBeNull();
  });
});

describe('learnPattern', () => {
  it('learns_host_and_first_path_segment_on_ordinary_sites', () => {
    expect(learnPattern('https://notion.so/tala-notes/page')).toBe('notion.so/tala-notes');
  });
  it('a_code_host_rule_names_the_repo_never_the_whole_owner', () => {
    expect(learnPattern('https://github.com/cyrus/tala/issues')).toBe('github.com/cyrus/tala');
    expect(learnPattern('https://github.com/cyrus')).toBeNull();
    expect(learnPattern('https://github.com/settings/profile')).toBeNull();
    expect(learnPattern('https://vercel.com/my-team/tala-web/deployments')).toBe('vercel.com/my-team/tala-web');
    expect(learnPattern('https://vercel.com/my-team')).toBeNull();
    expect(learnPattern('https://supabase.com/dashboard/project/abc123/editor')).toBe('supabase.com/dashboard/project/abc123');
    expect(learnPattern('https://supabase.com/dashboard/projects')).toBeNull();
    expect(learnPattern('https://docs.google.com/document/d/DOCID/edit')).toBe('docs.google.com/document/d/docid');
    expect(learnPattern('http://127.0.0.1:3000/admin/users')).toBe('localhost:3000');
  });
  it('an_owner_wide_rule_already_stored_is_recognised_as_too_broad', () => {
    expect(ruleIsSpecific('github.com/cyrus')).toBe(false);
    expect(ruleIsSpecific('github.com/cyrus/tala')).toBe(true);
    expect(ruleIsSpecific('notion.so/tala-notes')).toBe(true);
    expect(ruleIsSpecific('tala.kids')).toBe(true);
  });
  it('never_learns_generic_sites', () => {
    expect(learnPattern('https://mail.google.com/mail')).toBeNull();
    expect(learnPattern('https://www.youtube.com/watch?v=1')).toBeNull();
  });
  it('learns_a_bare_host_when_there_is_no_path', () => {
    expect(learnPattern('https://tala.kids/')).toBe('tala.kids');
  });
});

describe('browser window without readable tabs', () => {
  const mono: MatchableContext = { id: 'mono', name: 'work', folder: '/work', patterns: [] };
  const topic: MatchableContext = { id: 'topic', name: 'test', folder: null, patterns: [] };
  const web: MatchableContext = { id: 'web', name: 'tala-web', folder: '/work/tala-web', patterns: ['github.com/cyrus/tala-web'] };
  const all = [mono, tala, arki, topic, web];
  const byTitle = (title: string) => matchBrowser({ title, tabs: [] }, all);

  it('title_naming_the_repo_owner_and_name_matches_that_repo', () => {
    const m = byTitle('GitHub - cyrus/tala: a kids tutor · GitHub - Google Chrome - Some Profile');
    expect(m).toMatchObject({ contextId: 'tala', reason: 'title names repo cyrus/tala' });
  });
  it('a_repo_whose_name_only_starts_with_a_known_repo_is_not_that_repo', () => {
    expect(byTitle('cyrus/tala-web: Pull requests · GitHub')?.contextId).toBe('web');
    expect(byTitle('cyrus/tala-archive · GitHub')).toBeNull();
  });
  it('title_showing_a_listening_port_matches', () => {
    expect(byTitle('localhost:3001/dashboard')).toMatchObject({ contextId: 'arki', reason: 'title shows localhost:3001' });
    expect(byTitle('localhost:30010/dashboard')).toBeNull();
  });
  it('vercel_project_name_matches_only_on_a_vercel_page', () => {
    const noName = [{ ...tala, name: 'kids', folder: '/work/kids' }, arki];
    expect(matchBrowser({ title: 'tala-web – Overview – Vercel', tabs: [] }, noName)?.contextId).toBe('tala');
    expect(matchBrowser({ title: 'tala-web review notes', tabs: [] }, noName)).toBeNull();
  });
  it('context_name_or_folder_name_as_a_whole_word_matches', () => {
    expect(byTitle('shea-coach – Supabase')).toMatchObject({ contextId: 'arki', reason: 'title mentions "shea-coach"' });
    expect(byTitle('Metalanguage - Wikipedia')).toBeNull();
  });
  it('the_browser_profile_name_in_the_title_never_matches', () => {
    expect(byTitle('Hacker News - Google Chrome - tala')).toBeNull();
  });
  it('short_or_everyday_names_do_not_match_by_word', () => {
    expect(byTitle('How to test a React app')).toBeNull();
    expect(byTitle('Remote work tips')).toBeNull();
  });
  it('a_title_naming_two_projects_is_ambiguous_and_stays_unsorted', () => {
    expect(byTitle('Compare cyrus/tala and cyrus/shea-coach · GitHub')).toBeNull();
  });
  it('a_strong_title_signal_beats_a_weaker_word_for_another_project', () => {
    expect(byTitle('cyrus/tala: shea-coach import script · GitHub')?.contextId).toBe('tala');
  });
  it('readable_tabs_decide_before_the_title_and_a_tab_tie_stays_unsorted', () => {
    expect(matchBrowser({ title: 'cyrus/tala · GitHub', tabs: [{ url: 'http://localhost:3001' }] }, all))
      .toMatchObject({ contextId: 'arki', reason: '1 of 1 tabs match shea-coach' });
    expect(matchBrowser({ title: 'cyrus/tala · GitHub', tabs: [{ url: 'http://localhost:3001' }, { url: 'http://localhost:3000' }] }, all)).toBeNull();
    expect(matchBrowser({ title: 'cyrus/tala · GitHub', tabs: [{ url: 'https://news.ycombinator.com' }] }, all)?.contextId).toBe('tala');
  });
});

describe('parent and child folders', () => {
  const parent: MatchableContext = { id: 'parent', name: 'work', folder: '/work', patterns: [] };
  const all = [parent, tala, arki];

  it('a_path_inside_a_child_goes_to_the_child_never_the_parent', () => {
    expect(matchAppWindow({ title: '', document: '/work/tala/src/a.ts' }, all, [])).toBe('tala');
    expect(matchAppWindow({ title: 'zsh /work/tala', document: null }, all, [])).toBe('tala');
  });
  it('a_path_in_the_parent_but_in_no_child_goes_to_the_parent', () => {
    expect(matchAppWindow({ title: '', document: '/work/notes.md' }, all, [])).toBe('parent');
  });
  it('a_title_naming_parent_and_child_goes_to_the_child', () => {
    expect(matchAppWindow({ title: '~/work/tala', document: null }, all, [])).toBe('tala');
  });
  it('a_claude_session_title_beats_the_terminal_folder', () => {
    // The terminal was opened in the parent; the session in it works in the child.
    const titles = [{ title: 'Fix login', contextId: 'tala' }];
    const m = matchApp({ title: '✳ Fix login', document: '/work' }, all, titles);
    expect(m).toMatchObject({ contextId: 'tala', reason: 'Claude session "Fix login"', strong: true });
  });
  it('a_session_title_used_in_two_projects_falls_back_to_the_folder', () => {
    const titles = [{ title: 'Fix login', contextId: 'tala' }, { title: 'Fix login', contextId: 'arki' }];
    expect(matchAppWindow({ title: '✳ Fix login', document: '/work' }, all, titles)).toBe('parent');
  });
});

describe('matched-by reason', () => {
  it('every_match_says_why', () => {
    expect(matchApp({ title: '', document: '/work/tala/src/a.ts' }, contexts, [])).toMatchObject({ reason: 'open in /work/tala', strong: true });
    expect(matchApp({ title: 'a.ts — tala', document: null }, contexts, [])).toMatchObject({ reason: 'workspace folder "tala"', strong: true });
    expect(matchApp({ title: 'zsh /work/tala/src', document: null }, contexts, [])).toMatchObject({ reason: 'title shows /work/tala', strong: true });
    expect(matchApp({ title: 'notes on tala today', document: null }, contexts, [])).toMatchObject({ reason: 'title mentions "tala"', strong: false });
  });
});

describe('real snapshot shapes', () => {
  it.each(liveWindows.map((w) => [w.app, w.title, w] as const))('%s "%s" lands where expected', (_app, _title, w) => {
    expect(matchWindow(w, liveContexts, liveSessionTitles)?.contextId ?? null).toBe(w.expected);
  });
  it('matching_is_deterministic_whatever_the_context_order', () => {
    const reversed = [...liveContexts].reverse();
    for (const w of liveWindows) {
      expect(matchWindow(w, reversed, liveSessionTitles)).toEqual(matchWindow(w, liveContexts, liveSessionTitles));
    }
  });
  it('a_browser_is_recognised_by_its_bundle_even_without_a_tab_list', () => {
    // "lesson-plan.md — coach-app" would be a workspace match for an editor; in a browser it is two names.
    const win = { ...liveWindows[0], bundleId: 'com.google.Chrome', title: 'lesson — coach-app - Google Chrome - Dev User', document: null };
    expect(matchWindow(win, liveContexts, [])).toBeNull();
  });
});
