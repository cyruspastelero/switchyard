// Layout presets: an arrangement the owner made by hand, saved from the Mac app and reused by Tidy.
// Slot frames are fractions of their screen's visible area, so a preset survives a different monitor size.

import crypto from 'node:crypto';
import type { Db } from '../sqlite.ts';
import { ContextsError } from './types.ts';
import type { Parsed } from './dto.ts';

export interface LayoutSlot {
  readonly bundleId: string;
  readonly app: string;
  readonly screen: { readonly uuid: string; readonly builtin: boolean };
  readonly frame: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

export interface LayoutPreset {
  readonly id: string;
  readonly name: string;
  /** Front to back, as captured. */
  readonly slots: readonly LayoutSlot[];
  readonly createdAt: string;
}

export interface CreateLayoutDto { readonly name: string; readonly slots: readonly LayoutSlot[] }

/** A context's `layoutId` that means "automatic layout, whatever the default". Not valid as the default. */
export const AUTO_LAYOUT = 'auto';

export const LAYOUT_LIMITS = { name: 100, slots: 50, bundleId: 200, app: 100, uuid: 64, presets: 100 } as const;

// --- DTOs ---------------------------------------------------------------------

type Obj = Record<string, unknown>;
const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (error: string): Parsed<never> => ({ ok: false, error });

function object(v: unknown, what: string, allowed: readonly string[]): Parsed<Obj> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(`${what} must be an object`);
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  return extra.length > 0 ? fail(`${what} has unknown field(s): ${extra.join(', ')}`) : ok(v as Obj);
}

function text(v: unknown, field: string, min: number, max: number): Parsed<string> {
  if (typeof v !== 'string') return fail(`${field} must be a string`);
  const t = v.trim();
  if (t.length < min) return fail(`${field} must not be empty`);
  if (t.length > max) return fail(`${field} exceeds ${max} characters`);
  return ok(t);
}

export function parseLayoutName(v: unknown): Parsed<string> {
  return text(v, 'name', 1, LAYOUT_LIMITS.name);
}

function fraction(v: unknown, field: string, positive: boolean): Parsed<number> {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1 || (positive && v === 0)) {
    return fail(`${field} must be a number ${positive ? 'above 0' : 'from 0'} to 1`);
  }
  return ok(v);
}

function parseFrame(raw: unknown): Parsed<LayoutSlot['frame']> {
  const o = object(raw, 'slot.frame', ['x', 'y', 'w', 'h']);
  if (!o.ok) return o;
  const parts = [fraction(o.value.x, 'frame.x', false), fraction(o.value.y, 'frame.y', false),
    fraction(o.value.w, 'frame.w', true), fraction(o.value.h, 'frame.h', true)];
  for (const p of parts) if (!p.ok) return p;
  const [x, y, w, h] = parts.map((p) => (p as { value: number }).value);
  return ok({ x, y, w, h });
}

function parseSlot(raw: unknown): Parsed<LayoutSlot> {
  const o = object(raw, 'slot', ['bundleId', 'app', 'screen', 'frame']);
  if (!o.ok) return o;
  const bundleId = text(o.value.bundleId, 'slot.bundleId', 1, LAYOUT_LIMITS.bundleId);
  if (!bundleId.ok) return bundleId;
  const app = text(o.value.app ?? '', 'slot.app', 0, LAYOUT_LIMITS.app);
  if (!app.ok) return app;
  const screen = object(o.value.screen, 'slot.screen', ['uuid', 'builtin']);
  if (!screen.ok) return screen;
  const uuid = text(screen.value.uuid, 'screen.uuid', 0, LAYOUT_LIMITS.uuid);
  if (!uuid.ok) return uuid;
  if (typeof screen.value.builtin !== 'boolean') return fail('screen.builtin must be a boolean');
  const frame = parseFrame(o.value.frame);
  if (!frame.ok) return frame;
  return ok({ bundleId: bundleId.value, app: app.value, screen: { uuid: uuid.value, builtin: screen.value.builtin }, frame: frame.value });
}

export function parseSlots(raw: unknown): Parsed<readonly LayoutSlot[]> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > LAYOUT_LIMITS.slots) {
    return fail(`slots must be an array of 1-${LAYOUT_LIMITS.slots}`);
  }
  const slots: LayoutSlot[] = [];
  for (const s of raw) {
    const p = parseSlot(s);
    if (!p.ok) return p;
    slots.push(p.value);
  }
  return ok(slots);
}

/** POST /layouts `{ name, slots }`. */
export function parseCreateLayout(body: unknown): Parsed<CreateLayoutDto> {
  const o = object(body, 'body', ['name', 'slots']);
  if (!o.ok) return o;
  const name = parseLayoutName(o.value.name);
  if (!name.ok) return name;
  const slots = parseSlots(o.value.slots);
  return slots.ok ? ok({ name: name.value, slots: slots.value }) : slots;
}

/** PATCH /layouts/:id `{ name }`. */
export function parseRenameLayout(body: unknown): Parsed<{ readonly name: string }> {
  const o = object(body, 'body', ['name']);
  if (!o.ok) return o;
  const name = parseLayoutName(o.value.name);
  return name.ok ? ok({ name: name.value }) : name;
}

/** POST /layouts/capture `{}` or `{ name }`. */
export function parseCaptureLayout(body: unknown): Parsed<{ readonly name?: string }> {
  const o = object(body, 'body', ['name']);
  if (!o.ok) return o;
  if (!('name' in o.value)) return ok({});
  const name = parseLayoutName(o.value.name);
  return name.ok ? ok({ name: name.value }) : name;
}

