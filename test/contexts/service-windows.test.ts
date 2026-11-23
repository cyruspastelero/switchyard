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
const newService = (): Service => new ContextsService({ db, listAgents: getAgents, signals, autoContextWindowMs: Infinity });

function term(key: string, desktop: number | null = null, pid = 2): SnapshotWindow {
  return { key, app: 'Ghostty', bundleId: 'com.mitchellh.ghostty', pid, title: key, document: null, browser: null, desktop };
}
function chrome(key: string, title: string, tabs: { url: string; title: string }[]): SnapshotWindow {
  return {
    key, app: 'Google Chrome', bundleId: 'com.google.Chrome', pid: 1, title: `${title} - Google Chrome - Me`, document: null,
    browser: { windowId: key, name: null, tabs: tabs.map((t, i) => ({ id: i, ...t })) },
  };
}
const snap = (windows: SnapshotWindow[], active: number | null = 1): Snapshot => ({ windows, desktops: { count: 6, active }, canCarry: true });
const windowsOf = async (svc: Service, id: string) => (await svc.view()).contexts.find((c) => c.id === id)?.windows ?? [];
const types = (svc: Service, after: number) => svc.commands.since(after).map((c) => c.type);

new ContextsService({ db, listAgents: getAgents, signals });
beforeEach(() => {
  db.exec('DELETE FROM context_rules; DELETE FROM window_assignments; DELETE FROM window_unsorted; DELETE FROM window_names; DELETE FROM parked_windows; DELETE FROM window_last_seen; DELETE FROM contexts; DELETE FROM agents; DELETE FROM events;');
});
afterAll(() => teardownTestDb(tmpDir));

describe('stale automatic assignments of browser windows', () => {
  it('a_browser_window_whose_old_reason_is_gone_goes_to_unsorted_without_moving', async () => {
    const svc = newService();
    const ctx = svc.createTopic('switchyard');
    await svc.applySnapshot({ windows: [chrome('c', 'Switchyard', [{ url: 'http://localhost:4280/', title: 'Switchyard' }])] });
    expect((await windowsOf(svc, ctx.id)).map((w) => w.key)).toEqual(['c']);
    const seq = svc.commands.lastSeq;
    await svc.applySnapshot({ windows: [chrome('c', 'Meta Business Suite', [{ url: 'https://business.facebook.com/', title: 'Meta Business Suite' }])] });
    expect(await windowsOf(svc, ctx.id)).toEqual([]);
    expect((await svc.view()).unsorted.map((w) => w.key)).toEqual(['c']);
    expect(types(svc, seq)).toEqual([]);
  });

  it('a_stale_browser_window_follows_its_current_tabs_to_another_context', async () => {
    const svc = newService();
    const old = svc.createTopic('switchyard');
    const next = svc.createTopic('akawntant');
    await svc.applySnapshot({ windows: [chrome('c', 'Switchyard', [{ url: 'https://example.com/', title: 'Switchyard' }])] });
    await svc.applySnapshot({ windows: [chrome('c', 'Akawntant social media', [{ url: 'https://example.com/', title: 'Akawntant social media' }])] });
    expect(await windowsOf(svc, old.id)).toEqual([]);
    expect((await windowsOf(svc, next.id)).map((w) => w.why)).toEqual(['title mentions "akawntant"']);
  });

  it('a_window_switchyard_named_follows_its_tabs_not_the_name_in_its_title', async () => {
    const svc = newService();
    const aral = svc.createTopic('aral');
    const sw = svc.createTopic('switchyard');
    const dash = chrome('o', 'Dashboard', [{ url: 'http://localhost:4280/', title: 'Dashboard' }]);
    await svc.applySnapshot({ windows: [dash, chrome('c', 'aral notes', [{ url: 'https://example.com/', title: 'aral notes' }])] });
    svc.assign('o', sw.id); // learns localhost:4280
    expect((await windowsOf(svc, aral.id)).map((w) => w.key)).toEqual(['c']);
    const stays = chrome('c', 'aral', [{ url: 'https://example.com/', title: 'aral notes' }]);
    await svc.applySnapshot({ windows: [dash, { ...stays, browser: { ...stays.browser!, name: 'aral' } }] });
    expect((await windowsOf(svc, aral.id)).map((w) => w.why)).toEqual(['title mentions "aral"']);
    // Chrome shows the name Switchyard gave the window in place of the page title.
    const named = chrome('c', 'aral', [{ url: 'http://localhost:4280/login', title: 'Switchyard — Access' }]);
    await svc.applySnapshot({ windows: [dash, { ...named, browser: { ...named.browser!, name: 'aral' } }] });
    expect(await windowsOf(svc, aral.id)).toEqual([]);
    expect((await windowsOf(svc, sw.id)).find((w) => w.key === 'c')?.why).toBe('1 of 1 tabs match switchyard');
  });

  it('a_named_chrome_window_shows_its_name_and_the_page_it_shows', async () => {
    const svc = newService();
    const named = chrome('c', 'aral', [{ url: 'https://a.dev/', title: 'A' }, { url: 'https://b.dev/', title: 'Inbox' }]);
    await svc.applySnapshot({ windows: [{ ...named, browser: { ...named.browser!, name: 'aral', activeTitle: 'Inbox' } }] });
    expect((await svc.view()).unsorted).toMatchObject([{ key: 'c', name: 'aral', title: 'Inbox', tabCount: 2 }]);
  });

  it('owner_assignments_are_never_reevaluated', async () => {
    const svc = newService();
    const ctx = svc.createTopic('switchyard');
    await svc.applySnapshot({ windows: [chrome('c', 'Switchyard', [{ url: 'https://example.com/', title: 'Switchyard' }])] });
    svc.assign('c', ctx.id);
    await svc.applySnapshot({ windows: [chrome('c', 'Meta Business Suite', [{ url: 'https://business.facebook.com/', title: 'Meta' }])] });
    expect((await windowsOf(svc, ctx.id)).map((w) => w.why)).toEqual(['assigned by you']);
  });
});

