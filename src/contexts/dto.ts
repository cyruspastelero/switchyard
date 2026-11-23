// Request DTO validation. Every body is parsed into a typed value; unknown fields are rejected.

import type { BrowserInfo, BrowserTab, DesktopsInfo, Snapshot, SnapshotWindow } from './types.ts';

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (error: string): Parsed<never> => ({ ok: false, error });

export const LIMITS = {
  snapshotBytes: 1_048_576,
  windows: 500,
  tabsPerWindow: 2_000,
  terminalTabs: 200,
  key: 512,
  text: 1_024,
  url: 4_096,
  name: 100,
  desktop: 16,
} as const;

type Obj = Record<string, unknown>;

function asObject(v: unknown, what: string): Parsed<Obj> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(`${what} must be an object`);
  return ok(v as Obj);
}

function checkKeys(obj: Obj, allowed: readonly string[], what: string): string | null {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  return extra.length > 0 ? `${what} has unknown field(s): ${extra.join(', ')}` : null;
}

function str(obj: Obj, field: string, max: number, opts: { empty?: boolean } = {}): Parsed<string> {
  const v = obj[field];
  if (typeof v !== 'string') return fail(`${field} must be a string`);
  if (!opts.empty && v.trim().length === 0) return fail(`${field} must not be empty`);
  if (v.length > max) return fail(`${field} exceeds ${max} characters`);
  return ok(v);
}

function nullableStr(obj: Obj, field: string, max: number): Parsed<string | null> {
  const v = obj[field];
  if (v === undefined || v === null) return ok(null);
  return str(obj, field, max, { empty: true });
}

function idValue(v: unknown, field: string): Parsed<string | number> {
  if (typeof v === 'string' && v.length > 0 && v.length <= LIMITS.key) return ok(v);
  if (typeof v === 'number' && Number.isFinite(v)) return ok(v);
  return fail(`${field} must be a string or number`);
}

/** Runs parsers in order and returns the first failure. */
function all<T extends object>(parts: { [K in keyof T]: Parsed<T[K]> }): Parsed<T> {
  const out: Obj = {};
  for (const [k, p] of Object.entries(parts) as [string, Parsed<unknown>][]) {
    if (!p.ok) return p;
    out[k] = p.value;
  }
  return ok(out as T);
}

function parseTab(raw: unknown): Parsed<BrowserTab> {
  const o = asObject(raw, 'tab');
  if (!o.ok) return o;
  const extra = checkKeys(o.value, ['id', 'url', 'title'], 'tab');
  if (extra) return fail(extra);
  const tab = all<{ id: string | number; url: string; title: string | null }>({
    id: idValue(o.value.id, 'tab.id'),
    url: str(o.value, 'url', LIMITS.url, { empty: true }),
    title: nullableStr(o.value, 'title', LIMITS.text),
  });
  return tab.ok ? ok({ ...tab.value, title: tab.value.title ?? '' }) : tab;
}

function parseBrowser(raw: unknown): Parsed<BrowserInfo | null> {
  if (raw === undefined || raw === null) return ok(null);
  const o = asObject(raw, 'browser');
  if (!o.ok) return o;
  const extra = checkKeys(o.value, ['windowId', 'name', 'tabs', 'activeTitle'], 'browser');
  if (extra) return fail(extra);
  const tabsRaw = o.value.tabs;
  if (!Array.isArray(tabsRaw)) return fail('browser.tabs must be an array');
  if (tabsRaw.length > LIMITS.tabsPerWindow) return fail(`browser.tabs exceeds ${LIMITS.tabsPerWindow}`);
  const tabs: BrowserTab[] = [];
  for (const t of tabsRaw) {
    const p = parseTab(t);
    if (!p.ok) return p;
    tabs.push(p.value);
  }
  const windowId = idValue(o.value.windowId, 'browser.windowId');
  if (!windowId.ok) return windowId;
  const name = nullableStr(o.value, 'name', LIMITS.text);
  if (!name.ok) return name;
  const activeTitle = nullableStr(o.value, 'activeTitle', LIMITS.text);
  if (!activeTitle.ok) return activeTitle;
  return ok({ windowId: windowId.value, name: name.value, tabs, activeTitle: activeTitle.value });
}

function desktopNumber(v: unknown, field: string): Parsed<number> {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > LIMITS.desktop) {
    return fail(`${field} must be an integer 1-${LIMITS.desktop}`);
  }
  return ok(v);
}

function nullableDesktop(v: unknown, field: string): Parsed<number | null> {
  return v === null ? ok(null) : desktopNumber(v, field);
}

