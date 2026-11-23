import { describe, it, expect } from '../support/harness.ts';
import { addBlock, closeBlock, desktopsListView, planDesktopAction } from '../../src/contexts/desktop-admin.ts';
import { ContextsError, type DesktopEntry, type Snapshot } from '../../src/contexts/types.ts';

/** Laptop with Desktops 1-3, monitor with 4-6. Desktop 2 shows on the laptop, 5 on the monitor. */
const list: DesktopEntry[] = [1, 2, 3, 4, 5, 6].map((number) => ({
  number, space: 100 + number, screen: number <= 3 ? 1 : 2, builtin: number <= 3, showing: number === 2 || number === 5,
}));
const ctx = (name: string, key: number | null) => ({ id: name, name, key });

describe('close rules', () => {
  it('a_free_desktop_with_no_project_after_it_can_be_closed', () => {
    expect(closeBlock(3, list, [ctx('aral', 1), ctx('tala', 2)], 6)).toBeNull();
  });

  it('a_desktop_a_project_owns_says_how_to_free_it', () => {
    expect(closeBlock(2, list, [ctx('aral', 2)], 6)).toBe('Desktop 2 belongs to aral. Give aral another desktop first.');
  });

  it('the_shared_desktop_with_windows_cannot_be_closed', () => {
    expect(closeBlock(6, list, [], 6, 2)).toBe('Desktop 6 is the shared desktop and holds 2 windows. Move them first.');
  });

  it('an_empty_shared_desktop_can_be_closed_so_an_added_desktop_can_be_undone', () => {
    expect(closeBlock(6, list, [ctx('aral', 1)], 6, 0)).toBeNull();
  });

  it('the_last_desktop_on_a_screen_cannot_be_closed', () => {
    const one = [list[0], { ...list[1], screen: 2, builtin: false }, { ...list[2], screen: 2, builtin: false }];
    expect(closeBlock(1, one, [], 3)).toBe('Desktop 1 is the only desktop on its screen.');
  });

  it('closing_before_a_project_desktop_is_refused_because_it_would_renumber_it', () => {
    expect(closeBlock(3, list, [ctx('aral', 4)], 6)).toBe('Closing it would renumber Desktop 4 (aral). Give aral another desktop first.');
  });

  it('a_project_on_the_shared_desktop_does_not_block_closing_a_free_one', () => {
    expect(closeBlock(4, list, [ctx('aral', null), ctx('tala', 8)], 6)).toBeNull();
  });

  it('a_desktop_that_is_not_listed_is_named', () => {
    expect(closeBlock(9, list, [], 6)).toBe('There is no Desktop 9.');
  });
});

describe('add rules', () => {
  it('adding_on_the_last_screen_is_fine', () => {
    expect(addBlock(2, list, [ctx('aral', 1), ctx('tala', 5)], 6)).toBeNull();
  });

  it('adding_on_an_earlier_screen_is_refused_when_it_would_renumber_a_project', () => {
    expect(addBlock(1, list, [ctx('tala', 5)], 6)).toBe('A new desktop here would renumber Desktop 5 (tala). Give tala another desktop first.');
    expect(addBlock(1, list, [ctx('aral', 2)], 6)).toBeNull();
  });

  it('sixteen_desktops_is_the_limit_and_unknown_screens_are_named', () => {
    const full = Array.from({ length: 16 }, (_, i) => ({ number: i + 1, space: i + 1, screen: 1, builtin: true, showing: false }));
    expect(addBlock(1, full, [], 16)).toBe('Switchyard uses up to 16 desktops.');
    expect(addBlock(9, full, [], 16)).toBe('There is no screen 9.');
    expect(addBlock(3, list, [], 6)).toBe('There is no screen 3.');
  });
});

describe('desktops list view', () => {
  const windows = [{ desktop: 1 }, { desktop: 1 }, { desktop: 6 }, { desktop: null }, {}];

  it('one_row_per_desktop_with_owner_windows_and_what_shows', () => {
    const view = desktopsListView(list, [ctx('aral', 1), ctx('tala', 9)], windows, 6);
    expect(view.desktops.map((d) => d.windows)).toEqual([2, 0, 0, 0, 0, 1]);
    expect(view.desktops[0]).toMatchObject({ number: 1, screen: 1, screenLabel: 'Laptop', owners: [{ id: 'aral', name: 'aral' }], shared: false });
    expect(view.desktops[5]).toMatchObject({ shared: true, owners: [], screenLabel: 'Monitor', showing: false });
    expect(view.desktops.filter((d) => d.showing).map((d) => d.number)).toEqual([2, 5]);
    expect(view.desktops[0].closeBlocked).toMatch(/belongs to aral/);
    expect(view.desktops[2].closeBlocked).toBeNull();
    expect(view.screens).toEqual([
      { screen: 1, label: 'Laptop', addBlocked: null },
      { screen: 2, label: 'Monitor', addBlocked: null },
    ]);
  });

  it('two_monitors_are_called_by_their_screen_number', () => {
    const monitors = list.map((d) => ({ ...d, builtin: false }));
    expect(desktopsListView(monitors, [], [], 6).screens.map((s) => s.label)).toEqual(['Screen 1', 'Screen 2']);
  });
});

describe('planning a desktop action', () => {
  const snap: Snapshot = { windows: [], desktops: { count: 6, active: 2, list }, canCarry: true };

  it('close_sends_the_space_it_saw_so_the_app_can_check_it', () => {
    expect(planDesktopAction({ type: 'close', number: 3 }, snap, [], 6)).toEqual({ type: 'closeDesktop', number: 3, spaceCheck: 103 });
  });

  it('a_refused_close_is_a_409_with_the_reason', () => {
    try {
      planDesktopAction({ type: 'close', number: 1 }, snap, [ctx('aral', 1)], 6);
      throw new Error('not refused');
    } catch (err) {
      expect(err instanceof ContextsError && err.status).toBe(409);
      expect((err as Error).message).toMatch(/Give aral another desktop first/);
    }
  });

  it('add_and_show_become_app_commands', () => {
    expect(planDesktopAction({ type: 'add', screen: 2 }, snap, [], 6)).toEqual({ type: 'addDesktop', screen: 2 });
    expect(planDesktopAction({ type: 'show', number: 4 }, snap, [], 6)).toEqual({ type: 'showDesktop', desktop: 4 });
  });

  it('an_unknown_desktop_is_a_404_and_an_old_app_is_told_to_update', () => {
    expect(() => planDesktopAction({ type: 'show', number: 9 }, snap, [], 6)).toThrow('There is no Desktop 9.');
    const old: Snapshot = { windows: [], desktops: { count: 6, active: 2 }, canCarry: true };
    expect(() => planDesktopAction({ type: 'add', screen: 1 }, old, [], 6)).toThrow(/Update the Switchyard Mac app/);
    expect(() => planDesktopAction({ type: 'add', screen: 1 }, snap, [], null)).toThrow(/real desktops/);
  });
});
