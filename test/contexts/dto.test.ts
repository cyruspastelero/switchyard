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
