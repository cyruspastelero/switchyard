import { describe, it, expect } from '../support/harness.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type Owner = { id: string; name: string };
type Row = { number: number; shared: boolean; owners: Owner[] };
type Target = { ok: boolean; owner: Owner | null; reason: string };
const logic = require('../../src/dashboard/dragdrop.js') as {
  dropTarget: (row: Row, fromContextId: string | null) => Target;
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