describe('windows out of sight', () => {
  it('a_window_closed_on_another_desktop_leaves_its_card', async () => {
    // The app lists every window on every desktop, so one it stops listing was closed.
    const svc = newService();
    const ctx = svc.createTopic('shea');
    await svc.applySnapshot(snap([term('a', 1), term('b', 5)]));
    svc.assign('b', ctx.id);
    await svc.applySnapshot(snap([term('a', 1)]));
    expect(await windowsOf(svc, ctx.id)).toEqual([]);
  });

  it('a_window_gone_from_the_desktop_on_screen_was_closed_and_leaves_the_card', async () => {
    const svc = newService();
    const ctx = svc.createTopic('shea');
    await svc.applySnapshot(snap([term('a', 1), term('b', 5)]));
    svc.assign('b', ctx.id);
    await svc.applySnapshot(snap([term('a', 5)], 5));
    expect(await windowsOf(svc, ctx.id)).toEqual([]);
  });

  it('a_window_hidden_by_a_switch_is_marked_hidden_until_shown_again', async () => {
    const svc = newService();
    const one = svc.createTopic('one');
    const two = svc.createTopic('two');
    await svc.applySnapshot({ windows: [term('a'), term('b')] });
    svc.assign('a', one.id);
    svc.assign('b', two.id);
    svc.switchTo(one.id);
    expect((await windowsOf(svc, two.id))[0].hidden).toBe(true);
    expect((await windowsOf(svc, one.id))[0].hidden).toBe(false);
    svc.showAll();
    expect((await windowsOf(svc, two.id))[0].hidden).toBe(false);
  });
});

describe('focusing one window', () => {
  it('focus_queues_one_command_and_leaves_the_active_context_alone', async () => {
    const svc = newService();
    const one = svc.createTopic('one');
    const two = svc.createTopic('two');
    await svc.applySnapshot({ windows: [term('a'), term('b')] });
    svc.assign('a', one.id);
    svc.assign('b', two.id);
    svc.switchTo(one.id);
    const seq = svc.commands.lastSeq;
    svc.focusWindow('b');
    expect(svc.commands.since(seq)).toMatchObject([{ type: 'focusWindow', windowKey: 'b' }]);
    expect((await svc.view()).activeContextId).toBe(one.id);
    expect((await windowsOf(svc, two.id))[0].hidden).toBe(false);
  });

  it('going_to_a_desktop_for_a_focus_does_not_make_its_context_active', async () => {
    const svc = newService();
    const one = svc.createTopic('one');
    const five = svc.createTopic('five');
    svc.patchContext(five.id, { key: 5 });
    await svc.applySnapshot(snap([term('a', 1), term('b', 5)]));
    svc.assign('a', one.id);
    svc.assign('b', five.id);
    svc.switchTo(one.id);
    svc.focusWindow('b');
    await svc.applySnapshot(snap([term('a', 1), term('b', 5)], 5));
    expect((await svc.view()).activeContextId).toBe(one.id);
  });

  it('focus_needs_the_app_and_a_known_window', async () => {
    const svc = newService();
    await expect(Promise.resolve().then(() => svc.focusWindow('a'))).rejects.toThrow(/Mac app/);
    await svc.applySnapshot({ windows: [term('a')] });
    await expect(Promise.resolve().then(() => svc.focusWindow('zz'))).rejects.toThrow(/Window not found/);
  });
});

describe('remembered windows', () => {
  it('the_last_seen_store_never_keeps_tab_urls', async () => {
    const svc = newService();
    await svc.applySnapshot(snap([{ ...chrome('b', 'shea-coach', [{ url: 'https://secret.example/x', title: 't' }]), pid: 2, desktop: 5 }]));
    expect(JSON.stringify(db.prepare('SELECT * FROM window_last_seen').all())).toMatch(/shea-coach/);
    expect(JSON.stringify(db.prepare('SELECT * FROM window_last_seen').all())).not.toMatch(/secret\.example/);
  });
});