/** `layoutId` in a context patch or the settings: a preset id, or null for none. */
export function parseLayoutRef(v: unknown, field: string): Parsed<string | null> {
  if (v === null) return ok(null);
  if (typeof v !== 'string' || v.length === 0 || v.length > 100) return fail(`${field} must be a layout id or null`);
  return ok(v);
}

// --- Store ----------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS layout_presets (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    slots      TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

/** Columns added to tables the context store owns. Runs after that store created them. */
function migrate(db: Db): void {
  const has = (table: string, column: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
  if (!has('contexts', 'layout_id')) db.exec('ALTER TABLE contexts ADD COLUMN layout_id TEXT');
  if (!has('context_settings', 'default_layout_id')) db.exec('ALTER TABLE context_settings ADD COLUMN default_layout_id TEXT');
}

type Row = { id: string; name: string; slots: string; created_at: string };
const toPreset = (r: Row): LayoutPreset => ({ id: r.id, name: r.name, slots: JSON.parse(r.slots) as LayoutSlot[], createdAt: r.created_at });

/** Presets plus which context and the default use them. Every change calls `changed`. */
export class LayoutPresets {
  private readonly db: Db;
  private readonly changed: () => void;
  private readonly now: () => number;

  constructor(db: Db, changed: () => void, now: () => number = Date.now) {
    this.db = db;
    this.changed = changed;
    this.now = now;
    db.exec(SCHEMA);
    migrate(db);
  }

  list(): readonly LayoutPreset[] {
    return (this.db.prepare('SELECT * FROM layout_presets ORDER BY created_at, rowid').all() as Row[]).map(toPreset);
  }

  get(id: string): LayoutPreset | undefined {
    const r = this.db.prepare('SELECT * FROM layout_presets WHERE id = ?').get(id) as Row | undefined;
    return r ? toPreset(r) : undefined;
  }

  require(id: string): LayoutPreset {
    const p = this.get(id);
    if (!p) throw new ContextsError(404, `No layout with id ${id}`);
    return p;
  }

  create(dto: CreateLayoutDto): LayoutPreset {
    if (this.list().length >= LAYOUT_LIMITS.presets) {
      throw new ContextsError(409, `There are already ${LAYOUT_LIMITS.presets} layouts. Delete one first.`);
    }
    const preset: LayoutPreset = { id: crypto.randomUUID(), name: dto.name, slots: dto.slots, createdAt: new Date(this.now()).toISOString() };
    this.db.prepare('INSERT INTO layout_presets (id, name, slots, created_at) VALUES (?, ?, ?, ?)')
      .run(preset.id, preset.name, JSON.stringify(preset.slots), preset.createdAt);
    this.changed();
    return preset;
  }

  rename(id: string, name: string): LayoutPreset {
    const p = this.require(id);
    this.db.prepare('UPDATE layout_presets SET name = ? WHERE id = ?').run(name, id);
    this.changed();
    return { ...p, name };
  }

  /** Contexts and the default that used it go back to none. */
  remove(id: string): void {
    this.require(id);
    this.db.transaction(() => {
      this.db.prepare('UPDATE contexts SET layout_id = NULL WHERE layout_id = ?').run(id);
      this.db.prepare('UPDATE context_settings SET default_layout_id = NULL WHERE default_layout_id = ?').run(id);
      this.db.prepare('DELETE FROM layout_presets WHERE id = ?').run(id);
    });
    this.changed();
  }

  /** The default name: the lowest "Layout N" not taken. */
  nextName(): string {
    const taken = new Set(this.list().map((p) => p.name));
    let n = 1;
    while (taken.has(`Layout ${n}`)) n += 1;
    return `Layout ${n}`;
  }

  contextLayouts(): ReadonlyMap<string, string> {
    const rows = this.db.prepare('SELECT id, layout_id FROM contexts WHERE layout_id IS NOT NULL').all() as { id: string; layout_id: string }[];
    return new Map(rows.map((r) => [r.id, r.layout_id]));
  }

  /** Throws 404 unless `layoutId` is null, 'auto' or a saved preset. */
  checkContextRef(layoutId: string | null): void {
    if (layoutId !== null && layoutId !== AUTO_LAYOUT) this.require(layoutId);
  }

  setContextLayout(contextId: string, layoutId: string | null): void {
    this.checkContextRef(layoutId);
    this.db.prepare('UPDATE contexts SET layout_id = ? WHERE id = ?').run(layoutId, contextId);
    this.changed();
  }

  defaultId(): string | null {
    const r = this.db.prepare('SELECT default_layout_id FROM context_settings WHERE id = 1').get() as { default_layout_id: string | null } | undefined;
    return r?.default_layout_id ?? null;
  }

  setDefault(layoutId: string | null): void {
    if (layoutId !== null) this.require(layoutId);
    this.db.prepare(`INSERT INTO context_settings (id, default_layout_id) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET default_layout_id = excluded.default_layout_id`).run(layoutId);
    this.changed();
  }

  /** The preset a context's desktop is tidied with: its own, else the default, else none (auto layout, also for 'auto'). */
  effective(contextId: string): LayoutPreset | null {
    const id = this.contextLayouts().get(contextId) ?? this.defaultId();
    return id === null || id === AUTO_LAYOUT ? null : (this.get(id) ?? null);
  }
}
