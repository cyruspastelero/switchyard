import { describe, it, expect } from '../support/harness.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type Win = { desktop: number | null; hidden: boolean };
const logic = require('../../src/dashboard/contexts-logic.js') as {
  windowPlace: (w: Win, home: number | null) => string;
  sortLabel: (toSort: number, unsortedToMove: number, shared: number | null) => string;
  strayHint: (c: { desktop: number | null; windows: Win[] }) => string;
  moveResultText: (result: { moving?: boolean; desktop?: number | null } | null, name: string) => string;
  tidyText: (result: { desktop: number; windows: number }) => string;
  noDataNote: (error: string) => string;
};

const win = (desktop: number | null): Win => ({ desktop, hidden: false });

describe('arranging in the dashboard', () => {
  it('a_window_away_from_its_contexts_desktop_says_where_it_is', () => {
    expect(logic.windowPlace(win(1), 2)).toBe('Desktop 1 · not moved yet');
    expect(logic.windowPlace(win(2), 2)).toBe('');
  });

  it('the_sort_label_says_what_sort_will_do', () => {
    expect(logic.sortLabel(0, 0, 6)).toBe('Sort windows');
    expect(logic.sortLabel(2, 0, 6)).toBe('Sort · 2 to move');
    expect(logic.sortLabel(0, 1, 6)).toBe('Sort · 1 unsorted to Desktop 6');
    expect(logic.sortLabel(2, 1, 6)).toBe('Sort · 2 to move · 1 unsorted to Desktop 6');
  });

  it('the_stray_hint_names_the_desktop_and_hides_at_zero', () => {
    expect(logic.strayHint({ desktop: 2, windows: [win(2)] })).toBe('');
    expect(logic.strayHint({ desktop: 2, windows: [win(1), win(2)] })).toBe('1 window is on Desktop 1.');
    expect(logic.strayHint({ desktop: 2, windows: [win(1), win(1)] })).toBe('2 windows are on Desktop 1.');
    expect(logic.strayHint({ desktop: 2, windows: [win(1), win(3)] })).toBe('2 windows are on other desktops.');
    expect(logic.strayHint({ desktop: null, windows: [win(null)] })).toBe('');
  });

  it('a_failed_load_names_the_error_once_instead_of_guessing_the_server_is_down', () => {
    expect(logic.noDataNote("Couldn't load contexts: database is locked")).toBe('');
    expect(logic.noDataNote('')).toBe('The server did not answer. It may be restarting.');
  });

  it('a_move_result_says_where_the_window_is_going', () => {
    expect(logic.moveResultText({ moving: true, desktop: 2 }, 'aral')).toBe('Moved to aral · Desktop 2');
    expect(logic.moveResultText({ moving: false, desktop: 2 }, 'aral')).toBe('Moved to aral');
    expect(logic.moveResultText(null, 'Unsorted')).toBe('Moved to Unsorted');
  });

  it('a_tidy_result_says_what_happened', () => {
    expect(logic.tidyText({ desktop: 3, windows: 2 })).toBe('Tidied Desktop 3');
    expect(logic.tidyText({ desktop: 4, windows: 0 })).toBe('Nothing to tidy on Desktop 4');
  });
});
