import { describe, it, expect } from '../support/harness.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type Suggestion = { id: string; url: string; title: string; toContextId: string; fromWindowKey: string };
type Ctx = { id: string; name: string; windows: { key: string }[] };
type Row = { ids: string[]; url: string; title: string; count: number; fromName: string | null };
type Group = { toContextId: string; toName: string; count: number; rows: Row[] };
const logic = require('../../src/dashboard/suggestions.js') as {
  groups: (suggestions: Suggestion[], contexts: Ctx[]) => Group[];
  where: (row: Row) => string;
  moveAllLabel: (group: Group) => string;
  doneText: (moved: number, toName: string) => string;
};

const pipeline = 'https://gitlab.example.com/devx/devx-client-data-service/-/pipelines/9245418';
const other = 'https://gitlab.example.com/devx/devx-client-data-service/-/pipelines/9245731';
const s = (id: string, url: string, to = 'data', from = 'w1'): Suggestion => ({ id, url, title: 'Pipeline', toContextId: to, fromWindowKey: from });
const contexts: Ctx[] = [
  { id: 'sy', name: 'switchyard', windows: [{ key: 'w1' }] },
  { id: 'data', name: 'devx-client-data-service', windows: [] },
  { id: 'aral', name: 'aral', windows: [] },
];

describe('tab suggestions', () => {
  it('the_same_url_going_to_the_same_context_is_one_row_with_a_count', () => {
    const [group] = logic.groups([s('a', pipeline), s('b', pipeline), s('c', other)], contexts);
    expect(group.toName).toBe('devx-client-data-service');
    expect(group.count).toBe(3);
    expect(group.rows.map((r) => [r.ids, r.count])).toEqual([[['a', 'b'], 2], [['c'], 1]]);
  });

  it('rows_are_grouped_by_target_in_first_seen_order', () => {
    const groups = logic.groups([s('a', pipeline, 'aral'), s('b', pipeline), s('c', other, 'aral')], contexts);
    expect(groups.map((g) => [g.toContextId, g.count])).toEqual([['aral', 2], ['data', 1]]);
  });

  it('says_whose_window_the_tab_sits_in', () => {
    const [group] = logic.groups([s('a', pipeline), s('b', pipeline), s('c', other, 'data', 'gone')], contexts);
    expect(logic.where(group.rows[0])).toBe('2 tabs in switchyard’s window');
    expect(logic.where(group.rows[1])).toBe('in another context’s window');
  });

  it('offers_move_all_only_when_two_or_more_tabs_go_to_one_context', () => {
    const [many] = logic.groups([s('a', pipeline), s('b', other)], contexts);
    const [one] = logic.groups([s('a', pipeline)], contexts);
    expect(logic.moveAllLabel(many)).toBe('Move all to devx-client-data-service');
    expect(logic.moveAllLabel(one)).toBe('');
    expect(logic.doneText(3, 'aral')).toBe('Moved 3 tabs to aral');
    expect(logic.doneText(1, 'aral')).toBe('Moved 1 tab to aral');
  });
});
