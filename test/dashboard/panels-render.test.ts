import { describe, it, expect } from '../support/harness.ts';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// A tiny DOM: enough for desktops.js and suggestions.js to build their sections.
class El {
  tag: string; className = ''; textContent = ''; title = ''; disabled = false; checked = false; selected = false; value = '';
  children: El[] = []; attrs: Record<string, string> = {};
  listeners: Record<string, (e?: unknown) => void> = {};
  classList = { add: (...c: string[]) => { this.className = [this.className, ...c].join(' ').trim(); },
    remove: (...c: string[]) => { this.className = this.className.split(' ').filter((x) => !c.includes(x)).join(' '); } };
  constructor(tag: string) { this.tag = tag; }
  appendChild(c: El): El { this.children.push(c); return c; }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; if (k === 'value') this.value = v; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  contains(e: El): boolean { return this.all().includes(e); }
  addEventListener(type: string, fn: (e?: unknown) => void): void { this.listeners[type] = fn; }
  get lastChild(): El { return this.children[this.children.length - 1]; }
  all(): El[] { return [this as El].concat(...this.children.map((c) => c.all())); }
  text(): string { return this.textContent + this.children.map((c) => c.text()).join(''); }
}

function load(files: string[], extra: Record<string, unknown> = {}) {
  const window: Record<string, unknown> = { confirm: () => true, ...extra };
  const body = new El('body');
  const page: { rows: El[] } = { rows: [] };
  const docListeners: Record<string, (e?: unknown) => void> = {};
  const document = { createElement: (t: string) => new El(t), body, querySelectorAll: () => page.rows,
    addEventListener: (type: string, fn: (e?: unknown) => void) => { docListeners[type] = fn; } };
  const ctx = { window, document, setTimeout, Date, URL, Promise, JSON };
  for (const f of files) runInNewContext(readFileSync(new URL(`../../src/dashboard/${f}`, import.meta.url), 'utf8'), ctx);
  const h = (tag: string, cls: string | null, text: string | null, attrs?: Record<string, string>) => {
    const el = new El(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    if (attrs) Object.keys(attrs).forEach((k) => el.setAttribute(k, attrs[k]));
    return el;
  };
  const add = (parent: El, ...kids: (El | null)[]) => { kids.forEach((k) => k && parent.appendChild(k)); return parent; };
  const button = (label: string, cls: string, key: string, onClick: () => void, disabled?: boolean, title?: string) => {
    const b = h('button', `ctx-btn ${cls}`, label, { 'data-fk': key });
    b.disabled = !!disabled; if (title) b.title = title; b.addEventListener('click', onClick);
    return b;
  };
  const acted: string[] = [];
  const deps = { h, add, button, act: (key: string) => { acted.push(key); return Promise.resolve(); }, request: () => Promise.resolve(null), busy: {} };
  return { window, deps, acted, body, page, docListeners };
}

const owned = 'Desktop 1 belongs to devx. Give devx another desktop first.';
const raw = {
  desktops: [
    { number: 1, screen: 1, screenLabel: 'Laptop', owners: [{ id: 'd', name: 'devx' }], windows: 2, closeBlocked: owned },
    { number: 2, screen: 1, screenLabel: 'Laptop', owners: [], windows: 0, closeBlocked: null },
    { number: 3, screen: 1, screenLabel: 'Laptop', owners: [], windows: 1, closeBlocked: null },
    { number: 4, screen: 1, screenLabel: 'Laptop', shared: true, owners: [], windows: 0, closeBlocked: null },
  ],
  screens: [{ screen: 1, label: 'Laptop', addBlocked: null }],
};

describe('desktops panel', () => {
  const { window, deps } = load(['contexts-logic.js', 'desktops.js']);
  const desktops = window.MCDesktops as ((d: unknown) => { section: (d: unknown, control: boolean) => El }) & { normalize: (r: unknown) => unknown };
  const d = { desktopList: desktops.normalize(raw), contexts: [{ id: 'd', name: 'devx', key: 1 }], desktopCount: 4 };
  const box = desktops(deps).section(d, true);
  const rows = box.all().filter((e) => e.className.startsWith('ctx-desktop-row'));

  const find = (root: El, key: string) => root.all().find((e) => e.attrs['data-fk'] === key)!;

  it('every_tile_has_the_same_parts_and_owners_show_as_chips', () => {
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.children.length)).toEqual([3, 3, 3, 3]);
    expect(rows[0].text()).toMatch(/devx/);
    expect(rows[0].all().some((e) => e.className.includes('ctx-desk-chip'))).toBe(true);
    expect(rows[1].text()).toMatch(/Free/);
    expect(rows[3].text()).toMatch(/Shared/);
    expect(box.text()).not.toMatch(/Give devx another desktop first/);
    expect(box.all().some((e) => e.attrs['data-fk'] === 'desktopAdd:1')).toBe(true);
  });

  it('clicking_a_tile_goes_to_that_desktop', () => {
    const { window, deps, acted } = load(['contexts-logic.js', 'desktops.js']);
    const ui = (window.MCDesktops as typeof desktops)(deps).section(d, true);
    const tile = ui.all().filter((e) => e.className.startsWith('ctx-desktop-row'))[1];
    tile.listeners.click({ target: tile });
    expect(acted).toEqual(['desktopShow:2']);
  });

  it('select_mode_shows_boxes_and_a_blocked_desktop_says_why', () => {
    find(box, 'desktopSelect').listeners.click();
    expect(box.className).toContain('selecting');
    const blocked = find(rows[0], 'desktopPick:1');
    expect(blocked.disabled).toBe(true);
    expect(blocked.title).toBe(owned);
  });

  it('ticking_boxes_updates_one_close_button_with_the_real_count', () => {
    const batch = find(box, 'desktopBatch');
    expect(batch.disabled).toBe(true);
    for (const n of [2, 3]) { const b = find(box, `desktopPick:${n}`); b.checked = true; b.listeners.change(); }
    expect(batch.textContent).toBe('Close 2 desktops');
    expect(batch.disabled).toBe(false);
  });

  it('a_blocked_tile_says_why_in_select_mode_and_done_clears_every_tick', () => {
    expect(rows[0].title).toBe(owned);
    find(box, 'desktopSelect').listeners.click();
    expect(box.className).not.toContain('selecting');
    expect([2, 3].map((n) => find(box, `desktopPick:${n}`).checked)).toEqual([false, false]);
    expect(rows[0].title).toBe('');
    expect(find(box, 'desktopBatch').disabled).toBe(true);
  });
});

