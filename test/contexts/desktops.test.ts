import { describe, it, expect } from '../support/harness.ts';
import { desktopFor, desktopMode, misplaced } from '../../src/contexts/desktops.ts';
import { parseAck, parseSnapshot } from '../../src/contexts/dto.ts';

describe('desktopFor', () => {
  it('keys_below_the_last_desktop_get_their_own_desktop', () => {
    expect(desktopFor(1, 6)).toBe(1);
    expect(desktopFor(5, 6)).toBe(5);
  });

  it('keys_from_the_last_desktop_up_share_the_last_desktop', () => {
    expect(desktopFor(6, 6)).toBe(6);
    expect(desktopFor(9, 6)).toBe(6);
    expect(desktopFor(3, 2)).toBe(2);
  });

  it('a_context_without_a_key_goes_to_the_shared_desktop', () => {
    expect(desktopFor(null, 6)).toBe(6);
  });

  it('one_desktop_or_none_means_off_screen_mode', () => {
    expect(desktopFor(1, 1)).toBeNull();
    expect(desktopFor(1, null)).toBeNull();
  });
});

describe('desktopMode', () => {
  it('needs_two_desktops_and_a_working_carry', () => {
    expect(desktopMode({ windows: [], desktops: { count: 6, active: 1 }, canCarry: true })).toBe(6);
    expect(desktopMode({ windows: [], desktops: { count: 1, active: 1 }, canCarry: true })).toBeNull();
    expect(desktopMode({ windows: [], desktops: { count: 6, active: 1 }, canCarry: false })).toBeNull();
    expect(desktopMode({ windows: [], desktops: null })).toBeNull();
    expect(desktopMode({ windows: [] })).toBeNull();
    expect(desktopMode(null)).toBeNull();
  });
});

describe('misplaced', () => {
  const targets = new Map([['a', 1], ['b', 2]]);

  it('a_window_already_on_its_desktop_is_not_moved', () => {
    expect(misplaced([{ key: 'a', desktop: 1 }], targets)).toEqual([]);
  });

  it('a_window_on_another_desktop_is_moved_to_its_target', () => {
    expect(misplaced([{ key: 'a', desktop: 3 }, { key: 'b', desktop: 2 }], targets)).toEqual([{ windowKey: 'a', desktop: 1 }]);
  });

  it('windows_without_a_target_or_a_known_desktop_are_left_alone', () => {
    expect(misplaced([{ key: 'u', desktop: 3 }, { key: 'b', desktop: null }, { key: 'a' }], targets)).toEqual([]);
  });
});

describe('snapshot desktop fields', () => {
  const win = { key: 'k', app: 'A', bundleId: 'b', pid: 1, title: 't', document: null, browser: null };

  it('window_desktop_must_be_an_integer_from_1_to_16_or_null', () => {
    expect(parseSnapshot({ windows: [{ ...win, desktop: 2 }] }).ok).toBe(true);
    expect(parseSnapshot({ windows: [{ ...win, desktop: null }] }).ok).toBe(true);
    expect(parseSnapshot({ windows: [{ ...win, desktop: 0 }] }).ok).toBe(false);
    expect(parseSnapshot({ windows: [{ ...win, desktop: '2' }] }).ok).toBe(false);
    expect(parseSnapshot({ windows: [{ ...win, desktop: 17 }] }).ok).toBe(false);
    expect(parseSnapshot({ windows: [{ ...win, desktop: 1.5 }] }).ok).toBe(false);
  });

  it('desktops_and_can_carry_are_parsed_and_checked', () => {
    const p = parseSnapshot({ windows: [{ ...win, desktop: 2 }], desktops: { count: 6, active: 2 }, canCarry: true });
    expect(p.ok && p.value).toEqual({ windows: [{ ...win, desktop: 2 }], desktops: { count: 6, active: 2 }, canCarry: true });
    expect(parseSnapshot({ windows: [], desktops: null, canCarry: false }).ok).toBe(true);
    expect(parseSnapshot({ windows: [], desktops: { count: 6, active: null } }).ok).toBe(true);
    expect(parseSnapshot({ windows: [], desktops: { count: 0, active: null } }).ok).toBe(false);
    expect(parseSnapshot({ windows: [], desktops: { count: 6, active: 7 } }).ok).toBe(false);
    expect(parseSnapshot({ windows: [], desktops: { count: 6, active: 1, extra: 1 } }).ok).toBe(false);
    expect(parseSnapshot({ windows: [], canCarry: 'yes' }).ok).toBe(false);
  });

  it('a_snapshot_without_desktop_fields_parses_as_before', () => {
    const p = parseSnapshot({ windows: [win] });
    expect(p.ok && p.value).toEqual({ windows: [win] });
  });
});

describe('ack failed keys', () => {
  it('ack_may_name_the_windows_that_failed', () => {
    const p = parseAck({ ok: false, error: 'moved 1, could not move 1', failedKeys: ['k'] });
    expect(p.ok && p.value).toEqual({ ok: false, error: 'moved 1, could not move 1', failedKeys: ['k'] });
    expect(parseAck({ ok: true, error: null }).ok && parseAck({ ok: true, error: null })).toEqual({ ok: true, value: { ok: true, error: null, failedKeys: [] } });
    expect(parseAck({ ok: false, error: 'x', failedKeys: [1] }).ok).toBe(false);
  });
});
