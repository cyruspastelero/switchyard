import { describe, it, expect, beforeAll, afterAll, beforeEach } from '../support/harness.ts';
import { setupTestDb, teardownTestDb } from '../helpers.ts';
import type { SignalSource } from '../../src/contexts/signals.ts';
import type { SnapshotWindow } from '../../src/contexts/types.ts';

const tmpDir = setupTestDb();
const { getDb, upsertAgent, insertEvent, getAgents } = await import('../../src/db.ts');
const { ContextsService } = await import('../../src/contexts/service.ts');

const db = getDb();
let patternsByFolder: Record<string, string[]> = {};
let titles = new Map<string, string>();
const signals: SignalSource = {
  folderRoot: async (cwd) => cwd.replace(/\/src(\/.*)?$/, ''),
  patterns: async (folder) => patternsByFolder[folder] ?? [],
  sessionTitles: async () => titles,
};

function newService() {
  return new ContextsService({ db, listAgents: getAgents, signals, costPerToolCall: 0.01, autoContextWindowMs: Infinity });
}

function addAgent(id: string, cwd: string, firstSeen: string, status = 'active', session = `sess-${id}`) {
  upsertAgent({
    id, session_id: session, agent_id: 'main', name: id, status, cwd, model: null,
    current_mission_id: null, first_seen_at: firstSeen, last_seen_at: firstSeen,
  });
}

function chrome(key: string, urls: string[], name: string | null = null): SnapshotWindow {
  return {
    key, app: 'Google Chrome', bundleId: 'com.google.Chrome', pid: 1, title: 'T', document: null,
    browser: { windowId: key, name, tabs: urls.map((url, i) => ({ id: i, url, title: url })) },
  };
}

function ghostty(key: string, title: string, document: string | null = null): SnapshotWindow {
  return { key, app: 'Ghostty', bundleId: 'com.mitchellh.ghostty', pid: 2, title, document, browser: null };
}

/** A browser window whose tabs could not be read: only the active tab's title is known. */
function chromeTitleOnly(key: string, title: string): SnapshotWindow {
  return { key, app: 'Google Chrome', bundleId: 'com.google.Chrome', pid: 1, title: `${title} - Google Chrome - Profile`, document: null, browser: null };
}

function touch(session: string, path: string, times: number) {
  for (let i = 0; i < times; i++) {
    insertEvent({
      agent_id: `${session}:sub`, session_id: session, event_type: 'PreToolUse', tool_name: 'Edit',
      tool_input: JSON.stringify({ file_path: path }), tool_output: null, mission_id: null, timestamp: '2026-01-01T00:00:00Z',
    });
  }
}

function contextOf(view: Awaited<ReturnType<InstanceType<typeof ContextsService>['view']>>, key: string): string | null {
  return view.contexts.find((c) => c.windows.some((w) => w.key === key))?.name ?? null;
}

new ContextsService({ db, listAgents: getAgents, signals }); // creates the tables

beforeEach(() => {
  db.exec('DELETE FROM context_rules; DELETE FROM window_assignments; DELETE FROM window_unsorted; DELETE FROM window_names; DELETE FROM parked_windows; DELETE FROM contexts; DELETE FROM agents; DELETE FROM events;');
  patternsByFolder = {};
  titles = new Map();
});
afterAll(() => teardownTestDb(tmpDir));

