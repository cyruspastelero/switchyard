// Layout presets: the owner's hand-made arrangement, saved and reused by Tidy. Spec: personal_docs/work/layout-presets.md.
import { describe, it, expect, afterAll, beforeEach } from '../support/harness.ts';
import { setupTestDb, teardownTestDb } from '../helpers.ts';
import type { SignalSource } from '../../src/contexts/signals.ts';
import type { Snapshot, SnapshotWindow } from '../../src/contexts/types.ts';

const tmpDir = setupTestDb();
const { getDb, getAgents } = await import('../../src/db.ts');
const { ContextsService } = await import('../../src/contexts/service.ts');
const { parseCreateLayout, parseRenameLayout, parseCaptureLayout } = await import('../../src/contexts/layouts.ts');
const { parsePatchContext, parseSettings } = await import('../../src/contexts/dto.ts');

const db = getDb();
const signals: SignalSource = { folderRoot: async (cwd) => cwd, patterns: async () => [], sessionTitles: async () => new Map() };
type Service = InstanceType<typeof ContextsService>;
type Cmd = Record<string, unknown> & { type: string; seq: number };
const newService = (): Service => new ContextsService({ db, listAgents: getAgents, signals, autoContextWindowMs: Infinity });

const slot = (bundleId = 'com.mitchellh.ghostty', over: Record<string, unknown> = {}) => ({
  bundleId, app: 'Ghostty', screen: { uuid: 'A1B2', builtin: true }, frame: { x: 0, y: 0, w: 0.5, h: 1 }, ...over,
});

function win(key: string, desktop: number | null): SnapshotWindow {
  return { key, app: 'Ghostty', bundleId: 'com.mitchellh.ghostty', pid: 2, title: key, document: null, browser: null, desktop };
}
const snap = (windows: SnapshotWindow[], active = 1, count = 6): Snapshot => ({ windows, desktops: { count, active }, canCarry: true });

async function contextOn(svc: Service, key: number, windows: string[]): Promise<string> {
  await svc.applySnapshot(snap(windows.map((w) => win(w, key))));
  const row = svc.createTopic(`ctx${key}`);
  svc.patchContext(row.id, { key });
  for (const w of windows) svc.assign(w, row.id);
  await svc.applySnapshot(snap(windows.map((w) => win(w, key))));
  return row.id;
}

const last = (svc: Service, type: string): Cmd | undefined =>
  (svc.commands.since(0) as unknown as Cmd[]).filter((c) => c.type === type).at(-1);

new ContextsService({ db, listAgents: getAgents, signals });
beforeEach(() => {
  db.exec('DELETE FROM window_assignments; DELETE FROM window_last_seen; DELETE FROM contexts; DELETE FROM context_settings; DELETE FROM layout_presets;');
});
afterAll(() => teardownTestDb(tmpDir));

describe('layout DTOs', () => {
  it('a_valid_preset_parses', () => {
    const p = parseCreateLayout({ name: ' Two screens ', slots: [slot()] });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value).toEqual({ name: 'Two screens', slots: [slot()] });
  });

  it('bad_names_and_slot_counts_are_refused', () => {
    expect(parseCreateLayout({ name: '', slots: [slot()] }).ok).toBe(false);
    expect(parseCreateLayout({ name: 'x'.repeat(101), slots: [slot()] }).ok).toBe(false);
    expect(parseCreateLayout({ name: 'a', slots: [] }).ok).toBe(false);
    expect(parseCreateLayout({ name: 'a', slots: Array.from({ length: 51 }, () => slot()) }).ok).toBe(false);
    expect(parseCreateLayout({ name: 'a', slots: [slot()], extra: 1 }).ok).toBe(false);
  });

  it('every_slot_field_is_checked', () => {
    const bad = [
      slot(''), slot('x'.repeat(201)), slot(undefined, { app: 'x'.repeat(101) }),
      slot(undefined, { screen: { uuid: 'x'.repeat(65), builtin: true } }),
      slot(undefined, { screen: { uuid: 'a', builtin: 'yes' } }),
      slot(undefined, { frame: { x: -0.1, y: 0, w: 0.5, h: 0.5 } }),
      slot(undefined, { frame: { x: 0, y: 0, w: 0, h: 0.5 } }),
      slot(undefined, { frame: { x: 0, y: 0, w: 1.5, h: 0.5 } }),
      slot(undefined, { frame: { x: 0, y: Number.NaN, w: 0.5, h: 0.5 } }),
      slot(undefined, { frame: { x: 0, y: 0, w: 0.5, h: 0.5, z: 1 } }),
      slot(undefined, { title: 'secret' }),
    ];
    for (const s of bad) expect(parseCreateLayout({ name: 'a', slots: [s] }).ok).toBe(false);
  });

  it('rename_and_capture_take_a_name', () => {
    expect(parseRenameLayout({ name: 'b' })).toEqual({ ok: true, value: { name: 'b' } });
    expect(parseRenameLayout({}).ok).toBe(false);
    expect(parseCaptureLayout({})).toEqual({ ok: true, value: {} });
    expect(parseCaptureLayout({ name: 'Desk' })).toEqual({ ok: true, value: { name: 'Desk' } });
    expect(parseCaptureLayout({ name: 3 }).ok).toBe(false);
  });

  it('context_patch_and_settings_take_a_layout_id_or_null', () => {
    expect(parsePatchContext({ layoutId: 'abc' })).toEqual({ ok: true, value: { layoutId: 'abc' } });
    expect(parsePatchContext({ layoutId: null })).toEqual({ ok: true, value: { layoutId: null } });
    expect(parsePatchContext({ layoutId: 5 }).ok).toBe(false);
    expect(parseSettings({ defaultLayoutId: null })).toEqual({ ok: true, value: { defaultLayoutId: null } });
    expect(parseSettings({ autoTidy: true })).toEqual({ ok: true, value: { autoTidy: true } });
    expect(parseSettings({}).ok).toBe(false);
  });
});