function parseDesktops(raw: unknown): Parsed<DesktopsInfo | null> {
  if (raw === null) return ok(null);
  const o = asObject(raw, 'desktops');
  if (!o.ok) return o;
  const extra = checkKeys(o.value, ['count', 'active'], 'desktops');
  if (extra) return fail(extra);
  const count = desktopNumber(o.value.count, 'desktops.count');
  if (!count.ok) return count;
  const active = nullableDesktop(o.value.active ?? null, 'desktops.active');
  if (!active.ok) return active;
  if (active.value !== null && active.value > count.value) return fail('desktops.active exceeds desktops.count');
  return ok({ count: count.value, active: active.value });
}

function parseWindow(raw: unknown): Parsed<SnapshotWindow> {
  const o = asObject(raw, 'window');
  if (!o.ok) return o;
  const extra = checkKeys(o.value, ['key', 'app', 'bundleId', 'pid', 'title', 'document', 'browser', 'desktop', 'tabTitles'], 'window');
  if (extra) return fail(extra);
  const pid = o.value.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 0) return fail('window.pid must be a non-negative integer');
  const parts = all<{ key: string; app: string; bundleId: string; title: string | null; document: string | null }>({
    key: str(o.value, 'key', LIMITS.key),
    app: str(o.value, 'app', LIMITS.text),
    bundleId: str(o.value, 'bundleId', LIMITS.text),
    title: nullableStr(o.value, 'title', LIMITS.text),
    document: nullableStr(o.value, 'document', LIMITS.url),
  });
  if (!parts.ok) return parts;
  const browser = parseBrowser(o.value.browser);
  if (!browser.ok) return browser;
  const tabTitles = parseTabTitles(o.value.tabTitles);
  if (!tabTitles.ok) return tabTitles;
  const base = { ...parts.value, title: parts.value.title ?? '', pid, browser: browser.value, ...tabTitles.value };
  if (!('desktop' in o.value)) return ok(base);
  const desktop = nullableDesktop(o.value.desktop, 'window.desktop');
  return desktop.ok ? ok({ ...base, desktop: desktop.value }) : desktop;
}

function parseTabTitles(raw: unknown): Parsed<{ tabTitles?: readonly string[] }> {
  if (raw === undefined) return ok({});
  if (!Array.isArray(raw) || raw.length > LIMITS.terminalTabs) return fail(`window.tabTitles must be an array of at most ${LIMITS.terminalTabs}`);
  if (!raw.every((t) => typeof t === 'string' && t.length <= LIMITS.text)) return fail('window.tabTitles must hold short strings');
  return ok({ tabTitles: raw as string[] });
}

export function parseSnapshot(body: unknown): Parsed<Snapshot> {
  const o = asObject(body, 'body');
  if (!o.ok) return o;
  const extra = checkKeys(o.value, ['windows', 'desktops', 'canCarry'], 'body');
  if (extra) return fail(extra);
  const raw = o.value.windows;
  if (!Array.isArray(raw)) return fail('windows must be an array');
  if (raw.length > LIMITS.windows) return fail(`windows exceeds ${LIMITS.windows}`);
  const windows: SnapshotWindow[] = [];
  const seen = new Set<string>();
  for (const w of raw) {
    const p = parseWindow(w);
    if (!p.ok) return p;
    if (seen.has(p.value.key)) return fail(`duplicate window key: ${p.value.key}`);
    seen.add(p.value.key);
    windows.push(p.value);
  }
  const out: { windows: SnapshotWindow[]; desktops?: DesktopsInfo | null; canCarry?: boolean } = { windows };
  if ('desktops' in o.value) {
    const d = parseDesktops(o.value.desktops);
    if (!d.ok) return d;
    out.desktops = d.value;
  }
  if ('canCarry' in o.value) {
    if (typeof o.value.canCarry !== 'boolean') return fail('canCarry must be a boolean');
    out.canCarry = o.value.canCarry;
  }
  return ok(out);
}

// --- Small DTOs ---------------------------------------------------------------

export interface CreateContextDto { readonly name: string }
export interface PatchContextDto { readonly name?: string; readonly color?: string; readonly key?: number | null }
export interface AssignDto { readonly windowKey: string; readonly contextId: string }
export interface UnassignDto { readonly windowKey: string }
export interface WindowNameDto { readonly windowKey: string; readonly name: string }
export interface AckDto { readonly ok: boolean; readonly error: string | null; readonly failedKeys: readonly string[] }

function strict(body: unknown, allowed: readonly string[]): Parsed<Obj> {
  const o = asObject(body, 'body');
  if (!o.ok) return o;
  const extra = checkKeys(o.value, allowed, 'body');
  return extra ? fail(extra) : o;
}

