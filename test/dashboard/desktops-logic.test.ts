import { describe, it, expect } from '../support/harness.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type Ctx = { id: string; name: string; key: number | null };
type Row = { number: number; screenLabel: string; shared: boolean; owners: { id: string; name: string }[]; windows: number; showing: boolean };
const logic = require('../../src/dashboard/contexts-logic.js') as {
  keyOptions: (contexts: Ctx[], current: Ctx, desktopCount: number) => { value: string; label: string }[];
  keyDoneText: (name: string, key: number | null, desktopCount: number | null) => string;
  desktopOwnerText: (row: Row) => string;
  desktopMeta: (row: Row, multiScreen: boolean) => string;
  doneText: (action: string, name?: string) => string;
  closePlan: (rows: Batch[], picked: number[]) => Plan;
  closeBatchLabel: (plan: Plan) => string;
  closeBatchConfirm: (plan: Plan) => string;
  closeBatchDoneText: (closed: number, skipped: number) => string;
  swapTarget: (dragged: { id: string; name: string; key: number | null }, row: Row & { number: number }) => { ok: boolean; note: string };
  pollUntil: (check: () => Promise<boolean>, intervalMs: number, timeoutMs: number) => Promise<boolean>;
};
type Batch = { number: number; screen: number; closeBlocked: string | null };
type Plan = { close: number[]; skipped: { number: number; reason: string }[] };

const aral = { id: 'a', name: 'aral', key: 2 };
const me = { id: 'm', name: 'switchyard', key: 1 };

describe('desktop select on a card', () => {
  it('lists_each_own_desktop_up_to_nine_and_names_who_would_swap', () => {
    const options = logic.keyOptions([me, aral], me, 4);
    expect(options).toEqual([
      { value: '1', label: 'Desktop 1 · ⌥1' },
      { value: '2', label: 'Desktop 2 · ⌥2 (aral — swaps)' },
      { value: '3', label: 'Desktop 3 · ⌥3' },
      { value: '', label: 'No desktop (shared)' },
    ]);
  });

  it('never_offers_more_than_nine_and_keeps_a_current_key_on_the_shared_desktop', () => {
    expect(logic.keyOptions([me], me, 16).filter((o) => o.value).length).toBe(9);
    const seven = { id: 's', name: 's', key: 7 };
    expect(logic.keyOptions([seven], seven, 4).map((o) => o.label)).toEqual([
      'Desktop 1 · ⌥1', 'Desktop 2 · ⌥2', 'Desktop 3 · ⌥3', '⌥7 · shared desktop', 'No desktop (shared)',
    ]);
  });

  it('says_what_the_change_did', () => {
    expect(logic.keyDoneText('switchyard', 2, 6)).toBe('switchyard is now Desktop 2 · ⌥2');
    expect(logic.keyDoneText('switchyard', null, 6)).toBe('switchyard now uses the shared desktop');
    expect(logic.keyDoneText('switchyard', 7, 6)).toBe('switchyard is now ⌥7 on the shared desktop');
  });
});

describe('desktops list rows', () => {
  const row = (extra: Partial<Row>): Row => ({ number: 3, screenLabel: 'Laptop', shared: false, owners: [], windows: 0, showing: false, ...extra });

  it('names_the_owner_or_says_shared_or_free', () => {
    expect(logic.desktopOwnerText(row({ owners: [{ id: 'a', name: 'aral' }] }))).toBe('aral');
    expect(logic.desktopOwnerText(row({ shared: true }))).toBe('Shared');
    expect(logic.desktopOwnerText(row({}))).toBe('Free');
  });

  it('a_tile_counts_windows_and_names_the_screen_only_with_two_screens', () => {
    expect(logic.desktopMeta(row({ windows: 1 }), false)).toBe('1 window');
    expect(logic.desktopMeta(row({ windows: 3, screenLabel: 'Monitor' }), true)).toBe('Monitor · 3 windows');
  });

  it('actions_say_what_happened', () => {
    expect(logic.doneText('desktopShow', 'Desktop 3')).toBe('Going to Desktop 3');
    expect(logic.doneText('desktopAdd', 'Laptop')).toBe('Adding a desktop on Laptop');
  });
});

