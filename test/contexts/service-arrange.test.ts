// Arranging v2: show filter, Move carries, Sort sweeps, Tidy. Spec: "Arranging (layout) — v2" + its Contract.
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
type Cmd = Record<string, unknown> & { type: string; seq: number };

const newService = (): Service => new ContextsService({ db, listAgents: getAgents, signals, autoContextWindowMs: Infinity });

function win(key: string, desktop: number | null): SnapshotWindow {
  return { key, app: 'Ghostty', bundleId: 'com.mitchellh.ghostty', pid: 2, title: key, document: null, browser: null, desktop };
}

function snap(windows: SnapshotWindow[], active = 1, count = 6): Snapshot {
  return { windows, desktops: { count, active }, canCarry: true };
}

/** Contexts with the given keys owning the listed windows. Commands queued by setup are not looked at. */
async function setup(svc: Service, layout: Record<number, string[]>, snapshot: Snapshot): Promise<Record<number, string>> {
  await svc.applySnapshot(snapshot);
  const ids: Record<number, string> = {};
  for (const [key, windows] of Object.entries(layout)) {
    const row = svc.createTopic(`ctx${key}`);
    svc.patchContext(row.id, { key: Number(key) });
    ids[Number(key)] = row.id;
    for (const w of windows) svc.assign(w, row.id);
  }
  await svc.applySnapshot(snapshot);
  return ids;
}

const after = (svc: Service, seq: number, type?: string): Cmd[] =>
  (svc.commands.since(seq) as unknown as Cmd[]).filter((c) => !type || c.type === type);
const last = (svc: Service, type: string): Cmd | undefined => after(svc, 0, type).at(-1);

new ContextsService({ db, listAgents: getAgents, signals }); // creates the tables

beforeEach(() => {
  db.exec('DELETE FROM context_rules; DELETE FROM window_assignments; DELETE FROM window_unsorted; DELETE FROM window_names; DELETE FROM window_last_seen; DELETE FROM parked_windows; DELETE FROM contexts; DELETE FROM context_settings;');
});
afterAll(() => teardownTestDb(tmpDir));

describe('window desktop in the view', () => {
  it('a_window_on_desktop_1_in_a_key_2_context_is_a_stray', async () => {
    const svc = newService();
    const ids = await setup(svc, { 2: ['a', 'b'] }, snap([win('a', 1), win('b', 2)]));
    const ctx = (await svc.view()).contexts.find((c) => c.id === ids[2]);
    expect(ctx?.windows.find((w) => w.key === 'a')?.desktop).toBe(1);
    expect(ctx?.strays).toBe(1);
  });

  it('off_screen_mode_has_no_desktops_and_no_strays', async () => {
    const svc = newService();
    const ids = await setup(svc, { 2: ['a'] }, { windows: [win('a', null)], desktops: null });
    const ctx = (await svc.view()).contexts.find((c) => c.id === ids[2]);
    expect(ctx?.windows[0].desktop).toBeNull();
    expect(ctx?.strays).toBe(0);
  });
});

describe('show raises only what is on the target desktop', () => {
  it('a_window_on_another_desktop_is_a_stray_not_raised_or_hidden', async () => {
    const svc = newService();
    const ids = await setup(svc, { 2: ['a', 'b', 'c'] }, snap([win('a', 2), win('b', 2), win('c', 1)]));
    svc.switchTo(ids[2]);
    const show = last(svc, 'show');
    expect(show).toMatchObject({ windowKeys: ['a', 'b'], strayKeys: ['c'], hideKeys: [], desktop: 2 });
  });

  it('a_window_with_no_known_desktop_is_a_stray_in_desktop_mode', async () => {
    const svc = newService();
    const ids = await setup(svc, { 2: ['a', 'm'] }, snap([win('a', 2), win('m', null)]));
    svc.switchTo(ids[2]);
    expect(last(svc, 'show')).toMatchObject({ windowKeys: ['a'], strayKeys: ['m'] });
  });

  it('off_screen_mode_raises_every_window_and_sends_no_strays', async () => {
    const svc = newService();
    const ids = await setup(svc, { 2: ['a', 'b', 'c'] }, { windows: [win('a', null), win('b', null), win('c', null)], desktops: null });
    svc.switchTo(ids[2]);
    const show = last(svc, 'show');
    expect(show?.windowKeys).toEqual(['a', 'b', 'c']);
    expect(show).not.toHaveProperty('strayKeys');
  });
});