describe('automatic contexts', () => {
  it('a_context_is_created_for_each_distinct_agent_folder_using_the_git_root', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    addAgent('a2', '/work/tala/src', '2026-01-01T00:01:00Z');
    addAgent('a3', '/work/arki', '2026-01-01T00:02:00Z');
    const view = await newService().view();
    expect(view.contexts.map((c) => c.folder)).toEqual(['/work/tala', '/work/arki']);
    expect(view.contexts[0].agents).toHaveLength(2);
  });

  it('keys_1_to_9_follow_first_appearance_then_null', async () => {
    for (let i = 0; i < 11; i++) addAgent(`a${i}`, `/work/p${i}`, `2026-01-01T00:${String(10 - i).padStart(2, '0')}:00Z`);
    const view = await newService().view();
    const byFolder = new Map(view.contexts.map((c) => [c.folder, c.key]));
    // a10 appeared first (earliest timestamp) -> key 1; a0 appeared last -> null
    expect(byFolder.get('/work/p10')).toBe(1);
    expect(byFolder.get('/work/p2')).toBe(9);
    expect(byFolder.get('/work/p1')).toBeNull();
    expect(byFolder.get('/work/p0')).toBeNull();
  });

  it('agents_not_seen_recently_do_not_create_contexts', async () => {
    addAgent('old', '/work/archive', '2026-01-01T00:00:00Z');
    addAgent('new', '/work/tala', '2026-01-02T23:00:00Z');
    const service = new ContextsService({
      db, listAgents: getAgents, signals, now: () => Date.parse('2026-01-03T00:00:00Z'), autoContextWindowMs: 12 * 3600_000,
    });
    const view = await service.view();
    expect(view.contexts.map((c) => c.folder)).toEqual(['/work/tala']);
    expect(view.contexts[0].key).toBe(1);
  });

  it('main_agents_stored_with_session_prefixed_ids_are_listed_and_subagents_are_not', async () => {
    upsertAgent({
      id: 'sess-x:main', session_id: 'sess-x', agent_id: 'sess-x:main', name: 'main one', status: 'active', cwd: '/work/tala',
      model: null, current_mission_id: null, first_seen_at: '2026-01-01T00:00:00Z', last_seen_at: '2026-01-01T00:00:00Z',
    });
    upsertAgent({
      id: 'sess-x:abc123', session_id: 'sess-x', agent_id: 'sess-x:abc123', name: 'sub', status: 'active', cwd: '/work/tala',
      model: null, current_mission_id: null, first_seen_at: '2026-01-01T00:00:00Z', last_seen_at: '2026-01-01T00:00:00Z',
    });
    const view = await newService().view();
    expect(view.contexts[0].agents.map((a) => a.name)).toEqual(['main one']);
  });

  it('disconnected_agents_are_not_listed', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z', 'disconnected');
    const view = await newService().view();
    expect(view.contexts[0].agents).toEqual([]);
    expect(view.contexts[0].status).toBe('idle');
  });
});

describe('agent status roll-up', () => {
  it('a_notification_as_latest_event_makes_the_context_waiting', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    const now = new Date().toISOString();
    insertEvent({ agent_id: 'a1', session_id: 's', event_type: 'PreToolUse', tool_name: 'Bash', tool_input: '{"command":"ls"}', tool_output: null, mission_id: null, timestamp: now });
    const svc = newService();
    let view = await svc.view();
    expect(view.contexts[0].status).toBe('working');
    expect(view.contexts[0].agents[0].lastAction).toBe('Bash: ls');
    expect(view.contexts[0].agents[0].costToday).toBe(0.01);
    insertEvent({ agent_id: 'a1', session_id: 's', event_type: 'Notification', tool_name: null, tool_input: null, tool_output: null, mission_id: null, timestamp: now });
    view = await svc.view();
    expect(view.contexts[0].status).toBe('waiting');
    expect(view.waitingCount).toBe(1);
  });

  it('the_idle_reminder_after_a_finished_turn_does_not_count_as_waiting', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    insertEvent({ agent_id: 'a1', session_id: 's', event_type: 'Stop', tool_name: null, tool_input: null, tool_output: null, mission_id: null, timestamp: at(60) });
    insertEvent({ agent_id: 'a1', session_id: 's', event_type: 'Notification', tool_name: null, tool_input: null, tool_output: null, mission_id: null, timestamp: at(0) });
    const view = await newService().view();
    expect(view.contexts[0].status).toBe('idle');
    expect(view.contexts[0].agents[0].lastAction).toBe('finished');
    expect(view.waitingCount).toBe(0);
  });

  it('old_activity_is_idle', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    insertEvent({ agent_id: 'a1', session_id: 's', event_type: 'PreToolUse', tool_name: 'Read', tool_input: null, tool_output: null, mission_id: null, timestamp: new Date(Date.now() - 600_000).toISOString() });
    expect((await newService().view()).contexts[0].status).toBe('idle');
  });
});

