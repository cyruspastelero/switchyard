import { describe, it, expect, afterAll, beforeEach } from '../support/harness.ts';
import { setupTestDb, teardownTestDb } from '../helpers.ts';
import type { SignalSource } from '../../src/contexts/signals.ts';
import type { Snapshot, SnapshotWindow } from '../../src/contexts/types.ts';

const tmpDir = setupTestDb();
const { getDb, getAgents } = await import('../../src/db.ts');
const { ContextsService } = await import('../../src/contexts/service.ts');

const db = getDb();
const signals: SignalSource = {
  folderRoot: async (cwd) => cwd,
  patterns: async () => [],
  sessionTitles: async () => new Map(),
};

type Service = InstanceType<typeof ContextsService>;

function newService(): Service {
  return new ContextsService({ db, listAgents: getAgents, signals, autoContextWindowMs: Infinity });
}

function win(key: string, desktop: number | null): SnapshotWindow {
  return { key, app: 'Ghostty', bundleId: 'com.mitchellh.ghostty', pid: 2, title: key, document: null, browser: null, desktop };
}

function snap(windows: SnapshotWindow[], active = 1, count = 6): Snapshot {
  return { windows, desktops: { count, active }, canCarry: true };
}

/** Contexts with the given keys, each owning the listed windows (assigned by the owner). */
async function setup(svc: Service, layout: Record<number, string[]>, snapshot: Snapshot): Promise<Record<number, string>> {
  await svc.applySnapshot(snapshot);
  const ids: Record<number, string> = {};
  for (const [key, windows] of Object.entries(layout)) {
    const row = svc.createTopic(`ctx${key}`);
    svc.patchContext(row.id, { key: Number(key) });
    ids[Number(key)] = row.id;
    for (const w of windows) svc.assign(w, row.id);
  }
  return ids;
}

function last<T extends { type: string }>(svc: Service, type: string): (T & Record<string, unknown>) | undefined {
  return [...svc.commands.since(0)].reverse().find((c) => c.type === type) as (T & Record<string, unknown>) | undefined;
}

new ContextsService({ db, listAgents: getAgents, signals }); // creates the tables

beforeEach(() => {
  db.exec('DELETE FROM context_rules; DELETE FROM window_assignments; DELETE FROM window_names; DELETE FROM parked_windows; DELETE FROM contexts; DELETE FROM agents; DELETE FROM events;');
});
afterAll(() => teardownTestDb(tmpDir));

describe('switching with real desktops', () => {
  it('a_context_alone_on_its_desktop_hides_nothing_and_names_its_desktop', async () => {
    const svc = newService();
    const ids = await setup(svc, { 1: ['a'], 2: ['b'] }, snap([win('a', 1), win('b', 2)]));
    svc.switchTo(ids[2]);
    expect(last(svc, 'show')).toMatchObject({ contextId: ids[2], windowKeys: ['b'], hideKeys: [], desktop: 2 });
  });

  it('two_contexts_on_the_shared_desktop_hide_each_other', async () => {
    const svc = newService();
    const ids = await setup(svc, { 1: ['a'], 6: ['f'], 7: ['g'] }, snap([win('a', 1), win('f', 6), win('g', 6)]));
    svc.switchTo(ids[6]);
    expect(last(svc, 'show')).toMatchObject({ windowKeys: ['f'], hideKeys: ['g'], desktop: 6 });
    svc.switchTo(ids[7]);
    expect(last(svc, 'show')).toMatchObject({ windowKeys: ['g'], hideKeys: ['f'], desktop: 6 });
  });

  it('unsorted_windows_never_appear_in_hide_keys_or_moves', async () => {
    const svc = newService();
    const ids = await setup(svc, { 6: ['f'], 7: ['g'] }, snap([win('f', 6), win('g', 2), win('u', 3)]));
    svc.switchTo(ids[6]);
    expect(last(svc, 'show')?.hideKeys).not.toContain('u');
    await svc.sort();
    const moves = (last(svc, 'moveWindows')?.moves ?? []) as { windowKey: string }[];
    expect(moves.map((m) => m.windowKey)).not.toContain('u');
  });

  it('without_desktops_the_show_command_is_the_same_as_before', async () => {
    const svc = newService();
    const ids = await setup(svc, { 1: ['a'], 2: ['b'] }, { windows: [win('a', null), win('b', null)], desktops: null });
    svc.switchTo(ids[1]);
    const show = last(svc, 'show');
    expect(show).toMatchObject({ windowKeys: ['a'], hideKeys: ['b'] });
    expect(show).not.toHaveProperty('desktop');
    await svc.sort();
    expect(last(svc, 'moveWindows')).toBeUndefined();
  });

  it('a_failed_carry_switches_off_desktop_mode_and_hides_off_screen', async () => {
    const svc = newService();
    const ids = await setup(svc, { 1: ['a'], 2: ['b'] }, { ...snap([win('a', 1), win('b', 1)]), canCarry: false });
    svc.switchTo(ids[1]);
    expect(last(svc, 'show')).toMatchObject({ hideKeys: ['b'] });
    const view = await svc.view();
    expect(view.desktopMode).toBe('offscreen');
    expect(view.desktopNote).toMatch(/off-screen/);
  });
});