describe('Move carries the window at once', () => {
  it('assigning_a_window_on_desktop_1_to_a_key_2_context_carries_it_and_tidies_both', async () => {
    const svc = newService();
    const ids = await setup(svc, { 1: ['x'], 2: ['b'] }, snap([win('x', 1), win('a', 1), win('b', 2)]));
    const seq = svc.commands.lastSeq;
    const result = svc.assign('a', ids[2]);
    expect(result).toEqual({ moving: true, desktop: 2 });
    expect(after(svc, seq, 'moveWindows').map((c) => c.moves)).toEqual([[{ windowKey: 'a', desktop: 2 }]]);
    const tidy = after(svc, seq, 'tidy');
    expect(tidy).toHaveLength(1);
    expect(tidy[0]).toMatchObject({ force: false, desktops: [{ desktop: 1, windowKeys: ['x'] }, { desktop: 2, windowKeys: ['a', 'b'] }] });
    const types = after(svc, seq).map((c) => c.type);
    expect(types.indexOf('moveWindows')).toBeLessThan(types.indexOf('tidy'));
  });

  it('a_window_already_on_the_desktop_is_not_carried', async () => {
    const svc = newService();
    const ids = await setup(svc, { 2: [] }, snap([win('a', 2)]));
    const seq = svc.commands.lastSeq;
    expect(svc.assign('a', ids[2])).toEqual({ moving: false, desktop: 2 });
    expect(after(svc, seq, 'moveWindows')).toHaveLength(0);
  });

  it('moving_to_unsorted_carries_to_the_last_desktop_unless_it_is_there', async () => {
    const svc = newService();
    await setup(svc, { 2: ['a', 'f'] }, snap([win('a', 2), win('f', 6)]));
    const seq = svc.commands.lastSeq;
    expect(svc.unassign('a')).toEqual({ moving: true, desktop: 6 });
    expect(after(svc, seq, 'moveWindows').map((c) => c.moves)).toEqual([[{ windowKey: 'a', desktop: 6 }]]);
    const seq2 = svc.commands.lastSeq;
    expect(svc.unassign('f')).toEqual({ moving: false, desktop: 6 });
    expect(after(svc, seq2, 'moveWindows')).toHaveLength(0);
  });

  it('off_screen_mode_and_unknown_desktops_never_carry', async () => {
    const svc = newService();
    const ids = await setup(svc, { 2: [] }, { windows: [win('a', null)], desktops: null });
    expect(svc.assign('a', ids[2])).toEqual({ moving: false, desktop: null });
    db.exec('DELETE FROM window_assignments; DELETE FROM contexts;');
    const svc2 = newService();
    const ids2 = await setup(svc2, { 2: [] }, snap([win('m', null)]));
    const seq = svc2.commands.lastSeq;
    expect(svc2.assign('m', ids2[2])).toEqual({ moving: false, desktop: 2 });
    expect(after(svc2, seq, 'moveWindows')).toHaveLength(0);
  });

  it('the_owner_stays_where_they_are', async () => {
    const svc = newService();
    const ids = await setup(svc, { 1: ['x'], 2: [] }, snap([win('x', 1), win('a', 1)]));
    svc.switchTo(ids[1]);
    const seq = svc.commands.lastSeq;
    svc.assign('a', ids[2]);
    expect((await svc.view()).activeContextId).toBe(ids[1]);
    expect(after(svc, seq, 'show').every((c) => c.focus === false)).toBe(true);
  });

  it('with_auto_tidy_off_a_move_sends_no_tidy', async () => {
    const svc = newService();
    const ids = await setup(svc, { 2: [] }, snap([win('a', 1)]));
    svc.setSettings({ autoTidy: false });
    const seq = svc.commands.lastSeq;
    svc.assign('a', ids[2]);
    expect(after(svc, seq, 'moveWindows')).toHaveLength(1);
    expect(after(svc, seq, 'tidy')).toHaveLength(0);
  });

  it('a_failed_carry_keeps_the_assignment_and_counts_a_stray', async () => {
    const svc = newService();
    const ids = await setup(svc, { 2: [] }, snap([win('a', 1)]));
    svc.assign('a', ids[2]);
    const move = last(svc, 'moveWindows') as Cmd;
    svc.ack(move.seq, false, 'could not move 1', ['a']);
    const ctx = (await svc.view()).contexts.find((c) => c.id === ids[2]);
    expect(ctx?.windows.map((w) => w.key)).toEqual(['a']);
    expect(ctx?.strays).toBe(1);
  });
});

