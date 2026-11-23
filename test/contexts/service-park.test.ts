import { describe, it, expect, afterAll, beforeEach } from '../support/harness.ts';
import { setupTestDb, teardownTestDb } from '../helpers.ts';
import type { SignalSource } from '../../src/contexts/signals.ts';
import type { SnapshotWindow } from '../../src/contexts/types.ts';

const tmpDir = setupTestDb();
const { getDb, getAgents } = await import('../../src/db.ts');
const { ContextsService } = await import('../../src/contexts/service.ts');

const db = getDb();
const signals: SignalSource = { folderRoot: async (cwd) => cwd, patterns: async () => [], sessionTitles: async () => new Map() };
type Service = InstanceType<typeof ContextsService>;

function chrome(key: string, url: string): SnapshotWindow {
  return {
    key, app: 'Google Chrome', bundleId: 'com.google.Chrome', pid: 1, title: 'T', document: null,
    browser: { windowId: key, name: null, tabs: [{ id: 0, url, title: url }] },
  };
}
const openWindows = (svc: Service, after: number) => svc.commands.since(after).filter((c) => c.type === 'openWindow');
const parkedCount = async (svc: Service, id: string) => (await svc.view()).contexts.find((c) => c.id === id)?.parkedWindowCount;

new ContextsService({ db, listAgents: getAgents, signals });
beforeEach(() => {
  db.exec('DELETE FROM context_rules; DELETE FROM window_assignments; DELETE FROM window_unsorted; DELETE FROM window_names; DELETE FROM parked_windows; DELETE FROM window_last_seen; DELETE FROM contexts; DELETE FROM agents; DELETE FROM events;');
});
afterAll(() => teardownTestDb(tmpDir));

async function parkedTopic(svc: Service) {
  const topic = svc.createTopic('topic');
  await svc.applySnapshot({ windows: [chrome('w1', 'https://a.com/one')] });
  svc.assign('w1', topic.id);
  svc.park(topic.id);
  return topic;
}

describe('park and restore are idempotent', () => {
  it('a_restore_the_app_never_acked_leaves_no_parked_windows_on_the_unparked_context', async () => {
    const svc = new ContextsService({ db, listAgents: getAgents, signals, autoContextWindowMs: Infinity });
    const topic = await parkedTopic(svc);
    svc.restore(topic.id);
    expect(await parkedCount(svc, topic.id)).toBe(0);
  });

  it('parking_again_after_an_unacked_restore_replaces_the_saved_windows', async () => {
    const svc = new ContextsService({ db, listAgents: getAgents, signals, autoContextWindowMs: Infinity });
    const topic = await parkedTopic(svc);
    svc.restore(topic.id); // the open is never acked (failed, or the server restarted)
    await svc.applySnapshot({ windows: [chrome('w2', 'https://a.com/one')] });
    svc.assign('w2', topic.id);
    svc.park(topic.id);
    expect(svc.store.listParked(topic.id)).toHaveLength(1);
    expect(await parkedCount(svc, topic.id)).toBe(1);
    const before = svc.commands.lastSeq;
    expect(svc.restore(topic.id)).toEqual({ restoredWindows: 1 });
    expect(openWindows(svc, before)).toHaveLength(1);
  });

  it('restoring_a_context_that_is_not_parked_reopens_nothing', async () => {
    const svc = new ContextsService({ db, listAgents: getAgents, signals, autoContextWindowMs: Infinity });
    const topic = await parkedTopic(svc);
    svc.restore(topic.id);
    const before = svc.commands.lastSeq;
    expect(svc.restore(topic.id)).toEqual({ restoredWindows: 0 });
    expect(openWindows(svc, before)).toHaveLength(0);
  });
});

describe('window commands need the Mac app', () => {
  it('show_all_and_rename_are_refused_while_the_mac_app_is_not_reporting_windows', async () => {
    let clock = Date.parse('2026-01-01T01:00:00Z');
    const svc = new ContextsService({ db, listAgents: getAgents, signals, now: () => clock, autoContextWindowMs: Infinity });
    await svc.applySnapshot({ windows: [chrome('w1', 'https://a.com/one')] });
    clock += 60_000; // the app went quiet
    const before = svc.commands.lastSeq;
    expect(() => svc.showAll()).toThrow(/Mac app isn't reporting windows/);
    expect(() => svc.renameWindow('w1', 'Docs')).toThrow(/Mac app isn't reporting windows/);
    expect(svc.commands.lastSeq).toBe(before);
    expect(svc.store.getNames().get('w1')).toBeUndefined();
  });
});
