// SQLite through Node's built-in `node:sqlite`. Every statement is prepared; values are always bound, never
// concatenated into SQL text.

import fs from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number;
}

/** A prepared statement. Parameters are bound by SQLite: positional values, or one object of named values. */
export interface Statement {
  run(...params: readonly unknown[]): RunResult;
  get(...params: readonly unknown[]): unknown;
  all(...params: readonly unknown[]): unknown[];
}

type Bindings = Parameters<StatementSync['run']>;

function wrap(statement: StatementSync): Statement {
  // Statements accept objects that carry more fields than the SQL names (a full row for a partial INSERT).
  statement.setAllowUnknownNamedParameters(true);
  return {
    run(...params) {
      const result = statement.run(...(params as Bindings));
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    get: (...params) => statement.get(...(params as Bindings)),
    all: (...params) => statement.all(...(params as Bindings)),
  };
}

export class Db {
  private readonly handle: DatabaseSync;

  constructor(dbPath: string) {
    this.handle = new DatabaseSync(dbPath);
  }

  exec(sql: string): void {
    this.handle.exec(sql);
  }

  prepare(sql: string): Statement {
    return wrap(this.handle.prepare(sql));
  }

  close(): void {
    this.handle.close();
  }

  /** Runs `work` in one transaction: committed when it returns, rolled back when it throws. */
  transaction<T>(work: () => T): T {
    this.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.exec('COMMIT');
      return result;
    } catch (err) {
      this.exec('ROLLBACK');
      throw err;
    }
  }
}

const OWNER_ONLY = 0o600;

/** The database holds agent activity: the file and its WAL/SHM side files are readable by the owner only. */
function restrictToOwner(dbPath: string): void {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (fs.existsSync(file)) fs.chmodSync(file, OWNER_ONLY);
  }
}

export function openSqlite(dbPath: string): Db {
  // Create the file ourselves so it never exists with the default (world-readable) mode.
  fs.closeSync(fs.openSync(dbPath, 'a', OWNER_ONLY));
  restrictToOwner(dbPath);
  const db = new Db(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Deleted rows are overwritten, so purged events do not linger in free pages.
  db.exec('PRAGMA secure_delete = ON');
  restrictToOwner(dbPath);
  return db;
}