describe('sorting', () => {
  it('snapshot_sorts_new_windows_and_names_chrome_windows_after_the_context', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    const svc = newService();
    await svc.applySnapshot({ windows: [chrome('w1', ['https://github.com/cyrus/tala']), ghostty('g1', 'zsh /work/tala'), ghostty('g2', 'Spotify')] });
    const view = await svc.view();
    expect(view.contexts[0].windows.map((w) => w.key).sort()).toEqual(['g1', 'w1']);
    expect(view.unsorted.map((w) => w.key)).toEqual(['g2']);
    expect(view.windowControl).toBe(true);
    expect(svc.commands.since(0)).toContainEqual(expect.objectContaining({ type: 'nameWindow', windowKey: 'w1', name: 'tala' }));
  });

  it('a_known_claude_session_title_sorts_a_terminal', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z', 'active', 'sess-1');
    titles = new Map([['sess-1', 'Fix the login bug']]);
    const svc = newService();
    await svc.applySnapshot({ windows: [ghostty('g1', '◐ Fix the login bug')] });
    expect((await svc.view()).contexts[0].windows[0].key).toBe('g1');
  });

  it('owner_assignment_is_never_resorted', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    addAgent('a2', '/work/arki', '2026-01-01T00:01:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    const svc = newService();
    const w = chrome('w1', ['https://github.com/cyrus/tala']);
    await svc.applySnapshot({ windows: [w] });
    const arki = (await svc.view()).contexts[1];
    svc.assign('w1', arki.id);
    await svc.sort();
    await svc.applySnapshot({ windows: [w] });
    const view = await svc.view();
    expect(view.contexts[1].windows.map((x) => x.key)).toEqual(['w1']);
    expect(view.contexts[0].windows).toEqual([]);
  });

  it('manual_assignment_learns_a_rule_that_sorts_future_windows', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    const svc = newService();
    const first = chrome('w1', ['https://notion.so/tala-notes/page']);
    await svc.applySnapshot({ windows: [first] });
    expect((await svc.view()).unsorted).toHaveLength(1);
    const id = (await svc.view()).contexts[0].id;
    svc.assign('w1', id);
    await svc.refresh();
    await svc.applySnapshot({ windows: [first, chrome('w2', ['https://notion.so/tala-notes/other'])] });
    expect((await svc.view()).contexts[0].windows.map((w) => w.key).sort()).toEqual(['w1', 'w2']);
  });

  it('owner_window_name_is_never_overwritten', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    const svc = newService();
    const w = chrome('w1', ['https://github.com/cyrus/tala']);
    await svc.applySnapshot({ windows: [w] });
    svc.renameWindow('w1', 'My own name');
    const before = svc.commands.lastSeq;
    await svc.sort();
    await svc.applySnapshot({ windows: [chrome('w1', ['https://github.com/cyrus/tala'], 'My own name')] });
    await svc.sort();
    const later = svc.commands.since(before).filter((c) => c.type === 'nameWindow');
    expect(later).toEqual([]);
    expect(svc.store.getNames().get('w1')).toMatchObject({ name: 'My own name', set_by: 'owner' });
  });

  it('a_chrome_window_is_asked_to_take_the_context_name_once_not_on_every_snapshot', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    const svc = newService();
    const w = chrome('w1', ['https://example.com/']); // the name never arrives (the browser refused it)
    await svc.applySnapshot({ windows: [w] });
    svc.assign('w1', (await svc.view()).contexts[0].id); // owner-assigned windows are re-checked on every snapshot
    for (let i = 0; i < 3; i++) await svc.applySnapshot({ windows: [w] });
    expect(svc.commands.since(0).filter((c) => c.type === 'nameWindow')).toHaveLength(1);
  });

  it('a_name_set_outside_switchyard_is_treated_as_the_owners', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    const svc = newService();
    await svc.applySnapshot({ windows: [chrome('w1', ['https://github.com/cyrus/tala'], 'Client call')] });
    expect(svc.commands.since(0).filter((c) => c.type === 'nameWindow')).toEqual([]);
    expect(svc.store.getNames().get('w1')?.set_by).toBe('owner');
  });
});

describe('moving a window out of its context', () => {
  it('a_window_the_owner_unsorts_stays_unsorted_through_auto_sort', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    const svc = newService();
    const w = chrome('w1', ['https://github.com/cyrus/tala']);
    await svc.applySnapshot({ windows: [w] });
    expect(contextOf(await svc.view(), 'w1')).toBe('tala');
    svc.unassign('w1');
    await svc.applySnapshot({ windows: [w] });
    await svc.sort();
    const view = await svc.view();
    expect(contextOf(view, 'w1')).toBe(null);
    expect(view.unsorted.map((x) => x.key)).toEqual(['w1']);
  });

  it('unsorting_forgets_the_rule_learned_when_the_window_was_assigned', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    const svc = newService();
    const w1 = chrome('w1', ['https://notion.so/tala-notes/page']);
    await svc.applySnapshot({ windows: [w1] });
    svc.assign('w1', (await svc.view()).contexts[0].id);
    expect(svc.store.listRules()).toHaveLength(1);
    svc.unassign('w1');
    expect(svc.store.listRules()).toEqual([]);
    await svc.refresh();
    await svc.applySnapshot({ windows: [w1, chrome('w2', ['https://notion.so/tala-notes/other'])] });
    expect((await svc.view()).unsorted.map((x) => x.key).sort()).toEqual(['w1', 'w2']);
  });

  it('moving_to_another_context_is_an_owner_choice_that_clears_an_earlier_unsort', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    addAgent('a2', '/work/arki', '2026-01-01T00:01:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    const svc = newService();
    const w = chrome('w1', ['https://github.com/cyrus/tala']);
    await svc.applySnapshot({ windows: [w] });
    svc.unassign('w1');
    const arki = (await svc.view()).contexts[1];
    svc.assign('w1', arki.id);
    await svc.sort();
    await svc.applySnapshot({ windows: [w] });
    expect(contextOf(await svc.view(), 'w1')).toBe('arki');
    expect(svc.store.getAssignments().get('w1')?.source).toBe('owner');
  });
});

