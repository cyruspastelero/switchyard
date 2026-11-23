import { describe, it, expect } from '../support/harness.ts';
import { parseSnapshot, parsePatchContext, parseCreateContext, parseAssign, parseUnassign } from '../../src/contexts/dto.ts';

const win = { key: 'w1', app: 'Google Chrome', bundleId: 'com.google.Chrome', pid: 10, title: 'T', document: null,
  browser: { windowId: 5, name: null, tabs: [{ id: 1, url: 'https://a.com', title: 'A' }] } };

describe('parseSnapshot', () => {
  it('valid_snapshot_is_parsed_into_typed_windows', () => {
    const r = parseSnapshot({ windows: [win] });
    expect(r.ok && r.value.windows[0].browser?.tabs[0].url).toBe('https://a.com');
  });
  it('snapshot_rejects_unknown_fields', () => {
    expect(parseSnapshot({ windows: [], extra: 1 }).ok).toBe(false);
    expect(parseSnapshot({ windows: [{ ...win, surprise: true }] }).ok).toBe(false);
    expect(parseSnapshot({ windows: [{ ...win, browser: { ...win.browser, x: 1 } }] }).ok).toBe(false);
    const tab = { id: 1, url: 'https://a.com', title: 'A', extra: 1 };
    expect(parseSnapshot({ windows: [{ ...win, browser: { ...win.browser, tabs: [tab] } }] }).ok).toBe(false);
  });
  it('snapshot_rejects_wrong_types_and_duplicate_keys', () => {
    expect(parseSnapshot({ windows: [{ ...win, pid: 'x' }] }).ok).toBe(false);
    expect(parseSnapshot({ windows: [win, win] }).ok).toBe(false);
    expect(parseSnapshot([]).ok).toBe(false);
  });
  it('a_browser_window_may_carry_its_active_tab_title', () => {
    const r = parseSnapshot({ windows: [{ ...win, browser: { ...win.browser, activeTitle: 'Inbox' } }] });
    expect(r.ok && r.value.windows[0].browser?.activeTitle).toBe('Inbox');
    expect(parseSnapshot({ windows: [{ ...win, browser: { ...win.browser, activeTitle: 5 } }] }).ok).toBe(false);
  });
  it('document_and_browser_may_be_omitted', () => {
    const { document: _d, browser: _b, ...bare } = win;
    expect(parseSnapshot({ windows: [bare] }).ok).toBe(true);
  });
});

describe('small dtos', () => {
  it('patch_requires_at_least_one_valid_field', () => {
    expect(parsePatchContext({}).ok).toBe(false);
    expect(parsePatchContext({ key: 10 }).ok).toBe(false);
    expect(parsePatchContext({ color: 'red' }).ok).toBe(false);
    expect(parsePatchContext({ key: null }).ok).toBe(true);
    expect(parsePatchContext({ name: 'x', admin: true }).ok).toBe(false);
  });
  it('create_trims_and_rejects_blank_names', () => {
    expect(parseCreateContext({ name: '  Taxes ' })).toEqual({ ok: true, value: { name: 'Taxes' } });
    expect(parseCreateContext({ name: '   ' }).ok).toBe(false);
  });
  it('assign_rejects_unknown_fields', () => {
    expect(parseAssign({ windowKey: 'a', contextId: 'b', x: 1 }).ok).toBe(false);
  });
  it('unassign_takes_only_a_window_key', () => {
    expect(parseUnassign({ windowKey: 'a' })).toEqual({ ok: true, value: { windowKey: 'a' } });
    expect(parseUnassign({ windowKey: 'a', contextId: 'b' }).ok).toBe(false);
    expect(parseUnassign({ windowKey: '' }).ok).toBe(false);
    expect(parseUnassign({}).ok).toBe(false);
  });
});

describe('snapshot desktop list', () => {
  const entry = (number: number, screen = 1, extra: Record<string, unknown> = {}) =>
    ({ number, space: 100 + number, screen, builtin: screen === 1, showing: number === 1, ...extra });
  const withList = (list: unknown, count = 2) => parseSnapshot({ windows: [], desktops: { count, active: 1, list } });

  it('a_snapshot_without_a_desktop_list_is_still_valid', () => {
    const r = parseSnapshot({ windows: [], desktops: { count: 2, active: 1 } });
    expect(r.ok && r.value.desktops).toEqual({ count: 2, active: 1 });
  });

  it('a_desktop_list_is_parsed_with_screen_space_and_showing', () => {
    const r = withList([entry(1), entry(2, 2)]);
    expect(r.ok && r.value.desktops?.list).toEqual([
      { number: 1, space: 101, screen: 1, builtin: true, showing: true },
      { number: 2, space: 102, screen: 2, builtin: false, showing: false },
    ]);
  });

  it('a_desktop_list_must_match_the_count_and_number_desktops_in_order', () => {
    expect(withList([entry(1)]).ok).toBe(false);
    expect(withList([entry(2), entry(1)]).ok).toBe(false);
    expect(withList([entry(1), entry(1)]).ok).toBe(false);
    expect(withList('x').ok).toBe(false);
  });

  it('a_desktop_entry_rejects_unknown_fields_and_wrong_types', () => {
    expect(withList([entry(1), entry(2, 1, { extra: 1 })]).ok).toBe(false);
    expect(withList([entry(1), entry(2, 1, { builtin: 'yes' })]).ok).toBe(false);
    expect(withList([entry(1), entry(2, 1, { showing: 1 })]).ok).toBe(false);
    expect(withList([entry(1), entry(2, 0)]).ok).toBe(false);
    expect(withList([entry(1), entry(2, 17)]).ok).toBe(false);
    expect(withList([entry(1), entry(2, 1, { space: -1 })]).ok).toBe(false);
    expect(withList([entry(1), entry(2, 1, { space: 101 })]).ok).toBe(false);
  });

  it('screens_must_appear_in_order_without_coming_back', () => {
    expect(withList([entry(1, 1), entry(2, 2), entry(3, 1)], 3).ok).toBe(false);
    expect(withList([entry(1, 2), entry(2, 1)]).ok).toBe(false);
  });
});
