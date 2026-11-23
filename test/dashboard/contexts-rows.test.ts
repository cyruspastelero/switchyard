import { describe, it, expect } from '../support/harness.ts';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
type Win = { app: string; bundleId: string; title: string; name: string; tabCount: number | null; why: string; desktop: number | null; hidden: boolean };
const logic = require('../../src/dashboard/contexts-logic.js') as {
  windowLabel: (w: Win) => string;
  windowParts: (w: Win) => { text: string; tabs: string };
  windowTip: (w: Win) => string;
  windowPlace: (w: Win, activeDesktop: number | null, unsorted?: boolean) => string;
  placeTag: (w: Win, activeDesktop: number | null) => string;
  visibleWindows: <T>(list: T[], expanded: boolean) => { shown: T[]; more: number };
  cardMeta: (c: { desktop: number | null; key: number | null; status: string }) => string;
  agentSummary: (c: { agents: { status: string; costToday: number | null }[] }) => string;
};

const w = (over: Partial<Win> = {}): Win => ({
  app: 'Google Chrome', bundleId: 'com.google.Chrome', title: 'Meta Business Suite - Google Chrome - Me',
  name: '', tabCount: null, why: '', desktop: null, hidden: false, ...over,
});
const css = readFileSync(new URL('../../src/dashboard/styles.css', import.meta.url), 'utf8');
const rule = (selector: string): string => {
  const at = css.indexOf(`\n${selector} {`);
  return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
};

describe('window rows', () => {
  it('a_custom_name_is_shown_with_the_real_title_and_tab_count', () => {
    expect(logic.windowLabel(w({ name: 'test', tabCount: 3 }))).toBe('test · Meta Business Suite · 3 tabs');
  });

  it('the_tab_count_sits_apart_and_gives_way_before_the_title', () => {
    expect(logic.windowParts(w({ name: 'test', tabCount: 2 }))).toEqual({ text: 'test · Meta Business Suite', tabs: '2 tabs' });
    expect(logic.windowParts(w({ app: 'Ghostty', title: 'zsh' }))).toEqual({ text: 'zsh', tabs: '' });
    expect(rule('.ctx-w-label')).toMatch(/flex: 0 1 auto/);
    expect(rule('.ctx-w-tabs, .ctx-w-place')).toMatch(/flex: 0 1000 auto/);
  });

  it('a_name_that_is_the_title_is_not_repeated', () => {
    expect(logic.windowLabel(w({ name: 'shea-coach', title: 'shea-coach - Google Chrome - Me', tabCount: 1 }))).toBe('shea-coach · 1 tab');
    expect(logic.windowLabel(w({ app: 'Ghostty', title: 'zsh' }))).toBe('zsh');
  });

  it('the_tooltip_carries_the_full_title_app_and_why', () => {
    const long = 'Pending changes push and a very long title that does not fit';
    expect(logic.windowTip(w({ app: 'Ghostty', title: long, why: 'assigned by you' }))).toBe(`${long}\nGhostty · assigned by you`);
  });

  it('a_window_elsewhere_says_where_it_is', () => {
    expect(logic.windowPlace(w({ desktop: 5 }), 1)).toBe('Desktop 5 · not moved yet');
    expect(logic.windowPlace(w({ desktop: 5 }), 1, true)).toBe('on Desktop 5'); // unsorted: nowhere to move to
    expect(logic.windowPlace(w({ desktop: 1 }), 1)).toBe('');
    expect(logic.windowPlace(w({ hidden: true, desktop: 1 }), 1)).toBe('hidden');
    expect(logic.windowPlace(w(), null)).toBe('');
  });

  it('a_window_elsewhere_gets_a_short_desktop_tag_so_the_title_keeps_its_room', () => {
    expect(logic.placeTag(w({ desktop: 5 }), 1)).toBe('D5');
    expect(logic.placeTag(w({ hidden: true, desktop: 1 }), 1)).toBe('hidden');
    expect(logic.placeTag(w({ desktop: 1 }), 1)).toBe('');
    expect(logic.placeTag(w(), null)).toBe('');
  });

  it('a_long_window_list_shows_four_rows_and_counts_the_rest', () => {
    expect(logic.visibleWindows([1, 2, 3, 4, 5, 6], false)).toEqual({ shown: [1, 2, 3, 4], more: 2 });
    expect(logic.visibleWindows([1, 2, 3, 4, 5, 6], true)).toEqual({ shown: [1, 2, 3, 4, 5, 6], more: 0 });
    // One hidden row is not worth a toggle: show it.
    expect(logic.visibleWindows([1, 2, 3, 4, 5], false)).toEqual({ shown: [1, 2, 3, 4, 5], more: 0 });
  });

  it('cards_in_a_row_share_one_height', () => {
    expect(rule('.ctx-cards')).toMatch(/align-items: stretch/);
  });

  it('titles_get_the_full_row_width_with_actions_overlaid_not_reserved', () => {
    expect(rule('.ctx-w-acts')).toMatch(/position: absolute/);
    expect(rule('.ctx-w-text')).toMatch(/text-overflow: ellipsis/);
    expect(rule('.ctx-w-text')).toMatch(/flex: 1/);
  });
});

describe('uniform cards', () => {
  it('the_meta_line_has_one_fixed_format', () => {
    expect(logic.cardMeta({ desktop: 6, key: 6, status: 'idle' })).toBe('Desktop 6 · ⌥6 · Idle');
    expect(logic.cardMeta({ desktop: null, key: null, status: 'waiting' })).toBe('No desktop · no key · Waiting on you');
  });

  it('agents_fold_into_one_line_or_nothing', () => {
    expect(logic.agentSummary({ agents: [] })).toBe('');
    expect(logic.agentSummary({ agents: [{ status: 'idle', costToday: 0.363 }] })).toBe('1 agent · idle · $0.36');
    expect(logic.agentSummary({ agents: [{ status: 'working', costToday: 0.1 }, { status: 'waiting', costToday: null }] }))
      .toBe('2 agents · 1 waiting, 1 working · $0.10');
  });

  it('a_card_is_a_column_so_its_window_list_can_fill_the_row_height', () => {
    expect(rule('.ctx-card')).toMatch(/display: flex/);
    expect(rule('.ctx-card')).toMatch(/flex-direction: column/);
  });
});