describe('sorting onto desktops', () => {
  it('sort_moves_each_misplaced_window_to_its_contexts_desktop', async () => {
    const svc = newService();
    await setup(svc, { 1: ['a'], 2: ['b'], 7: ['g'] }, snap([win('a', 3), win('b', 2), win('g', 1)]));
    const result = await svc.sort();
    expect(last(svc, 'moveWindows')?.moves).toEqual([{ windowKey: 'a', desktop: 1 }, { windowKey: 'g', desktop: 6 }]);
    expect(result).toMatchObject({ toMove: 2 });
  });

  it('nothing_misplaced_queues_no_move', async () => {
    const svc = newService();
    await setup(svc, { 1: ['a'] }, snap([win('a', 1)]));
    await svc.sort();
    expect(last(svc, 'moveWindows')).toBeUndefined();
  });

  it('an_owner_assigned_window_goes_to_its_owners_desktop_and_is_never_rematched', async () => {
    const svc = newService();
    const ids = await setup(svc, { 1: [], 3: ['t'] }, snap([win('t', 1)]));
    await svc.sort();
    expect(last(svc, 'moveWindows')?.moves).toEqual([{ windowKey: 't', desktop: 3 }]);
    const view = await svc.view();
    expect(view.contexts.find((c) => c.id === ids[3])?.windows.map((w) => w.key)).toEqual(['t']);
  });

  it('a_new_window_on_the_wrong_desktop_is_assigned_but_not_carried_and_counted_to_sort', async () => {
    const svc = newService();
    await setup(svc, { 1: ['a'], 2: [] }, snap([win('a', 2)]));
    const seq = svc.commands.lastSeq; // the owner's Move in setup carries; a snapshot never does
    await svc.applySnapshot(snap([win('a', 2)]));
    expect(svc.commands.since(seq).filter((c) => c.type === 'moveWindows')).toHaveLength(0);
    const view = await svc.view();
    expect(view.toSort).toBe(1);
    expect(view.desktopMode).toBe('desktops');
  });

  it('a_window_that_could_not_be_carried_is_hidden_off_screen_where_it_sits', async () => {
    const svc = newService();
    const ids = await setup(svc, { 1: ['a'], 2: ['b'] }, snap([win('a', 1), win('b', 1)]));
    await svc.sort();
    const move = last(svc, 'moveWindows') as { seq: number };
    svc.ack(move.seq, false, 'moved 0, could not move 1: b: no grab point', ['b']);
    expect((await svc.view()).lastFailure?.error).toMatch(/could not move 1/);
    svc.switchTo(ids[1]);
    expect(last(svc, 'show')).toMatchObject({ windowKeys: ['a'], hideKeys: ['b'], desktop: 1 });
  });
});