describe('dragging a project chip onto another desktop tile', () => {
  const { window, deps, acted, body, page } = load(['contexts-logic.js', 'desktops.js']);
  const desktops = window.MCDesktops as ((d: unknown) => { section: (d: unknown, control: boolean) => El }) & { normalize: (r: unknown) => unknown };
  const d = { desktopList: desktops.normalize(raw), contexts: [{ id: 'd', name: 'devx', key: 1 }], desktopCount: 4 };
  const editing: boolean[] = [];
  const box = desktops({ ...deps, editing: (on: boolean) => editing.push(on) }).section(d, true);
  page.rows = box.all().filter((e) => e.className.includes('ctx-desk-tile'));
  const chip = page.rows[0].all().find((e) => e.className.includes('ctx-desk-chip'))!;
  const transfer = { setData: () => {}, effectAllowed: '', dropEffect: '' };
  const event = () => { const e = { prevented: false, dataTransfer: transfer, stopPropagation: () => {}, preventDefault: () => { e.prevented = true; } }; return e; };

  it('free_tiles_invite_the_drop_while_its_own_and_the_shared_tile_fade', () => {
    expect(chip.attrs.draggable).toBe('true');
    chip.listeners.dragstart(event());
    expect(body.className).toContain('ctx-swapping');
    expect(page.rows.map((r) => r.className.includes('swap-ok'))).toEqual([false, true, true, false]);
    expect(page.rows[1].attrs['data-drop-note']).toBe('Move devx here');
    expect(page.rows[3].attrs['data-drop-note']).toBe('The shared desktop holds no project');
  });

  it('dropping_gives_the_project_that_desktop', () => {
    const own = event();
    page.rows[0].listeners.dragover(own);
    expect(own.prevented).toBe(false);
    page.rows[2].listeners.drop(event());
    expect(acted).toEqual(['desktopKey:d']);
    expect(body.className).not.toContain('ctx-swapping');
    expect(editing).toEqual([true, false]);
  });
});