describe('naming windows', () => {
  it('only_chrome_windows_can_be_renamed', async () => {
    const svc = newService();
    await svc.applySnapshot({ windows: [ghostty('g1', 'zsh'), chrome('w1', ['https://a.com'])] });
    const before = svc.commands.lastSeq;
    expect(() => svc.renameWindow('g1', 'test')).toThrow(/Only Chrome windows can be renamed/);
    expect(svc.store.getNames().get('g1')).toBeUndefined();
    svc.renameWindow('w1', 'Docs');
    expect(svc.commands.since(before).map((c) => c.type)).toEqual(['nameWindow']);
  });

  it('a_stored_name_on_a_window_that_cannot_be_named_is_ignored', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    const svc = newService();
    svc.store.setName('g1', 'test', 'owner'); // left over from before renames were limited to Chrome
    await svc.applySnapshot({ windows: [ghostty('g1', 'zsh — tala')] });
    const view = await svc.view();
    const row = [...view.unsorted, ...view.contexts.flatMap((c) => c.windows)].find((x) => x.key === 'g1');
    expect(row?.name).toBe(null);
  });
});

describe('terminals follow their Claude session', () => {
  it('a_terminal_opened_in_the_parent_folder_follows_its_session_into_the_child_repo', async () => {
    addAgent('root', '/work', '2026-01-01T00:00:00Z', 'active', 'sess-root');
    addAgent('a1', '/work/tala', '2026-01-01T00:01:00Z', 'active', 'sess-1'); // started in /work, then moved into tala
    titles = new Map([['sess-1', 'Fix the login bug']]);
    const svc = newService();
    await svc.applySnapshot({ windows: [ghostty('g1', '✳ Fix the login bug', '/work'), ghostty('g2', '~/notes', '/work')] });
    const view = await svc.view();
    expect(contextOf(view, 'g1')).toBe('tala');
    expect(contextOf(view, 'g2')).toBe('work');
    expect(view.contexts.flatMap((c) => c.windows).find((w) => w.key === 'g1')?.why).toBe('Claude session "Fix the login bug"');
  });

  it('a_session_started_in_the_parent_is_placed_by_the_files_it_works_on', async () => {
    addAgent('a1', '/work', '2026-01-01T00:00:00Z', 'active', 'sess-1');
    touch('sess-1', '/work/tala/src/app.ts', 6);
    touch('sess-1', '/work/README.md', 1);
    titles = new Map([['sess-1', 'Fix the login bug']]);
    const svc = newService();
    await svc.applySnapshot({ windows: [ghostty('g1', '✳ Fix the login bug', '/work')] });
    const view = await svc.view();
    expect(view.contexts.map((c) => c.folder)).toEqual(['/work/tala']);
    expect(view.contexts[0].agents.map((a) => a.id)).toEqual(['a1']);
    expect(contextOf(view, 'g1')).toBe('tala');
  });

  it('a_session_working_all_over_the_parent_stays_with_the_parent', async () => {
    addAgent('a1', '/work', '2026-01-01T00:00:00Z', 'active', 'sess-1');
    touch('sess-1', '/work/tala/src/app.ts', 4);
    touch('sess-1', '/work/arki/src/app.ts', 4);
    const view = await newService().view();
    expect(view.contexts.map((c) => c.folder)).toEqual(['/work']);
  });

  it('an_auto_sorted_terminal_moves_once_its_session_is_known', async () => {
    addAgent('root', '/work', '2026-01-01T00:00:00Z', 'active', 'sess-root');
    addAgent('a1', '/work/tala', '2026-01-01T00:01:00Z', 'active', 'sess-1');
    const svc = newService();
    await svc.applySnapshot({ windows: [ghostty('g1', '✳ Claude Code', '/work')] });
    expect(contextOf(await svc.view(), 'g1')).toBe('work');
    titles = new Map([['sess-1', 'Fix the login bug']]);
    await svc.applySnapshot({ windows: [ghostty('g1', '✳ Fix the login bug', '/work')] });
    expect(contextOf(await svc.view(), 'g1')).toBe('tala');
  });

  it('a_word_in_a_title_never_moves_a_window_that_is_already_sorted', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    addAgent('a2', '/work/arki', '2026-01-01T00:01:00Z');
    const svc = newService();
    await svc.applySnapshot({ windows: [ghostty('g1', 'zsh', '/work/tala')] });
    await svc.applySnapshot({ windows: [ghostty('g1', 'notes about arki', null)] });
    expect(contextOf(await svc.view(), 'g1')).toBe('tala');
  });

  it('a_hand_assigned_terminal_stays_even_when_its_session_points_elsewhere', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z', 'active', 'sess-1');
    addAgent('a2', '/work/arki', '2026-01-01T00:01:00Z');
    titles = new Map([['sess-1', 'Fix the login bug']]);
    const svc = newService();
    const win = ghostty('g1', '✳ Fix the login bug', '/work/tala');
    await svc.applySnapshot({ windows: [win] });
    const arki = (await svc.view()).contexts[1];
    svc.assign('g1', arki.id);
    await svc.applySnapshot({ windows: [win] });
    await svc.sort();
    const view = await svc.view();
    expect(contextOf(view, 'g1')).toBe('arki');
    expect(view.contexts[1].windows[0].why).toBe('assigned by you');
  });
});

