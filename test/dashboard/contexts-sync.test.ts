import { describe, it, expect } from '../support/harness.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type Editor = { renaming: string | null; newTopicFor: string | null };
type Gate = { start: () => number; accept: (seq: number) => boolean; pushed: () => void };
const logic = require('../../src/dashboard/contexts-logic.js') as {
  editorAfter: (actionKey: string, editor: Editor) => Editor;
  replyGate: () => Gate;
};

describe('dashboard editors after an action', () => {
  it('saving_a_rename_closes_that_rename', () => {
    expect(logic.editorAfter('renameContext:c1', { renaming: 'ctx:c1', newTopicFor: null })).toEqual({ renaming: null, newTopicFor: null });
    expect(logic.editorAfter('name:w1', { renaming: 'w1', newTopicFor: null })).toEqual({ renaming: null, newTopicFor: null });
    expect(logic.editorAfter('assign:w2', { renaming: null, newTopicFor: 'w2' })).toEqual({ renaming: null, newTopicFor: null });
  });

  it('an_unrelated_action_leaves_an_open_rename_alone', () => {
    expect(logic.editorAfter('sort', { renaming: 'ctx:c1', newTopicFor: null })).toEqual({ renaming: 'ctx:c1', newTopicFor: null });
    expect(logic.editorAfter('renameContext:c2', { renaming: 'ctx:c1', newTopicFor: 'w9' })).toEqual({ renaming: 'ctx:c1', newTopicFor: 'w9' });
    expect(logic.editorAfter('assign:w1', { renaming: 'w1', newTopicFor: null })).toEqual({ renaming: 'w1', newTopicFor: null });
  });
});

describe('dashboard reply order', () => {
  it('a_reply_older_than_one_already_shown_is_dropped', () => {
    const gate = logic.replyGate();
    const slow = gate.start();
    const fast = gate.start();
    expect(gate.accept(fast)).toBe(true);
    expect(gate.accept(slow)).toBe(false);
  });

  it('a_socket_push_outdates_replies_still_in_flight', () => {
    const gate = logic.replyGate();
    const before = gate.start();
    gate.pushed();
    expect(gate.accept(before)).toBe(false);
    expect(gate.accept(gate.start())).toBe(true);
  });
});