describe('suggestions panel', () => {
  const { window, deps, acted } = load(['contexts-logic.js', 'suggestions.js']);
  const ui = (window.MCSuggestions as (d: unknown) => { section: (d: unknown, control: boolean, tip: string) => El })(deps);
  const url = 'https://gitlab.example.com/devx/svc/-/pipelines/1';
  const s = (id: string, u: string) => ({ id, url: u, title: 'Pipeline', toContextId: 'svc', fromWindowKey: 'w1' });
  const d = {
    suggestions: [s('a', url), s('b', url), s('c', `${url}0`)],
    contexts: [{ id: 'sy', name: 'switchyard', windows: [{ key: 'w1' }] }, { id: 'svc', name: 'svc', windows: [] }],
  };
  const box = ui.section(d, true, '');

  it('folds_duplicate_tabs_and_offers_one_move_all', () => {
    const text = box.text();
    expect(box.all().filter((e) => e.className === 'ctx-suggest-row')).toHaveLength(2);
    expect(text).toMatch(/2 tabs in switchyard’s window · belongs with svc/);
    expect(text).not.toMatch(/looks like/);
    const all = box.all().find((e) => e.attrs['data-fk'] === 'acceptAll:svc')!;
    expect(all.textContent).toBe('Move all to svc');
    all.listeners.click();
    expect(acted).toEqual(['acceptAll:svc']);
  });
});

describe('dragging a window onto a desktop row', () => {
  const { window, deps, acted, body, page } = load(['contexts-logic.js', 'dragdrop.js', 'desktops.js']);
  const desktops = window.MCDesktops as ((d: unknown) => { section: (d: unknown, control: boolean) => El }) & { normalize: (r: unknown) => unknown };
  const d = { desktopList: desktops.normalize(raw), contexts: [{ id: 'd', name: 'devx', key: 1 }], desktopCount: 4 };
  const editing: boolean[] = [];
  const all = { ...deps, data: () => d, editing: (on: boolean) => editing.push(on) };
  const drag = (window.MCDragDrop as (x: unknown) => { source: (li: El, w: unknown, from: unknown, label: string) => void })(all);
  const box = desktops({ ...all, drag }).section(d, true);
  page.rows = box.all().filter((e) => e.className.startsWith('ctx-desktop-row'));
  const win = new El('li');
  drag.source(win, { key: 'w1', app: 'Chrome' }, null, 'Docs');
  const transfer = { setData: () => {}, setDragImage: () => {}, effectAllowed: '', dropEffect: '' };
  const event = () => { const e = { prevented: false, dataTransfer: transfer, relatedTarget: null, preventDefault: () => { e.prevented = true; } }; return e; };

  it('window_rows_are_draggable_and_owned_rows_light_up_while_the_rest_dim', () => {
    expect(win.attrs.draggable).toBe('true');
    win.listeners.dragstart(event());
    expect(body.className).toContain('ctx-dragging');
    expect(page.rows.map((r) => r.className.includes('drop-ok'))).toEqual([true, false, false, false]);
    expect(page.rows[3].title).toMatch(/shared/);
    expect(editing).toEqual([true]);
  });

  it('only_an_owned_row_accepts_the_drop_and_dropping_assigns_with_undo', () => {
    const free = event();
    page.rows[1].listeners.dragover(free);
    expect(free.prevented).toBe(false);
    const owned = event();
    page.rows[0].listeners.dragover(owned);
    expect(owned.prevented).toBe(true);
    page.rows[0].listeners.drop(event());
    expect(acted).toEqual(['drop:w1']);
    expect(body.className).not.toContain('ctx-dragging');
    expect(editing).toEqual([true, false]);
  });
});

