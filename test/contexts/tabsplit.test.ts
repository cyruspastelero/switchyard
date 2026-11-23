import { describe, it, expect } from '../support/harness.ts';
import { tabSplits, type SplitCandidate } from '../../src/contexts/tabsplit.ts';
import { parseSnapshot } from '../../src/contexts/dto.ts';

// Tab title -> context id, the way the matcher would answer.
const contextOf = (_key: string, title: string): string | null =>
  title.includes('aral') ? 'aral' : title.includes('switchyard') ? 'yard' : title.includes('tala') ? 'tala' : null;

const win = (key: string, tabTitles: readonly string[], current: string | null = null): SplitCandidate =>
  ({ key, tabTitles, current, ownerChoice: false });

describe('tabSplits', () => {
  it('tabs_of_one_project_stay_together', () => {
    expect(tabSplits([win('w1', ['~/aral', '~/aral/src'])], contextOf)).toEqual([]);
  });

  it('minority_tabs_of_another_project_are_pulled_out', () => {
    expect(tabSplits([win('w1', ['~/aral', '~/switchyard', '~/aral/src'])], contextOf)).toEqual([
      { windowKey: 'w1', tabs: [{ index: 1, title: '~/switchyard' }] },
    ]);
  });

  it('a_tie_keeps_the_project_the_window_is_already_in', () => {
    expect(tabSplits([win('w1', ['~/aral', '~/switchyard'], 'yard')], contextOf)).toEqual([
      { windowKey: 'w1', tabs: [{ index: 0, title: '~/aral' }] },
    ]);
  });

  it('a_tie_without_a_current_project_keeps_the_first_tab_project', () => {
    expect(tabSplits([win('w1', ['~/aral', '~/switchyard'])], contextOf)).toEqual([
      { windowKey: 'w1', tabs: [{ index: 1, title: '~/switchyard' }] },
    ]);
  });

  it('tabs_that_match_no_project_stay_where_they_are', () => {
    expect(tabSplits([win('w1', ['~/aral', 'htop', '~/switchyard', 'zsh'])], contextOf)).toEqual([
      { windowKey: 'w1', tabs: [{ index: 2, title: '~/switchyard' }] },
    ]);
  });

  it('every_other_project_is_pulled_out_of_a_three_project_window', () => {
    expect(tabSplits([win('w1', ['~/tala', '~/aral', '~/aral/x', '~/switchyard'])], contextOf)).toEqual([
      { windowKey: 'w1', tabs: [{ index: 0, title: '~/tala' }, { index: 3, title: '~/switchyard' }] },
    ]);
  });

  it('a_window_the_owner_placed_by_hand_is_never_split', () => {
    expect(tabSplits([{ ...win('w1', ['~/aral', '~/switchyard']), ownerChoice: true }], contextOf)).toEqual([]);
  });

  it('a_window_with_one_tab_or_none_is_left_alone', () => {
    expect(tabSplits([win('w1', ['~/switchyard']), win('w2', [])], contextOf)).toEqual([]);
  });
});

describe('snapshot tab titles', () => {
  const base = { key: 'k', app: 'Ghostty', bundleId: 'com.mitchellh.ghostty', pid: 1, title: 't', document: null, browser: null };

  it('a_window_may_list_its_tab_titles', () => {
    const p = parseSnapshot({ windows: [{ ...base, tabTitles: ['~/aral', '~/switchyard'] }] });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value.windows[0].tabTitles).toEqual(['~/aral', '~/switchyard']);
  });

  it('tab_titles_must_be_a_short_list_of_strings', () => {
    expect(parseSnapshot({ windows: [{ ...base, tabTitles: 'nope' }] }).ok).toBe(false);
    expect(parseSnapshot({ windows: [{ ...base, tabTitles: [1] }] }).ok).toBe(false);
    expect(parseSnapshot({ windows: [{ ...base, tabTitles: Array(201).fill('x') }] }).ok).toBe(false);
  });

  it('a_window_without_tab_titles_has_none', () => {
    const p = parseSnapshot({ windows: [base] });
    expect(p.ok && p.value.windows[0].tabTitles).toBe(undefined);
  });
});
