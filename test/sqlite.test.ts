import { join } from 'node:path';
import { describe, it, expect, afterAll } from './support/harness.ts';
import { setupTestDb, teardownTestDb } from './helpers.ts';
import { openSqlite } from '../src/sqlite.ts';

const tmpDir = setupTestDb();
afterAll(() => teardownTestDb(tmpDir));

describe('sqlite connection', () => {
  it('waits_for_a_busy_database_instead_of_failing_at_once', () => {
    const db = openSqlite(join(tmpDir, 'busy.db'));
    try {
      expect((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(5000);
    } finally {
      db.close();
    }
  });
});