describe('browser windows without readable tabs', () => {
  it('the_title_sorts_the_window_and_the_view_says_why', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    const svc = newService();
    await svc.applySnapshot({ windows: [chromeTitleOnly('w1', 'GitHub - cyrus/tala: tutor · GitHub'), chromeTitleOnly('w2', 'Page not found · GitHub')] });
    const view = await svc.view();
    expect(view.contexts[0].windows.map((w) => [w.key, w.why])).toEqual([['w1', 'title names repo cyrus/tala']]);
    expect(view.unsorted.map((w) => [w.key, w.why])).toEqual([['w2', null]]);
  });

  it('a_sorted_browser_window_stays_put_when_the_active_tab_changes', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    addAgent('a2', '/work/arki', '2026-01-01T00:01:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    patternsByFolder['/work/arki'] = ['github.com/cyrus/arki'];
    const svc = newService();
    await svc.applySnapshot({ windows: [chromeTitleOnly('w1', 'cyrus/tala · GitHub')] });
    await svc.applySnapshot({ windows: [chromeTitleOnly('w1', 'cyrus/arki · GitHub')] });
    expect(contextOf(await svc.view(), 'w1')).toBe('tala');
  });

  it('an_owner_wide_rule_stored_earlier_no_longer_catches_every_repo', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    const svc = newService();
    const id = (await svc.view()).contexts[0].id;
    svc.store.learnRule('github.com/cyrus', id);
    await svc.applySnapshot({ windows: [chrome('w1', ['https://github.com/cyrus/something-else'])] });
    expect((await svc.view()).unsorted.map((w) => w.key)).toEqual(['w1']);
  });

  it('assigning_a_github_tab_by_hand_learns_that_repo_only', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    const svc = newService();
    await svc.applySnapshot({ windows: [chrome('w1', ['https://github.com/cyrus/side-thing/pulls'])] });
    svc.assign('w1', (await svc.view()).contexts[0].id);
    await svc.refresh();
    await svc.applySnapshot({ windows: [
      chrome('w1', ['https://github.com/cyrus/side-thing/pulls']),
      chrome('w2', ['https://github.com/cyrus/side-thing/issues/3']),
      chrome('w3', ['https://github.com/cyrus/unrelated']),
    ] });
    const view = await svc.view();
    expect(view.contexts[0].windows.map((w) => w.key).sort()).toEqual(['w1', 'w2']);
    expect(view.unsorted.map((w) => w.key)).toEqual(['w3']);
  });
});

