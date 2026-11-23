import { describe, it, expect } from '../support/harness.ts';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../../src/dashboard/app.js', import.meta.url), 'utf8');

/** Runs app.js's document keydown listener for one Enter press and reports whether it cancelled the default. */
function pressEnter(onCommandInput: boolean, view: 'contexts' | 'activity'): { prevented: boolean; sent: boolean } {
  const start = app.indexOf("document.addEventListener('keydown', function (e) {");
  const source = app.slice(start, app.indexOf('\n});\n', start) + 4);
  let handler: (e: unknown) => void = () => { throw new Error('no keydown listener'); };
  const result = { prevented: false, sent: false };
  const commandInput = { tagName: 'INPUT' };
  runInNewContext(source, {
    document: {
      addEventListener: (_: string, h: (e: unknown) => void) => { handler = h; },
      body: { classList: { contains: (c: string) => c === `view-${view}` } },
    },
    $commandInput: commandInput,
    sendInstruction: () => { result.sent = true; },
  });
  handler({
    key: 'Enter', shiftKey: false, target: onCommandInput ? commandInput : { tagName: 'INPUT' },
    preventDefault: () => { result.prevented = true; },
  });
  return result;
}

describe('Enter in text fields', () => {
  it('enter_in_a_contexts_form_field_is_left_to_submit_the_form', () => {
    expect(pressEnter(false, 'contexts')).toEqual({ prevented: false, sent: false });
  });

  it('enter_in_the_command_input_sends_the_instruction', () => {
    expect(pressEnter(true, 'activity')).toEqual({ prevented: true, sent: true });
  });
});