describe('closing several desktops at once', () => {
  const d = (number: number, screen = 1, closeBlocked: string | null = null): Batch => ({ number, screen, closeBlocked });
  const owned = 'Desktop 1 belongs to devx. Give devx another desktop first.';

  it('closes_the_picked_desktops_from_the_highest_number_down', () => {
    const plan = logic.closePlan([d(1, 1, owned), d(2), d(3), d(4), d(5)], [2, 4, 3]);
    expect(plan).toEqual({ close: [4, 3, 2], skipped: [] });
  });

  it('skips_blocked_desktops_with_the_same_reason_as_a_single_close', () => {
    const plan = logic.closePlan([d(1, 1, owned), d(2), d(3)], [1, 3]);
    expect(plan).toEqual({ close: [3], skipped: [{ number: 1, reason: owned }] });
  });

  it('never_closes_every_desktop_on_a_screen', () => {
    const plan = logic.closePlan([d(1, 1, owned), d(2), d(3, 2), d(4, 2)], [3, 4]);
    expect(plan.close).toEqual([4]);
    expect(plan.skipped).toEqual([{ number: 3, reason: 'Desktop 3 is the only desktop left on its screen.' }]);
  });

  it('the_button_and_the_confirm_say_how_many_will_really_close', () => {
    const two = { close: [4, 3], skipped: [{ number: 1, reason: owned }] };
    expect(logic.closeBatchLabel({ close: [], skipped: [] })).toBe('Close selected');
    expect(logic.closeBatchLabel(two)).toBe('Close 2 desktops');
    expect(logic.closeBatchLabel({ close: [3], skipped: [] })).toBe('Close 1 desktop');
    expect(logic.closeBatchConfirm(two)).toBe('Close 2 desktops? Their windows move to another desktop on the same screen. 1 can’t close and will be skipped.');
    expect(logic.closeBatchConfirm({ close: [3], skipped: [] })).toBe('Close 1 desktop? Its windows move to another desktop on the same screen.');
    expect(logic.closeBatchDoneText(3, 0)).toBe('Closed 3 desktops');
    expect(logic.closeBatchDoneText(1, 2)).toBe('Closed 1 desktop · 2 skipped');
  });

  it('poll_until_resolves_true_once_the_check_passes_and_false_on_timeout', async () => {
    let calls = 0;
    expect(await logic.pollUntil(() => Promise.resolve(++calls >= 3), 1, 1000)).toBe(true);
    expect(calls).toBe(3);
    expect(await logic.pollUntil(() => Promise.resolve(false), 5, 20)).toBe(false);
  });
});

describe('dragging a project from one desktop tile to another', () => {
  const row = (number: number, owners: { id: string; name: string }[] = [], shared = false) =>
    ({ number, screenLabel: 'Laptop', shared, owners, windows: 0, showing: false });

  it('onto_another_project_swaps_the_two', () => {
    expect(logic.swapTarget(me, row(2, [aral]))).toEqual({ ok: true, note: 'Swap with aral' });
  });

  it('onto_a_free_desktop_moves_the_project_there', () => {
    expect(logic.swapTarget(me, row(4))).toEqual({ ok: true, note: 'Move switchyard here' });
  });

  it('refuses_its_own_desktop_the_shared_one_and_desktops_past_nine', () => {
    expect(logic.swapTarget(me, row(1, [me]))).toEqual({ ok: false, note: 'Already on Desktop 1' });
    expect(logic.swapTarget(me, row(6, [], true))).toEqual({ ok: false, note: 'The shared desktop holds no project' });
    expect(logic.swapTarget(me, row(10))).toEqual({ ok: false, note: 'Only Desktops 1–9 have a ⌥ key' });
  });
});