describe('switch, park, restore', () => {
  it('switch_shows_only_the_contexts_windows', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    const svc = newService();
    await svc.applySnapshot({ windows: [chrome('w1', ['https://github.com/cyrus/tala']), ghostty('g1', 'Spotify')] });
    const id = (await svc.view()).contexts[0].id;
    const cmd = svc.switchTo(id);
    expect(cmd).toMatchObject({ type: 'show', contextId: id, windowKeys: ['w1'] });
    expect((await svc.view()).activeContextId).toBe(id);
  });

  it('show_lists_the_windows_of_other_contexts_to_hide_and_leaves_unsorted_ones_alone', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    addAgent('a2', '/work/arki', '2026-01-01T00:01:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    patternsByFolder['/work/arki'] = ['github.com/cyrus/arki'];
    const svc = newService();
    await svc.applySnapshot({ windows: [
      chrome('w1', ['https://github.com/cyrus/tala']), chrome('w2', ['https://github.com/cyrus/arki']), ghostty('g1', 'Spotify'),
    ] });
    const tala = (await svc.view()).contexts[0].id;
    expect(svc.switchTo(tala)).toMatchObject({ type: 'show', windowKeys: ['w1'], hideKeys: ['w2'], focus: true });
  });

  it('a_newly_sorted_window_reshows_the_active_context_without_taking_focus', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    addAgent('a2', '/work/arki', '2026-01-01T00:01:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    patternsByFolder['/work/arki'] = ['github.com/cyrus/arki'];
    const svc = newService();
    const w1 = chrome('w1', ['https://github.com/cyrus/tala']);
    await svc.applySnapshot({ windows: [w1] });
    svc.switchTo((await svc.view()).contexts[0].id);
    await svc.applySnapshot({ windows: [w1, chrome('w2', ['https://github.com/cyrus/arki'])] });
    const shows = svc.commands.since(0).filter((c) => c.type === 'show');
    expect(shows.at(-1)).toMatchObject({ windowKeys: ['w1'], hideKeys: ['w2'], focus: false });
  });

  it('show_all_clears_the_active_context_so_nothing_is_hidden_again', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    addAgent('a2', '/work/arki', '2026-01-01T00:01:00Z');
    patternsByFolder['/work/arki'] = ['github.com/cyrus/arki'];
    const svc = newService();
    await svc.applySnapshot({ windows: [] });
    svc.switchTo((await svc.view()).contexts[0].id);
    expect(svc.showAll()).toMatchObject({ type: 'showAll' });
    expect((await svc.view()).activeContextId).toBeNull();
    const before = svc.commands.lastSeq;
    await svc.applySnapshot({ windows: [chrome('w2', ['https://github.com/cyrus/arki'])] });
    expect(svc.commands.since(before).filter((c) => c.type === 'show')).toEqual([]);
  });

  it('switch_park_restore_and_sort_are_refused_while_the_mac_app_is_not_reporting_windows', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    let clock = Date.parse('2026-01-01T01:00:00Z');
    const svc = new ContextsService({ db, listAgents: getAgents, signals, now: () => clock, autoContextWindowMs: Infinity });
    const id = (await svc.view()).contexts[0].id;
    const before = svc.commands.lastSeq;
    for (const run of [() => svc.switchTo(id), () => svc.park(id), () => svc.restore(id)]) {
      expect(run).toThrow(/Mac app isn't reporting windows/);
    }
    await expect(svc.sort()).rejects.toThrow(/Mac app isn't reporting windows/);
    expect(svc.commands.lastSeq).toBe(before); // nothing queued that would fire later
    expect((await svc.view()).contexts[0].status).not.toBe('parked');

    await svc.applySnapshot({ windows: [] });
    expect(svc.switchTo(id)).toMatchObject({ type: 'show' });
    clock += 60_000; // the app went quiet
    expect(() => svc.switchTo(id)).toThrow(/Mac app isn't reporting windows/);
  });

  it('a_command_the_app_could_not_carry_out_is_shown_until_one_works', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    const svc = newService();
    await svc.applySnapshot({ windows: [] });
    const id = (await svc.view()).contexts[0].id;
    expect((await svc.view()).lastFailure).toBeNull();
    svc.ack(svc.switchTo(id).seq, false, 'window not found');
    expect((await svc.view()).lastFailure).toMatchObject({ action: 'show', error: 'window not found' });
    svc.ack(svc.switchTo(id).seq, true, null);
    expect((await svc.view()).lastFailure).toBeNull();
  });

  it('park_saves_tabs_before_close_commands', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    const svc = newService();
    await svc.applySnapshot({ windows: [chrome('w1', ['https://github.com/cyrus/tala', 'https://mail.google.com'])] });
    const id = (await svc.view()).contexts[0].id;
    const seenAtClose: number[] = [];
    svc.commands.onEnqueue((c) => {
      if (c.type === 'closeWindow') seenAtClose.push(svc.store.listParked(id).length);
    });
    expect(svc.park(id)).toEqual({ parkedWindows: 1 });
    expect(seenAtClose).toEqual([1]);
    const [saved] = svc.store.listParked(id);
    expect(saved.urls).toEqual(['https://github.com/cyrus/tala', 'https://mail.google.com']);
    const view = await svc.view();
    expect(view.contexts[0].status).toBe('parked');
    expect(view.contexts[0].parkedWindowCount).toBe(1);
  });

  it('restore_reopens_saved_windows_and_keeps_them_until_the_app_acks', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    const svc = newService();
    await svc.applySnapshot({ windows: [chrome('w1', ['https://github.com/cyrus/tala'])] });
    const id = (await svc.view()).contexts[0].id;
    svc.park(id);
    const before = svc.commands.lastSeq;
    expect(svc.restore(id)).toEqual({ restoredWindows: 1 });
    const open = svc.commands.since(before).find((c) => c.type === 'openWindow');
    expect(open).toMatchObject({ browser: 'Google Chrome', urls: ['https://github.com/cyrus/tala'], contextId: id });
    expect(svc.store.listParked(id)).toHaveLength(1);
    svc.ack(open!.seq, false, 'chrome not running');
    expect(svc.store.listParked(id)).toHaveLength(1);
  });

  it('acked_restore_clears_the_saved_windows', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    const svc = newService();
    await svc.applySnapshot({ windows: [chrome('w1', ['https://github.com/cyrus/tala'])] });
    const id = (await svc.view()).contexts[0].id;
    svc.park(id);
    svc.restore(id);
    const open = svc.commands.since(0).filter((c) => c.type === 'openWindow').pop()!;
    svc.ack(open.seq, true, null);
    expect(svc.store.listParked(id)).toHaveLength(0);
  });

  it('a_restored_topic_window_with_generic_tabs_stays_in_its_topic', async () => {
    const svc = newService();
    const search = 'https://www.google.com/search?q=receipts';
    await svc.applySnapshot({ windows: [chrome('w1', [search])] });
    const topic = svc.createTopic('Taxes');
    svc.assign('w1', topic.id);
    svc.park(topic.id);
    await svc.applySnapshot({ windows: [] });
    const before = svc.commands.lastSeq;
    svc.restore(topic.id);
    const open = svc.commands.since(before).find((c) => c.type === 'openWindow')!;
    svc.ack(open.seq, true, null);
    await svc.applySnapshot({ windows: [chrome('w9', [search], 'Taxes')] });
    expect(contextOf(await svc.view(), 'w9')).toBe('Taxes');
  });

  it('a_window_that_was_already_open_is_not_taken_for_a_restored_one', async () => {
    const svc = newService();
    const search = 'https://www.google.com/search?q=receipts';
    await svc.applySnapshot({ windows: [chrome('w1', [search]), chrome('other', [search], 'Taxes')] });
    const topic = svc.createTopic('Taxes');
    svc.assign('w1', topic.id);
    svc.park(topic.id);
    svc.restore(topic.id);
    await svc.applySnapshot({ windows: [chrome('other', [search], 'Taxes')] });
    expect(contextOf(await svc.view(), 'other')).toBeNull();
  });

  it('a_failed_restore_open_claims_no_window', async () => {
    const svc = newService();
    const search = 'https://www.google.com/search?q=receipts';
    await svc.applySnapshot({ windows: [chrome('w1', [search])] });
    const topic = svc.createTopic('Taxes');
    svc.assign('w1', topic.id);
    svc.park(topic.id);
    await svc.applySnapshot({ windows: [] });
    const before = svc.commands.lastSeq;
    svc.restore(topic.id);
    svc.ack(svc.commands.since(before).find((c) => c.type === 'openWindow')!.seq, false, 'chrome not running');
    await svc.applySnapshot({ windows: [chrome('w9', [search], 'Taxes')] });
    expect(contextOf(await svc.view(), 'w9')).toBeNull();
  });

  it('switching_to_a_parked_context_is_rejected', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    const svc = newService();
    await svc.applySnapshot({ windows: [] }); // the Mac app is connected
    const id = (await svc.view()).contexts[0].id;
    svc.park(id);
    expect(() => svc.switchTo(id)).toThrow(/parked/);
  });
});