export function parseCreateContext(body: unknown): Parsed<CreateContextDto> {
  const o = strict(body, ['name']);
  if (!o.ok) return o;
  const name = str(o.value, 'name', LIMITS.name);
  return name.ok ? ok({ name: name.value.trim() }) : name;
}

export function parsePatchContext(body: unknown): Parsed<PatchContextDto> {
  const o = strict(body, ['name', 'color', 'key']);
  if (!o.ok) return o;
  const out: { name?: string; color?: string; key?: number | null } = {};
  if ('name' in o.value) {
    const n = str(o.value, 'name', LIMITS.name);
    if (!n.ok) return n;
    out.name = n.value.trim();
  }
  if ('color' in o.value) {
    const c = o.value.color;
    if (typeof c !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c)) return fail('color must be a #rrggbb string');
    out.color = c.toLowerCase();
  }
  if ('key' in o.value) {
    const k = o.value.key;
    if (k !== null && !(typeof k === 'number' && Number.isInteger(k) && k >= 1 && k <= 9)) {
      return fail('key must be an integer 1-9 or null');
    }
    out.key = k as number | null;
  }
  return Object.keys(out).length === 0 ? fail('no fields to update') : ok(out);
}

export function parseAssign(body: unknown): Parsed<AssignDto> {
  const o = strict(body, ['windowKey', 'contextId']);
  if (!o.ok) return o;
  return all<AssignDto>({ windowKey: str(o.value, 'windowKey', LIMITS.key), contextId: str(o.value, 'contextId', 100) });
}

export function parseUnassign(body: unknown): Parsed<UnassignDto> {
  const o = strict(body, ['windowKey']);
  if (!o.ok) return o;
  const key = str(o.value, 'windowKey', LIMITS.key);
  return key.ok ? ok({ windowKey: key.value }) : key;
}

/** POST /windows/focus: the same one-field body as unassign. */
export const parseFocusWindow = parseUnassign;

export function parseWindowName(body: unknown): Parsed<WindowNameDto> {
  const o = strict(body, ['windowKey', 'name']);
  if (!o.ok) return o;
  const name = str(o.value, 'name', LIMITS.name);
  const key = str(o.value, 'windowKey', LIMITS.key);
  if (!name.ok) return name;
  if (!key.ok) return key;
  return ok({ windowKey: key.value, name: name.value.trim() });
}

export function parseAck(body: unknown): Parsed<AckDto> {
  const o = strict(body, ['ok', 'error', 'failedKeys']);
  if (!o.ok) return o;
  if (typeof o.value.ok !== 'boolean') return fail('ok must be a boolean');
  const err = nullableStr(o.value, 'error', LIMITS.text);
  if (!err.ok) return err;
  const raw = o.value.failedKeys ?? [];
  if (!Array.isArray(raw) || raw.length > LIMITS.windows) return fail(`failedKeys must be an array of at most ${LIMITS.windows}`);
  if (!raw.every((k) => typeof k === 'string' && k.length > 0 && k.length <= LIMITS.key)) return fail('failedKeys must be window keys');
  return ok({ ok: o.value.ok, error: err.value, failedKeys: raw as string[] });
}

/** Bodies for endpoints that take none: an empty object is fine, fields are not. */
export function parseEmpty(body: unknown): Parsed<Record<string, never>> {
  const o = strict(body, []);
  return o.ok ? ok({}) : o;
}

export interface TidyDto { readonly contextId?: string; readonly desktop?: number }
export interface SettingsDto { readonly autoTidy: boolean }

/** POST /tidy: `{}`, `{ contextId }` or `{ desktop }`, never both. */
export function parseTidy(body: unknown): Parsed<TidyDto> {
  const o = strict(body, ['contextId', 'desktop']);
  if (!o.ok) return o;
  if ('contextId' in o.value && 'desktop' in o.value) return fail('give contextId or desktop, not both');
  if ('contextId' in o.value) {
    const id = str(o.value, 'contextId', 100);
    return id.ok ? ok({ contextId: id.value }) : id;
  }
  if ('desktop' in o.value) {
    const d = desktopNumber(o.value.desktop, 'desktop');
    return d.ok ? ok({ desktop: d.value }) : d;
  }
  return ok({});
}

/** POST /tidy/undo: `{}` or `{ desktop }`. */
export function parseUndoTidy(body: unknown): Parsed<{ readonly desktop?: number }> {
  const o = strict(body, ['desktop']);
  if (!o.ok) return o;
  return parseTidy(o.value);
}

export function parseSettings(body: unknown): Parsed<SettingsDto> {
  const o = strict(body, ['autoTidy']);
  if (!o.ok) return o;
  if (typeof o.value.autoTidy !== 'boolean') return fail('autoTidy must be a boolean');
  return ok({ autoTidy: o.value.autoTidy });
}
