import { describe, it, expect } from '../support/harness.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const logic = require('../../src/dashboard/contexts-logic.js') as {
  setupSteps: (d: object) => { id: string; title: string; text: string; done: boolean }[];
  needsSetup: (d: object) => boolean;
  failureText: (f: { action: string; error: string } | null) => string;
  doneText: (action: string, name?: string) => string;
  canRename: (w: { app: string; bundleId: string }) => boolean;
  moveItems: (contexts: { id: string; name: string; color: string; desktop: number | null; key: number | null }[], currentId: string) =>
    { id: string; name: string; color: string; meta: string }[];
  UNSORTED_ID: string;
  busyLabel: (action: string) => string;
  shortTitle: (title: string) => string;
  byDesktop: <T extends { desktop: number | null; key: number | null }>(list: T[]) => T[];
  suggestedContextId: (
    w: { key: string; title: string; name: string },
    contexts: { id: string; name: string }[],
    suggestions: { fromWindowKey: string; toContextId: string }[],
  ) => string | null;
};

const base = { windowControl: false, contexts: [], unsorted: [] };
const ctx = { id: 'a', name: 'tala' };

describe('first run', () => {
  it('a_fresh_server_lists_every_step_as_still_to_do', () => {
    const steps = logic.setupSteps(base);
    expect(steps.map((s) => s.id)).toEqual(['agents', 'app', 'switch']);
    expect(steps.every((s) => !s.done)).toBe(true);
    expect(steps[0].text).toMatch(/Start Claude Code in a project folder/);
    expect(steps[1].text).toMatch(/Accessibility/);
    expect(steps[2].text).toMatch(/⌥Space/);
    expect(logic.needsSetup(base)).toBe(true);
  });

  it('steps_tick_off_as_agents_and_the_mac_app_show_up', () => {
    const withAgents = logic.setupSteps({ ...base, contexts: [ctx] });
    expect(withAgents.map((s) => s.done)).toEqual([true, false, false]);
    const all = logic.setupSteps({ ...base, windowControl: true, contexts: [ctx] });
    expect(all.map((s) => s.done)).toEqual([true, true, true]);
    expect(logic.needsSetup({ ...base, windowControl: true, contexts: [ctx] })).toBe(false);
  });

  it('setup_stays_visible_while_the_mac_app_is_missing_even_with_contexts', () => {
    expect(logic.needsSetup({ ...base, contexts: [ctx] })).toBe(true);
  });
});

describe('feedback', () => {
  it('a_failed_app_command_is_explained_in_plain_words', () => {
    expect(logic.failureText(null)).toBe('');
    expect(logic.failureText({ action: 'show', error: 'window not found' }))
      .toBe('The Mac app could not switch windows: window not found');
    expect(logic.failureText({ action: 'nameWindow', error: 'osascript timed out' }))
      .toBe('The Mac app could not rename a browser window: osascript timed out');
    expect(logic.failureText({ action: 'teleport', error: 'x' })).toBe('The Mac app could not finish the last action: x');
  });

  it('every_action_has_a_busy_label_and_a_done_message', () => {
    expect(logic.busyLabel('switch')).toBe('Switching…');
    expect(logic.busyLabel('park')).toBe('Parking…');
    expect(logic.doneText('switch', 'tala')).toBe('Switched to tala');
    expect(logic.doneText('park', 'tala')).toBe('Parked tala. Its tabs are saved.');
    expect(logic.doneText('renameContext', 'aral app')).toBe('Renamed to aral app');
    expect(logic.doneText('showAll')).toBe('All windows are back');
    expect(logic.doneText('unknown')).toBe('');
  });
});

describe('real desktops', () => {
  const desk = require('../../src/dashboard/contexts-logic.js') as {
    desktopLabel: (c: { key: number | null; desktop?: number | null; desktopShared?: boolean }) => string;
    toSortText: (n: number) => string;
    failureText: (f: { action: string; error: string } | null) => string;
  };

  it('each_context_names_its_desktop_and_marks_the_shared_one', () => {
    expect(desk.desktopLabel({ key: 1, desktop: 1, desktopShared: false })).toBe('Desktop 1 · ⌥1');
    expect(desk.desktopLabel({ key: 5, desktop: 5, desktopShared: false })).toBe('Desktop 5 · ⌥5');
    expect(desk.desktopLabel({ key: 6, desktop: 6, desktopShared: true })).toBe('Desktop 6 · shared · ⌥6');
    expect(desk.desktopLabel({ key: 9, desktop: 6, desktopShared: true })).toBe('Desktop 6 · shared · ⌥9');
  });

  it('off_screen_mode_keeps_the_old_key_label', () => {
    expect(desk.desktopLabel({ key: 2, desktop: null })).toBe('desktop 2 · ⌥2');
    expect(desk.desktopLabel({ key: null, desktop: null })).toBe('no desktop number');
  });

  it('windows_to_sort_count_hides_at_zero', () => {
    expect(desk.toSortText(0)).toBe('');
    expect(desk.toSortText(1)).toBe('1 window to sort');
    expect(desk.toSortText(3)).toBe('3 windows to sort');
  });

  it('a_failed_move_is_explained', () => {
    expect(desk.failureText({ action: 'moveWindows', error: 'moved 1, could not move 1' }))
      .toBe('The Mac app could not move every window to its desktop: moved 1, could not move 1');
  });
});

