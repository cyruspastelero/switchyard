import { describe, it, expect } from '../support/harness.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type Owner = { id: string; name: string };
type Row = { number: number; shared: boolean; owners: Owner[] };
type Spec = Row | { kind: 'card'; id: string; name: string } | { kind: 'unsorted' };
type Target = { ok: boolean; owner: Owner | null; name: string; reason: string };
type Req = { path: string; body: Record<string, string> };
const logic = require('../../src/dashboard/dragdrop.js') as {
  dropTarget: (spec: Spec, fromContextId: string | null) => Target;
  dropRequest: (windowKey: string, target: Target) => Req;
  undoRequest: (windowKey: string, fromContextId: string | null) => Req;
  targetNote: (target: Target) => string;
  undoPlan: (fromContextId: string | null) => { action: 'assign' | 'unassign'; contextId?: string };
  dropText: (result: { moving: boolean; desktop: number | null } | null, ownerName: string) => string;
  undoText: (fromName: string | null) => string;
};

const row = (number: number, owners: Owner[], shared = false): Row => ({ number, shared, owners });
const aral = { id: 'a', name: 'aral' };

describe('dropping a window on a desktop row', () => {
  it('a_row_a_context_owns_takes_the_drop_and_names_its_owner', () => {
    const t = logic.dropTarget(row(2, [aral]), null);
    expect(t.ok).toBe(true);
    expect(t.owner).toEqual(aral);
  });

  it('the_shared_desktop_is_not_a_drop_target', () => {
    const t = logic.dropTarget(row(6, [aral], true), null);
    expect(t.ok).toBe(false);
    expect(t.reason).toMatch(/shared/i);
  });

  it('a_free_desktop_is_not_a_drop_target', () => {
    const t = logic.dropTarget(row(3, []), 'x');
    expect(t.ok).toBe(false);
    expect(t.reason).toMatch(/no context/i);
  });

  it('the_window_s_own_context_desktop_is_not_a_drop_target', () => {
    const t = logic.dropTarget(row(2, [aral]), 'a');
    expect(t.ok).toBe(false);
    expect(t.reason).toMatch(/already/i);
  });

  it('undo_assigns_back_to_the_old_context_or_unassigns_an_unsorted_window', () => {
    expect(logic.undoPlan('b')).toEqual({ action: 'assign', contextId: 'b' });
    expect(logic.undoPlan(null)).toEqual({ action: 'unassign' });
  });

  it('says_where_the_window_went_and_where_undo_put_it', () => {
    expect(logic.dropText({ moving: true, desktop: 2 }, 'aral')).toBe('Moved to aral · Desktop 2');
    expect(logic.dropText({ moving: false, desktop: null }, 'aral')).toBe('Moved to aral');
    expect(logic.undoText('devx')).toBe('Moved back to devx');
    expect(logic.undoText(null)).toBe('Back in Unsorted');
  });
});

describe('dropping a window on a context card or on Unsorted', () => {
  const card = (c: Owner) => ({ kind: 'card' as const, id: c.id, name: c.name });

  it('another_context_s_card_takes_the_drop_and_names_that_context', () => {
    const t = logic.dropTarget(card(aral), 'b');
    expect(t.ok).toBe(true);
    expect(t.owner).toEqual(aral);
    expect(logic.dropTarget(card(aral), null).ok).toBe(true);
  });

  it('the_window_s_own_card_refuses_and_says_it_is_already_there', () => {
    const t = logic.dropTarget(card(aral), 'a');
    expect(t.ok).toBe(false);
    expect(t.reason).toBe('Already in aral');
    expect(logic.targetNote(t)).toBe('Already in aral');
  });

  it('unsorted_takes_a_sorted_window_and_refuses_one_already_unsorted', () => {
    const t = logic.dropTarget({ kind: 'unsorted' }, 'a');
    expect(t.ok).toBe(true);
    expect(t.owner).toBe(null);
    expect(t.name).toBe('Unsorted');
    expect(logic.targetNote(t)).toBe('Drop to move it to Unsorted');
    const off = logic.dropTarget({ kind: 'unsorted' }, null);
    expect(off.ok).toBe(false);
    expect(off.reason).toBe('Already in Unsorted');
  });

  it('a_card_or_desktop_drop_assigns_and_an_unsorted_drop_unassigns', () => {
    expect(logic.dropRequest('w1', logic.dropTarget(card(aral), null)))
      .toEqual({ path: '/api/contexts/assign', body: { windowKey: 'w1', contextId: 'a' } });
    expect(logic.dropRequest('w1', logic.dropTarget(row(2, [aral]), null)))
      .toEqual({ path: '/api/contexts/assign', body: { windowKey: 'w1', contextId: 'a' } });
    expect(logic.dropRequest('w1', logic.dropTarget({ kind: 'unsorted' }, 'a')))
      .toEqual({ path: '/api/contexts/unassign', body: { windowKey: 'w1' } });
  });

  it('undo_puts_the_window_back_where_it_came_from', () => {
    expect(logic.undoRequest('w1', 'b')).toEqual({ path: '/api/contexts/assign', body: { windowKey: 'w1', contextId: 'b' } });
    expect(logic.undoRequest('w1', null)).toEqual({ path: '/api/contexts/unassign', body: { windowKey: 'w1' } });
  });

  it('an_open_target_invites_the_drop_by_name', () => {
    expect(logic.targetNote(logic.dropTarget(card(aral), null))).toBe('Drop to move it to aral');
  });
});