describe('Sort sweeps unsorted windows off project desktops', () => {
  it('an_unsorted_window_on_a_project_desktop_goes_to_the_last_desktop_after_project_moves', async () => {
    const svc = newService();
    await setup(svc, { 1: ['a'], 2: ['b'] }, snap([win('a', 3), win('b', 2), win('u', 2), win('s', 6), win('n', 4), win('z', null)]));
    const seq = svc.commands.lastSeq;
    const result = await svc.sort();
    expect(after(svc, seq, 'moveWindows')[0].moves).toEqual([{ windowKey: 'a', desktop: 1 }, { windowKey: 'u', desktop: 6 }]);
    expect(result.toMove).toBe(2);
    const tidy = after(svc, seq, 'tidy')[0];
    expect((tidy.desktops as { desktop: number }[]).map((d) => d.desktop)).toEqual([1, 2]);
    expect(tidy.force).toBe(false);
  });

  it('move_here_carries_only_that_contexts_windows_to_its_desktop', async () => {
    const svc = newService();
    const ids = await setup(svc, { 1: ['a'], 2: ['b', 'c'] }, snap([win('a', 3), win('b', 4), win('c', 2), win('u', 2)]));
    const seq = svc.commands.lastSeq;
    expect(await svc.gather(ids[2])).toEqual({ toMove: 1 });
    expect(after(svc, seq, 'moveWindows').map((c) => c.moves)).toEqual([[{ windowKey: 'b', desktop: 2 }]]);
    expect((await svc.view()).activeContextId).toBe(null);
  });

  it('the_view_counts_unsorted_windows_to_move', async () => {
    const svc = newService();
    await setup(svc, { 2: ['b'] }, snap([win('b', 2), win('u', 2), win('s', 6)]));
    expect((await svc.view()).unsortedToMove).toBe(1);
  });

  it('owner_choices_stick_through_sort_and_snapshots', async () => {
    const svc = newService();
    const ids = await setup(svc, { 1: [], 2: ['t'] }, snap([win('t', 1)]));
    svc.unassign('t');
    await svc.applySnapshot(snap([win('t', 1)]));
    await svc.sort();
    const view = await svc.view();
    expect(view.unsorted.map((w) => w.key)).toContain('t');
    svc.assign('t', ids[1]);
    await svc.sort();
    expect((await svc.view()).contexts.find((c) => c.id === ids[1])?.windows[0].why).toBe('assigned by you');
  });
});

describe('Tidy', () => {
  it('tidy_with_no_target_lays_out_every_window_on_the_active_desktop', async () => {
    const svc = newService();
    await setup(svc, { 2: ['a', 'b', 'c'] }, snap([win('a', 2), win('b', 2), win('c', 1), win('u', 2)], 2));
    const seq = svc.commands.lastSeq;
    expect(svc.tidy({})).toEqual({ desktop: 2, windows: 3 });
    expect(after(svc, seq, 'tidy')[0]).toMatchObject({ force: true, desktops: [{ desktop: 2, windowKeys: ['a', 'b', 'u'] }] });
  });

  it('manual_tidy_takes_other_contexts_strays_and_never_moves_a_window', async () => {
    const svc = newService();
    await setup(svc, { 2: ['a'], 3: ['s'] }, snap([win('a', 2), win('s', 2), win('m', null)], 2));
    const seq = svc.commands.lastSeq;
    svc.tidy({ desktop: 2 });
    expect(after(svc, seq, 'tidy')[0].desktops).toEqual([{ desktop: 2, windowKeys: ['a', 's'] }]);
    expect(after(svc, seq, 'moveWindows')).toHaveLength(0);
  });

  it('tidy_of_a_context_targets_its_desktop', async () => {
    const svc = newService();
    const ids = await setup(svc, { 3: ['a'] }, snap([win('a', 3)], 1));
    expect(svc.tidy({ contextId: ids[3] })).toEqual({ desktop: 3, windows: 1 });
  });

  it('on_the_shared_desktop_only_the_shown_context_is_laid_out', async () => {
    const svc = newService();
    const ids = await setup(svc, { 6: ['f'], 7: ['g'] }, snap([win('f', 6), win('g', 6)], 6));
    svc.switchTo(ids[6]);
    const seq = svc.commands.lastSeq;
    svc.tidy({ desktop: 6 });
    expect(after(svc, seq, 'tidy')[0].desktops).toEqual([{ desktop: 6, windowKeys: ['f'] }]);
  });

  it('nothing_to_lay_out_queues_nothing', async () => {
    const svc = newService();
    await setup(svc, { 2: [] }, snap([win('u', 3)], 4));
    const seq = svc.commands.lastSeq;
    expect(svc.tidy({})).toEqual({ desktop: 4, windows: 0 });
    expect(after(svc, seq, 'tidy')).toHaveLength(0);
  });

  it('tidy_needs_the_app_and_real_desktops', async () => {
    const silent = newService();
    expect(() => silent.tidy({})).toThrow(/isn't reporting/);
    const offscreen = newService();
    await offscreen.applySnapshot({ windows: [], desktops: null });
    expect(() => offscreen.tidy({})).toThrow(/desktops/);
  });

  it('undo_tidy_queues_an_undo_for_the_active_desktop', async () => {
    const svc = newService();
    await setup(svc, { 2: ['a'] }, snap([win('a', 2)], 2));
    expect(svc.undoTidy({})).toEqual({ desktop: 2 });
    expect(last(svc, 'undoTidy')).toMatchObject({ desktop: 2 });
  });

  it('auto_tidy_defaults_on_and_survives_a_restart', async () => {
    expect((await newService().view()).autoTidy).toBe(true);
    newService().setSettings({ autoTidy: false });
    expect((await newService().view()).autoTidy).toBe(false);
  });
});