describe('dragging a window onto a context card or onto Unsorted', () => {
  type Drag = { source: (li: El, w: unknown, from: unknown, label: string) => void; card: (el: El, c: unknown) => void; unsorted: (el: El) => void };
  const { window, deps, body, page, docListeners } = load(['contexts-logic.js', 'dragdrop.js']);
  const sent: { method: string; path: string; body: unknown }[] = [];
  const results: Promise<{ notice: string; followUp?: { label: string; toast: boolean; run: () => Promise<{ notice: string }> } }>[] = [];
  const editing: boolean[] = [];
  const all = { ...deps, data: () => ({ desktopList: null }), editing: (on: boolean) => editing.push(on),
    request: (method: string, path: string, b: unknown) => { sent.push({ method, path, body: b }); return Promise.resolve({ moving: false, desktop: null }); },
    act: (_key: string, fn: () => Promise<never>) => { results.push(fn()); return Promise.resolve(); } };
  const drag = (window.MCDragDrop as (x: unknown) => Drag)(all);
  const devx = new El('article'), aral = new El('article'), box = new El('section');
  drag.card(devx, { id: 'd', name: 'devx' });
  drag.card(aral, { id: 'a', name: 'aral' });
  drag.unsorted(box);
  page.rows = [devx, aral, box];
  const sorted = new El('li'), loose = new El('li');
  drag.source(sorted, { key: 'w1', app: 'Chrome' }, { id: 'd', name: 'devx' }, 'Docs');
  drag.source(loose, { key: 'w2', app: 'Ghostty' }, null, 'zsh');
  const transfer = { data: {} as Record<string, string>, setData(t: string, v: string) { this.data[t] = v; }, clearData() { this.data = {}; },
    setDragImage: () => {}, effectAllowed: '', dropEffect: '' };
  const event = () => { const e = { prevented: false, dataTransfer: transfer, relatedTarget: null, target: null, preventDefault: () => { e.prevented = true; } }; return e; };

  it('rows_drag_even_without_desktops_and_carry_text_for_firefox', () => {
    expect(sorted.attrs.draggable).toBe('true');
    expect(sorted.children[0].className).toBe('ctx-w-grip');
    expect(sorted.children[0].attrs['aria-hidden']).toBe('true');
    sorted.listeners.dragstart(event());
    expect(transfer.data['text/plain']).toBe('Docs');
    expect(transfer.effectAllowed).toBe('move');
  });

  it('the_own_card_dims_and_says_already_there_while_other_targets_light_up', () => {
    expect(devx.className).toContain('drop-off');
    expect(devx.attrs['data-drop-note']).toBe('Already in devx');
    expect(aral.className).toContain('drop-ok');
    expect(box.className).toContain('drop-ok');
    expect(aral.attrs.tabindex).toBe(undefined);
  });

  it('dropping_on_a_card_assigns_and_undo_assigns_back', async () => {
    const over = event();
    aral.listeners.dragover(over);
    expect(over.prevented).toBe(true);
    expect(transfer.dropEffect).toBe('move');
    expect(aral.className).toContain('drop-over');
    aral.listeners.drop(event());
    expect(aral.className).not.toContain('drop-');
    expect(aral.attrs['data-drop-note']).toBe(undefined);
    const res = await results[0];
    expect(sent[0]).toEqual({ method: 'POST', path: '/api/contexts/assign', body: { windowKey: 'w1', contextId: 'a' } });
    expect(res.notice).toBe('Moved to aral');
    expect(res.followUp!.toast).toBe(true);
    expect((await res.followUp!.run()).notice).toBe('Moved back to devx');
    expect(sent[1]).toEqual({ method: 'POST', path: '/api/contexts/assign', body: { windowKey: 'w1', contextId: 'd' } });
  });

  it('dropping_on_unsorted_unassigns_and_undo_assigns_back', async () => {
    sorted.listeners.dragstart(event());
    box.listeners.drop(event());
    const res = await results[1];
    expect(sent[2]).toEqual({ method: 'POST', path: '/api/contexts/unassign', body: { windowKey: 'w1' } });
    expect(res.notice).toBe('Moved to Unsorted');
    await res.followUp!.run();
    expect(sent[3]).toEqual({ method: 'POST', path: '/api/contexts/assign', body: { windowKey: 'w1', contextId: 'd' } });
  });

  it('an_unsorted_window_cannot_drop_on_unsorted', () => {
    loose.listeners.dragstart(event());
    expect(box.className).toContain('drop-off');
    const over = event();
    box.listeners.dragover(over);
    expect(over.prevented).toBe(false);
    box.listeners.drop(event());
    expect(sent).toHaveLength(4);
  });

  it('every_way_a_drag_ends_releases_the_hold', () => {
    loose.listeners.dragend(event()); // Esc, a drop outside the window or on nothing all end in dragend
    expect(body.className).not.toContain('ctx-dragging');
    expect(box.className).not.toContain('drop-');
    loose.listeners.dragstart(event());
    docListeners.dragend(event()); // the row was gone by then: the page still hears it
    expect(body.className).not.toContain('ctx-dragging');
    expect(editing.filter((on) => on).length).toBe(editing.filter((on) => !on).length);
  });
});