describe('contexts management', () => {
  it('a_key_held_by_another_context_is_swapped_with_it', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    addAgent('a2', '/work/arki', '2026-01-01T00:01:00Z');
    const svc = newService();
    const [first, second] = (await svc.view()).contexts;
    expect(svc.patchContext(second.id, { key: first.key }).key).toBe(first.key);
    expect(svc.store.getContext(first.id)?.key).toBe(second.key);
    expect(svc.patchContext(second.id, { key: null }).key).toBeNull();
  });

  it('topic_contexts_have_no_folder_and_take_the_next_free_key', async () => {
    const svc = newService();
    const topic = svc.createTopic('Taxes');
    expect(topic).toMatchObject({ name: 'Taxes', folder: null, key: 1 });
  });

  it('accepting_a_suggestion_opens_the_tab_in_the_target_then_closes_the_source', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    addAgent('a2', '/work/arki', '2026-01-01T00:01:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    patternsByFolder['/work/arki'] = ['github.com/cyrus/shea-coach'];
    const svc = newService();
    const w1 = chrome('w1', ['https://github.com/cyrus/shea-coach', 'https://github.com/cyrus/shea-coach/pulls', 'https://github.com/cyrus/tala']);
    const w2 = chrome('w2', ['https://github.com/cyrus/tala/issues']);
    await svc.applySnapshot({ windows: [w1, w2] });
    const view = await svc.view();
    expect(view.suggestions).toHaveLength(1);
    const before = svc.commands.lastSeq;
    await svc.acceptSuggestion(view.suggestions[0].id);
    const cmds = svc.commands.since(before);
    expect(cmds[0]).toMatchObject({ type: 'openTab', windowKey: 'w2', url: 'https://github.com/cyrus/tala' });
    expect(cmds.some((c) => c.type === 'closeTab')).toBe(false);
    svc.ack(cmds[0].seq, true, null);
    expect(svc.commands.since(cmds[0].seq).find((c) => c.type === 'closeTab')).toMatchObject({ windowKey: 'w1', tabId: 2 });
    await expect(svc.acceptSuggestion('nope')).rejects.toThrow(/not found/);
  });

  it('the_same_url_in_two_tabs_gives_two_suggestions_that_each_close_their_own_tab', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    addAgent('a2', '/work/arki', '2026-01-01T00:01:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    patternsByFolder['/work/arki'] = ['github.com/cyrus/shea-coach'];
    const svc = newService();
    const arki = ['https://github.com/cyrus/shea-coach', 'https://github.com/cyrus/shea-coach/pulls', 'https://github.com/cyrus/shea-coach/issues'];
    const w1 = chrome('w1', [...arki, 'https://github.com/cyrus/tala', 'https://github.com/cyrus/tala']);
    await svc.applySnapshot({ windows: [w1, chrome('w2', ['https://github.com/cyrus/tala/issues'])] });
    const ids = (await svc.view()).suggestions.map((s) => s.id);
    expect(ids).toHaveLength(2);
    const before = svc.commands.lastSeq;
    await svc.acceptSuggestion(ids[1]);
    const open = svc.commands.since(before).find((c) => c.type === 'openTab')!;
    svc.ack(open.seq, true, null);
    expect(svc.commands.since(open.seq).find((c) => c.type === 'closeTab')).toMatchObject({ windowKey: 'w1', tabId: 4 });
  });

  it('a_failed_target_open_keeps_the_source_tab', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    addAgent('a2', '/work/arki', '2026-01-01T00:01:00Z');
    patternsByFolder['/work/tala'] = ['github.com/cyrus/tala'];
    patternsByFolder['/work/arki'] = ['github.com/cyrus/shea-coach'];
    const svc = newService();
    const w1 = chrome('w1', ['https://github.com/cyrus/shea-coach', 'https://github.com/cyrus/shea-coach/pulls', 'https://github.com/cyrus/tala']);
    await svc.applySnapshot({ windows: [w1, chrome('w2', ['https://github.com/cyrus/tala/issues'])] });
    const before = svc.commands.lastSeq;
    await svc.acceptSuggestion((await svc.view()).suggestions[0].id);
    const open = svc.commands.since(before).find((c) => c.type === 'openTab')!;
    svc.ack(open.seq, false, 'window not found');
    expect(svc.commands.since(before).some((c) => c.type === 'closeTab')).toBe(false);
    expect((await svc.view()).lastFailure).toMatchObject({ action: 'openTab' });
  });
});

describe('view notifications', () => {
  it('subscribers_hear_about_changes_once', async () => {
    addAgent('a1', '/work/tala', '2026-01-01T00:00:00Z');
    const svc = newService();
    const seen: unknown[] = [];
    svc.subscribe((v) => seen.push(v));
    svc.scheduleEmit();
    svc.scheduleEmit();
    await new Promise((r) => setTimeout(r, 600));
    expect(seen).toHaveLength(1);
    svc.stop();
  });
});