describe('the dashboard and menu view', () => {
  it('each_context_shows_its_desktop_and_whether_it_is_shared', async () => {
    const svc = newService();
    const ids = await setup(svc, { 1: [], 5: [], 6: [], 9: [] }, snap([]));
    const view = await svc.view();
    const byId = new Map(view.contexts.map((c) => [c.id, c]));
    expect(byId.get(ids[1])).toMatchObject({ desktop: 1, desktopShared: false });
    expect(byId.get(ids[5])).toMatchObject({ desktop: 5, desktopShared: false });
    expect(byId.get(ids[6])).toMatchObject({ desktop: 6, desktopShared: true });
    expect(byId.get(ids[9])).toMatchObject({ desktop: 6, desktopShared: true });
    expect(view.desktops).toEqual({ count: 6, active: 1 });
  });

  it('landing_on_a_desktop_one_context_owns_makes_it_active', async () => {
    const svc = newService();
    const ids = await setup(svc, { 1: ['a'], 2: ['b'] }, snap([win('a', 1), win('b', 2)], 1));
    await svc.applySnapshot(snap([win('a', 1), win('b', 2)], 2));
    expect((await svc.view()).activeContextId).toBe(ids[2]);
  });

  it('landing_on_the_shared_desktop_with_two_contexts_changes_nothing', async () => {
    const svc = newService();
    const ids = await setup(svc, { 1: ['a'], 6: ['f'], 7: ['g'] }, snap([win('a', 1), win('f', 6), win('g', 6)], 1));
    svc.switchTo(ids[1]);
    await svc.applySnapshot(snap([win('a', 1), win('f', 6), win('g', 6)], 6));
    expect((await svc.view()).activeContextId).toBe(ids[1]);
  });

  it('restore_goes_to_the_desktop_before_reopening_windows', async () => {
    const svc = newService();
    const c: SnapshotWindow = { ...win('c', 2), app: 'Google Chrome', bundleId: 'com.google.Chrome',
      browser: { windowId: 'c', name: null, tabs: [{ id: 1, url: 'https://a.test', title: 'a' }] } };
    const ids = await setup(svc, { 1: [], 2: ['c'] }, snap([c], 1));
    svc.park(ids[2]);
    const before = svc.commands.lastSeq;
    svc.restore(ids[2]);
    const types = svc.commands.since(before).map((c) => c.type);
    expect(types.indexOf('show')).toBeLessThan(types.indexOf('openWindow'));
    expect(last(svc, 'show')).toMatchObject({ desktop: 2 });
  });
});

describe('choosing a context desktop', () => {
  const keyOf = (svc: Service, id: string) => svc.store.getContext(id)?.key;

  it('taking_a_key_another_context_holds_swaps_the_two_keys', async () => {
    const svc = newService();
    const ids = await setup(svc, { 1: [], 2: [] }, snap([]));
    svc.patchContext(ids[1], { key: 2 });
    expect(keyOf(svc, ids[1])).toBe(2);
    expect(keyOf(svc, ids[2])).toBe(1);
  });

  it('after_a_swap_both_contexts_windows_are_carried_to_their_new_desktops_and_nothing_else', async () => {
    const svc = newService();
    const ids = await setup(svc, { 1: ['a'], 2: ['b'], 3: ['c'] }, snap([win('a', 1), win('b', 2), win('c', 3), win('u', 1)]));
    svc.patchContext(ids[2], { key: 1 });
    const moves = (last(svc, 'moveWindows')?.moves ?? []) as { windowKey: string; desktop: number }[];
    expect([...moves].sort((x, y) => x.windowKey.localeCompare(y.windowKey))).toEqual([
      { windowKey: 'a', desktop: 2 }, { windowKey: 'b', desktop: 1 },
    ]);
  });

  it('no_desktop_frees_it_and_the_windows_go_to_the_shared_desktop', async () => {
    const svc = newService();
    const ids = await setup(svc, { 2: ['b'] }, snap([win('b', 2)]));
    svc.patchContext(ids[2], { key: null });
    expect(keyOf(svc, ids[2])).toBeNull();
    expect(last(svc, 'moveWindows')?.moves).toEqual([{ windowKey: 'b', desktop: 6 }]);
  });

  it('a_minimized_window_is_left_where_it_is_like_sort_does', async () => {
    const svc = newService();
    const ids = await setup(svc, { 2: ['b', 'm'] }, snap([win('b', 2), win('m', null)]));
    svc.patchContext(ids[2], { key: 3 });
    expect(last(svc, 'moveWindows')?.moves).toEqual([{ windowKey: 'b', desktop: 3 }]);
  });

  it('the_same_key_again_carries_nothing', async () => {
    const svc = newService();
    const ids = await setup(svc, { 2: ['b'] }, snap([win('b', 2)]));
    const before = svc.commands.lastSeq;
    svc.patchContext(ids[2], { key: 2 });
    expect(svc.commands.since(before).filter((c) => c.type === 'moveWindows')).toEqual([]);
  });

  it('without_the_mac_app_the_keys_still_swap_but_nothing_is_queued', async () => {
    let now = Date.parse('2026-11-23T10:00:00Z');
    const svc = new ContextsService({ db, listAgents: getAgents, signals, autoContextWindowMs: Infinity, now: () => now });
    const ids = await setup(svc, { 1: ['a'], 2: ['b'] }, snap([win('a', 1), win('b', 2)]));
    now += 60_000;
    const before = svc.commands.lastSeq;
    svc.patchContext(ids[1], { key: 2 });
    expect(keyOf(svc, ids[2])).toBe(1);
    expect(svc.commands.since(before)).toEqual([]);
  });
});