describe('layout presets in the service', () => {
  it('a_saved_preset_is_listed_in_the_view', async () => {
    const svc = newService();
    const p = svc.layouts.create({ name: 'Desk', slots: [slot()] });
    expect(svc.layouts.list()).toEqual([p]);
    const view = await svc.view();
    expect((view.layouts ?? []).map((l) => l.name)).toEqual(['Desk']);
    expect(view.defaultLayoutId).toBeNull();
  });

  it('rename_and_delete_unknown_ids_are_404', () => {
    const svc = newService();
    expect(() => svc.layouts.rename('nope', 'x')).toThrow('No layout');
    expect(() => svc.layouts.remove('nope')).toThrow('No layout');
  });

  it('a_context_uses_its_own_layout_else_the_default', async () => {
    const svc = newService();
    const id = await contextOn(svc, 2, ['a']);
    const desk = svc.layouts.create({ name: 'Desk', slots: [slot()] });
    const solo = svc.layouts.create({ name: 'Solo', slots: [slot('com.google.Chrome')] });
    svc.setSettings({ defaultLayoutId: desk.id });
    let ctx = (await svc.view()).contexts.find((c) => c.id === id);
    expect(ctx?.layoutId).toBeNull();
    expect(ctx?.layout?.id).toBe(desk.id);
    svc.patchContext(id, { layoutId: solo.id });
    ctx = (await svc.view()).contexts.find((c) => c.id === id);
    expect(ctx?.layoutId).toBe(solo.id);
    expect(ctx?.layout?.slots).toEqual(solo.slots);
  });

  it('auto_on_a_context_overrides_the_default_with_the_automatic_layout', async () => {
    const svc = newService();
    const id = await contextOn(svc, 2, ['a']);
    const desk = svc.layouts.create({ name: 'Desk', slots: [slot()] });
    svc.setSettings({ defaultLayoutId: desk.id });
    svc.patchContext(id, { layoutId: 'auto' });
    const ctx = (await svc.view()).contexts.find((c) => c.id === id);
    expect(ctx?.layoutId).toBe('auto');
    expect(ctx?.layout).toBeNull();
    svc.tidy({ contextId: id });
    expect('slots' in (last(svc, 'tidy')?.desktops as Record<string, unknown>[])[0]).toBe(false);
    expect(() => svc.setSettings({ defaultLayoutId: 'auto' })).toThrow('No layout');
  });

  it('an_unknown_layout_id_is_refused', async () => {
    const svc = newService();
    const id = await contextOn(svc, 2, ['a']);
    expect(() => svc.patchContext(id, { layoutId: 'nope' })).toThrow('No layout');
    expect(() => svc.setSettings({ defaultLayoutId: 'nope' })).toThrow('No layout');
  });

  it('deleting_a_preset_clears_the_context_and_default_that_used_it', async () => {
    const svc = newService();
    const id = await contextOn(svc, 2, ['a']);
    const p = svc.layouts.create({ name: 'Desk', slots: [slot()] });
    svc.setSettings({ defaultLayoutId: p.id });
    svc.patchContext(id, { layoutId: p.id });
    svc.layouts.remove(p.id);
    const view = await svc.view();
    expect(view.defaultLayoutId).toBeNull();
    expect(view.contexts.find((c) => c.id === id)?.layoutId).toBeNull();
    expect(view.contexts.find((c) => c.id === id)?.layout).toBeNull();
  });

  it('tidy_sends_the_owner_contexts_slots', async () => {
    const svc = newService();
    const id = await contextOn(svc, 2, ['a', 'b']);
    const p = svc.layouts.create({ name: 'Desk', slots: [slot()] });
    svc.patchContext(id, { layoutId: p.id });
    svc.tidy({ contextId: id });
    expect(last(svc, 'tidy')).toMatchObject({ desktops: [{ desktop: 2, windowKeys: ['a', 'b'], slots: p.slots }], force: true });
  });

  it('tidy_without_a_layout_sends_no_slots', async () => {
    const svc = newService();
    const id = await contextOn(svc, 2, ['a']);
    svc.tidy({ contextId: id });
    const d = (last(svc, 'tidy')?.desktops as Record<string, unknown>[])[0];
    expect('slots' in d).toBe(false);
  });

  it('capture_queues_a_command_with_a_default_name', async () => {
    const svc = newService();
    await contextOn(svc, 2, ['a']);
    svc.layouts.create({ name: 'Desk', slots: [slot()] });
    expect(svc.captureLayout({})).toEqual({ name: 'Layout 2' });
    expect(last(svc, 'captureLayout')).toMatchObject({ name: 'Layout 2' });
    svc.captureLayout({ name: 'Mine' });
    expect(last(svc, 'captureLayout')).toMatchObject({ name: 'Mine' });
  });

  it('capture_needs_the_mac_app', () => {
    const svc = newService();
    expect(() => svc.captureLayout({})).toThrow();
  });
});
