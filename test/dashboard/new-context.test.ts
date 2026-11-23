import { describe, it, expect } from '../support/harness.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type Win = { key: string; app: string; bundleId: string; title: string; name: string };
type Ctx = { id: string; name: string; key: number | null; windows: Win[] };
type Group = { id: string; label: string; windows: { window: Win; from: { id: string; name: string } | null }[] };
type Option = { value: string; label: string };
const logic = require('../../src/dashboard/new-context.js') as {
  windowGroups: (unsorted: Win[], contexts: Ctx[], query: string) => Group[];
  nextFreeKey: (contexts: Ctx[]) => number | null;
  desktopChoice: (contexts: Ctx[], desktopCount: number | null) => { options: Option[]; value: string } | null;
  createdText: (name: string, assigned: number) => string;
};

const w = (key: string, app: string, title: string, name = ''): Win => ({ key, app, bundleId: 'com.x.' + app, title, name });
const unsorted = [w('1', 'Chrome', 'Docs'), w('2', 'Ghostty', 'zsh'), w('3', 'Chrome', 'Mail')];
const contexts: Ctx[] = [
  { id: 'a', name: 'aral', key: 1, windows: [w('4', 'Chrome', 'aral board')] },
  { id: 'b', name: 'devx', key: 3, windows: [] },
];

describe('new context window picker', () => {
  it('lists_unsorted_windows_by_app_then_each_context_s_windows_marked_with_it', () => {
    const groups = logic.windowGroups(unsorted, contexts, '');
    expect(groups.map((g) => g.label)).toEqual(['Chrome', 'Ghostty', 'In aral']);
    expect(groups[0].windows.map((x) => x.window.key)).toEqual(['1', '3']);
    expect(groups[0].windows[0].from).toBe(null);
    expect(groups[2].windows[0].from).toEqual({ id: 'a', name: 'aral' });
  });

  it('search_matches_title_app_or_context_name_and_drops_empty_groups', () => {
    expect(logic.windowGroups(unsorted, contexts, 'mail').map((g) => g.windows.map((x) => x.window.key))).toEqual([['3']]);
    expect(logic.windowGroups(unsorted, contexts, 'ghost').map((g) => g.label)).toEqual(['Ghostty']);
    expect(logic.windowGroups(unsorted, contexts, 'ARAL').map((g) => g.label)).toEqual(['In aral']);
    expect(logic.windowGroups(unsorted, contexts, 'nothing')).toEqual([]);
  });

  it('the_next_free_key_is_the_lowest_one_no_context_holds', () => {
    expect(logic.nextFreeKey(contexts)).toBe(2);
    const full = Array.from({ length: 9 }, (_, i) => ({ id: String(i), name: 'c' + i, key: i + 1, windows: [] }));
    expect(logic.nextFreeKey(full)).toBe(null);
  });

  it('the_desktop_choice_defaults_to_the_next_free_desktop', () => {
    const choice = logic.desktopChoice(contexts, 5)!;
    expect(choice.value).toBe('2');
    expect(choice.options.find((o) => o.value === '2')!.label).toMatch(/next free/);
    expect(choice.options.find((o) => o.value === '1')!.label).toMatch(/aral — swaps/);
    expect(choice.options[choice.options.length - 1].value).toBe('');
  });

  it('with_every_key_taken_the_shared_default_is_not_called_next_free', () => {
    const full = Array.from({ length: 9 }, (_, i) => ({ id: String(i), name: 'c' + i, key: i + 1, windows: [] }));
    const choice = logic.desktopChoice(full, 6)!;
    expect(choice.value).toBe('');
    expect(choice.options.some((o) => /next free/.test(o.label))).toBe(false);
  });

  it('there_is_no_desktop_choice_without_real_desktops', () => {
    expect(logic.desktopChoice(contexts, null)).toBe(null);
  });

  it('says_what_was_created', () => {
    expect(logic.createdText('aral', 0)).toBe('Created aral');
    expect(logic.createdText('aral', 1)).toBe('Created aral with 1 window');
    expect(logic.createdText('aral', 3)).toBe('Created aral with 3 windows');
  });
});
