import { describe, it, expect } from '../support/harness.ts';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const core = readFileSync(new URL('../../src/dashboard/core.js', import.meta.url), 'utf8');

describe('page-wide listeners', () => {
  it('a_capturing_listener_on_the_document_survives_the_document_as_target', () => {
    // Capture-phase mouseenter on document also fires for the document itself, which has no closest().
    const start = core.indexOf('function closestIn(');
    expect(start).toBeGreaterThan(-1);
    const closestIn = runInNewContext(`(${core.slice(start, core.indexOf('\n}', start) + 2)})`) as (n: unknown, s: string) => unknown;
    expect(closestIn({ nodeType: 9 }, '[data-tooltip]')).toBeNull();
    expect(closestIn({ closest: () => 'hit' }, '[data-tooltip]')).toBe('hit');
    expect(core).not.toMatch(/addEventListener\('mouse(enter|leave)', function \(e\) \{\n\s+var target = e\.target\.closest/);
  });
});
