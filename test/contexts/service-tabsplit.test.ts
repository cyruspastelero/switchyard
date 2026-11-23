// Sort pulls terminal tabs of another project into their own window, then carries them.
import { describe, it, expect, afterAll, beforeEach } from '../support/harness.ts';
import { setupTestDb, teardownTestDb } from '../helpers.ts';
import type { SignalSource } from '../../src/contexts/signals.ts';
import type { Snapshot, SnapshotWindow } from '../../src/contexts/types.ts';

const tmpDir = setupTestDb();
const { getDb, getAgents } = await import('../../src/db.ts');
const { ContextsService } = await import('../../src/contexts/service.ts');

const db = getDb();
const signals: SignalSource = { folderRoot: async (cwd) => cwd, patterns: async () => [], sessionTitles: async () => new Map() };

type Service = InstanceType<typeof ContextsService>;
type Cmd = Record<string, unknown> & { type: string; seq: number };

function term(key: string, title: string, desktop: number, tabTitles?: string[]): SnapshotWindow {
  return { key, app: 'Ghostty', bundleId: 'com.mitchellh.ghostty', pid: 2, title, document: null, browser: null, desktop, ...(tabTitles ? { tabTitles } : {}) };
}
const snap = (windows: SnapshotWindow[]): Snapshot => ({ windows, desktops: { count: 6, active: 1 }, canCarry: true });
const commands = (svc: Service, type: string): Cmd[] =>
  (svc.commands.since(0) as unknown as Cmd[]).filter((c) => c.type === type);

const mixed = term('w1', 'alphaproj shell', 1, ['alphaproj shell', 'bravoproj shell']);
const afterSplit = [term('w1', 'alphaproj shell', 1), term('w2', 'bravoproj shell', 1)];

async function setup(): Promise<{ svc: Service; alpha: string; bravo: string }> {
  const svc = new ContextsService({ db, listAgents: getAgents, signals, autoContextWindowMs: Infinity });
  const alpha = svc.createTopic('alphaproj').id;
  const bravo = svc.createTopic('bravoproj').id;
  svc.patchContext(alpha, { key: 1 });
  svc.patchContext(bravo, { key: 2 });
  await svc.applySnapshot(snap([mixed]));
  return { svc, alpha, bravo };
}

new ContextsService({ db, listAgents: getAgents, signals }); // creates the tables

beforeEach(() => {
  db.exec('DELETE FROM context_rules; DELETE FROM window_assignments; DELETE FROM window_unsorted; DELETE FROM window_names; DELETE FROM window_last_seen; DELETE FROM parked_windows; DELETE FROM contexts; DELETE FROM context_settings;');
});
afterAll(() => teardownTestDb(tmpDir));

describe('Sort splits terminal tabs by project', () => {
  it('sort_asks_the_app_to_pull_out_the_other_project_tab_before_carrying', async () => {
    const { svc } = await setup();
    const result = await svc.sort();
    expect(commands(svc, 'splitTabs').map((c) => c.splits)).toEqual([[{ windowKey: 'w1', tabs: [{ index: 1, title: 'bravoproj shell' }] }]]);
    expect(commands(svc, 'moveWindows')).toEqual([]);
    expect(result).toMatchObject({ splitting: 1 });
  });

  it('the_pulled_out_tab_is_carried_to_its_desktop_once_the_app_reports_it', async () => {
    const { svc } = await setup();
    await svc.sort();
    svc.ack(commands(svc, 'splitTabs')[0].seq, true, null);
    await svc.applySnapshot(snap(afterSplit));
    expect(commands(svc, 'moveWindows').map((c) => c.moves)).toEqual([[{ windowKey: 'w2', desktop: 2 }]]);
    expect(commands(svc, 'splitTabs').length).toBe(1);
  });

  it('a_window_the_owner_placed_by_hand_is_never_split', async () => {
    const { svc, alpha } = await setup();
    svc.assign('w1', alpha);
    await svc.sort();
    expect(commands(svc, 'splitTabs')).toEqual([]);
  });

  it('a_failed_split_is_not_retried_and_the_rest_of_the_sort_still_runs', async () => {
    const { svc } = await setup();
    await svc.sort();
    svc.ack(commands(svc, 'splitTabs')[0].seq, false, 'menu item not found');
    const stray = term('w3', 'bravoproj logs', 1);
    await svc.applySnapshot(snap([mixed, stray]));
    await svc.applySnapshot(snap([mixed, stray]));
    expect(commands(svc, 'splitTabs').length).toBe(1);
    expect(commands(svc, 'moveWindows').map((c) => c.moves)).toEqual([[{ windowKey: 'w3', desktop: 2 }]]);
  });
});
