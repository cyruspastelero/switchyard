import { describe, it, expect } from '../support/harness.ts';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = (f: string) => readFileSync(new URL(`../../src/dashboard/${f}`, import.meta.url), 'utf8');
const app = read('app.js');
const activity = read('activity.js');
const usage = read('usage.js');
const indexHtml = read('index.html');

/** A top-level function declaration from a dashboard script, as source text. */
function fn(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found`);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

type Key = { key: string; tag?: string; view?: 'contexts' | 'overview'; shiftKey?: boolean };

/** Runs app.js's document keydown listener for one key press and records what it did. */
function press({ key, tag = 'BODY', view = 'overview', shiftKey = false }: Key) {
  const start = app.indexOf("document.addEventListener('keydown', function (e) {");
  const source = app.slice(start, app.indexOf('\n});\n', start) + 4);
  let handler: (e: unknown) => void = () => { throw new Error('no keydown listener'); };
  const did = { prevented: false, cycled: [] as number[], selected: false, rows: [] as number[] };
  runInNewContext(source, {
    document: {
      addEventListener: (_: string, h: (e: unknown) => void) => { handler = h; },
      body: { classList: { contains: (c: string) => c === `view-${view}` } },
    },
    $commandInput: { tagName: 'INPUT' },
    $kbdHelp: { classList: { contains: () => true } },
    state: { timelineFilter: null, selectedAgentId: null },
    sendInstruction: () => {},
    cyclePanels: (d: number) => { did.cycled.push(d); },
    navigateRows: (d: number) => { did.rows.push(d); },
    selectFocusedRow: () => { did.selected = true; },
    toggleHelp: () => {},
    setTimelineFilter: () => {},
  });
  handler({ key, shiftKey, target: { tagName: tag }, preventDefault: () => { did.prevented = true; } });
  return did;
}

describe('Activity keyboard', () => {
  it('tab_in_the_activity_view_is_left_to_the_browser', () => {
    const did = press({ key: 'Tab' });
    expect(did.prevented).toBe(false);
    expect(did.cycled).toEqual([]);
  });

  it('square_brackets_switch_the_focused_panel', () => {
    expect(press({ key: ']' }).cycled).toEqual([1]);
    expect(press({ key: '[' }).cycled).toEqual([-1]);
  });

  it('j_k_and_enter_still_drive_rows_when_nothing_is_focused', () => {
    expect(press({ key: 'j' }).rows).toEqual([1]);
    expect(press({ key: 'k' }).rows).toEqual([-1]);
    expect(press({ key: 'Enter' }).selected).toBe(true);
  });

  it('enter_on_a_focused_button_is_left_to_the_button', () => {
    const did = press({ key: 'Enter', tag: 'BUTTON' });
    expect(did.selected).toBe(false);
    expect(did.prevented).toBe(false);
  });
});

// A tiny DOM element: enough for buildTimelineRowEl.
class El {
  tag: string; className = ''; textContent = ''; title = ''; tabIndex = -1;
  style: Record<string, string> = {}; children: El[] = []; attrs: Record<string, string> = {};
  listeners: Record<string, (e?: unknown) => void> = {};
  scrolled = false;
  classList = { add: (c: string) => { this.className += ' ' + c; }, remove: (c: string) => { this.className = this.className.replace(' ' + c, ''); } };
  constructor(tag: string) { this.tag = tag; }
  appendChild(c: El): El { this.children.push(c); return c; }
  setAttribute(k: string, v: string): void { this.attrs[k] = String(v); }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  addEventListener(type: string, f: (e?: unknown) => void): void { this.listeners[type] = f; }
  querySelector(sel: string): El | null { return this.children.find((c) => c.className === sel.slice(1)) ?? null; }
  remove(): void { /* detached by the test's querySelector filter below */ }
  scrollIntoView(): void { this.scrolled = true; }
}

function timelineRow(evt: unknown, agents: unknown[]) {
  const source = [
    fn(activity, 'isMainAgentId'), fn(activity, 'agentDisplayName'), fn(activity, 'agentLabelFor'),
    fn(usage, 'getEventDetail'), fn(usage, 'getExpandedDetail'), fn(usage, 'buildTimelineRowEl'),
    'buildTimelineRowEl(evt)',
  ].join('\n');
  const createEl = (tag: string, attrs: Record<string, unknown> = {}, kids: El[] = []) => {
    const el = new El(tag);
    for (const k of Object.keys(attrs)) {
      if (k.startsWith('data-') || k === 'style') el.setAttribute(k, String(attrs[k]));
      else (el as unknown as Record<string, unknown>)[k] = attrs[k];
    }
    kids.forEach((c) => c && el.appendChild(c));
    return el;
  };
  return runInNewContext(source, {
    evt, createEl, state: { agents, timelineFilter: null },
    getAgentColor: () => '#fff', formatTime: () => '17:51:44',
  }) as El;
}

describe('timeline rows', () => {
  const agents = [{ id: 'sess-1:main', session_id: 'sess-1', agent_id: 'sess-1:main', name: 'switchyard — India' }];
  const evt = { agent_id: 'sess-1:main', tool_name: 'Bash', tool_input: { command: 'npm test' }, timestamp: 't' };

  it('an_expandable_row_is_a_focusable_button_that_enter_expands', () => {
    const row = timelineRow(evt, agents);
    expect(row.attrs.role).toBe('button');
    expect(row.tabIndex).toBe(0);
    expect(row.attrs['aria-expanded']).toBe('false');
    let prevented = false;
    row.listeners.keydown({ key: 'Enter', preventDefault: () => { prevented = true; }, stopPropagation: () => {} });
    expect(prevented).toBe(true);
    expect(row.attrs['aria-expanded']).toBe('true');
    expect(row.children.some((c) => c.className === 'timeline-expanded')).toBe(true);
  });
});

describe('mission copy', () => {
  it('nothing_promises_a_new_mission_shortcut_that_does_not_exist', () => {
    expect(activity).not.toMatch(/press n\b/);
    expect(indexHtml).not.toMatch(/<kbd>n<\/kbd>/);
    expect(indexHtml).not.toMatch(/<kbd>Tab<\/kbd><span class="kbd-desc">Cycle panels/);
  });
});
