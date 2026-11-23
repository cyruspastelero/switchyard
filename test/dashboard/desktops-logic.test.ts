import { describe, it, expect } from '../support/harness.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type Ctx = { id: string; name: string; key: number | null };
type Row = { number: number; screenLabel: string; shared: boolean; owners: { id: string; name: string }[]; windows: number; showing: boolean };
const logic = require('../../src/dashboard/contexts-logic.js') as {
  keyOptions: (contexts: Ctx[], current: Ctx, desktopCount: number) => { value: string; label: string }[];
  keyDoneText: (name: string, key: number | null, desktopCount: number | null) => string;
  desktopOwnerText: (row: Row) => string;
  desktopMeta: (row: Row) => string;
  closeDesktopConfirm: (n: number) => string;
  desktopOwnerOptions: (row: Row, contexts: Ctx[], desktopCount: number) => { value: string; label: string }[];
  doneText: (action: string, name?: string) => string;
};

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

  it('owner_select_offers_free_and_every_context_saying_where_it_is_now', () => {
    const shared = { id: 's', name: 'notes', key: null };
    expect(logic.desktopOwnerOptions(row({ number: 2 }), [me, aral, shared], 6)).toEqual([
      { value: '', label: 'Free' },
      { value: 'm', label: 'switchyard (now Desktop 1)' },
      { value: 'a', label: 'aral' },
      { value: 's', label: 'notes' },
    ]);
  });

  it('meta_line_is_the_screen_and_the_window_count', () => {
    expect(logic.desktopMeta(row({ windows: 1 }))).toBe('Laptop · 1 window');
    expect(logic.desktopMeta(row({ windows: 3, screenLabel: 'Monitor' }))).toBe('Monitor · 3 windows');
  });

  it('close_asks_first_and_actions_say_what_happened', () => {
    expect(logic.closeDesktopConfirm(4)).toBe('Close Desktop 4? Its windows move to another desktop on that screen.');
    expect(logic.doneText('desktopShow', 'Desktop 3')).toBe('Going to Desktop 3');
    expect(logic.doneText('desktopClose', 'Desktop 3')).toBe('Closing Desktop 3');
    expect(logic.doneText('desktopAdd', 'Laptop')).toBe('Adding a desktop on Laptop');
  });
});