describe('window titles', () => {
  it('browser_and_profile_suffix_is_stripped_so_the_owner_name_never_shows', () => {
    expect(logic.shortTitle('Switchyard - Access - Google Chrome - Jane Doe')).toBe('Switchyard - Access');
    expect(logic.shortTitle('Inbox \u2014 Mozilla Firefox')).toBe('Inbox');
    expect(logic.shortTitle('Docs - Microsoft Edge')).toBe('Docs');
    expect(logic.shortTitle('Pull requests - Brave - Work')).toBe('Pull requests');
  });

  it('titles_without_a_browser_suffix_are_kept_and_empty_ones_say_untitled', () => {
    expect(logic.shortTitle('Multi-project workspace - Claude')).toBe('Multi-project workspace - Claude');
    expect(logic.shortTitle('')).toBe('Untitled');
    expect(logic.shortTitle('Google Chrome')).toBe('Google Chrome');
    expect(logic.shortTitle('- Discord')).toBe('Discord');
  });
});

describe('card order', () => {
  it('contexts_follow_the_desktop_number_like_mission_control_with_unnumbered_last', () => {
    const list = [
      { id: 'c', desktop: 3, key: 3 }, { id: 'x', desktop: null, key: null },
      { id: 'a', desktop: 1, key: 1 }, { id: 'k', desktop: null, key: 2 },
    ];
    expect(logic.byDesktop(list).map((c) => c.id)).toEqual(['a', 'k', 'c', 'x']);
    expect(list[0].id).toBe('c');
  });
});

describe('assign picker suggestion', () => {
  const contexts = [{ id: 'a', name: 'aral' }, { id: 's', name: 'shea-coach' }];

  it('a_tab_suggestion_for_the_window_wins', () => {
    const w = { key: 'w1', title: 'aral docs', name: '' };
    expect(logic.suggestedContextId(w, contexts, [{ fromWindowKey: 'w1', toContextId: 's' }])).toBe('s');
  });

  it('otherwise_a_context_named_in_the_title_is_suggested_and_none_when_nothing_matches', () => {
    expect(logic.suggestedContextId({ key: 'w2', title: 'Shea-Coach admin - Google Chrome', name: '' }, contexts, [])).toBe('s');
    expect(logic.suggestedContextId({ key: 'w3', title: 'Discord', name: '' }, contexts, [])).toBe(null);
  });
});

describe('moving a window between contexts', () => {
  const contexts = [
    { id: 'a', name: 'aral', color: '#4f8cff', desktop: null, key: 1 },
    { id: 't', name: 'tala', color: '#e8833a', desktop: null, key: 2 },
  ];
  it('the_move_picker_lists_other_contexts_and_unsorted_but_not_the_current_one', () => {
    const items = logic.moveItems(contexts, 'a');
    expect(items.map((i) => i.name)).toEqual(['tala', 'Unsorted']);
    expect(items[1].id).toBe(logic.UNSORTED_ID);
  });
  it('a_move_says_where_the_window_went', () => {
    expect(logic.doneText('move', 'aral')).toBe('Moved to aral');
    expect(logic.doneText('move', 'Unsorted')).toBe('Moved to Unsorted');
  });
});

describe('renaming windows', () => {
  it('only_chrome_offers_rename', () => {
    expect(logic.canRename({ app: 'Google Chrome', bundleId: 'com.google.Chrome' })).toBe(true);
    expect(logic.canRename({ app: 'Arc', bundleId: 'company.thebrowser.Browser' })).toBe(false);
    expect(logic.canRename({ app: 'Ghostty', bundleId: 'com.mitchellh.ghostty' })).toBe(false);
    expect(logic.canRename({ app: 'Chrome Remote Desktop', bundleId: 'com.google.chromeremotedesktop' })).toBe(false);
  });
});
