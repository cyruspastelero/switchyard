import { describe, it, expect, beforeEach, afterEach, vi } from './support/harness.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnv, resolveDataDir } from '../src/paths.ts';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'switchyard-home-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('env fallback', () => {
  it('prefers_switchyard_variable_over_legacy', () => {
    expect(readEnv('X', { SWITCHYARD_X: 'new', MC_X: 'old' })).toBe('new');
    expect(readEnv('X', { MC_X: 'old' })).toBe('old');
    expect(readEnv('X', {})).toBeUndefined();
  });
});

describe('resolveDataDir', () => {
  it('uses_explicit_env_over_defaults', () => {
    expect(resolveDataDir({ MC_DATA_DIR: '/tmp/a' }, home)).toBe('/tmp/a');
    expect(resolveDataDir({ SWITCHYARD_DATA_DIR: '/tmp/b', MC_DATA_DIR: '/tmp/a' }, home)).toBe('/tmp/b');
  });

  it('moves_old_directory_when_new_one_is_missing', () => {
    const legacy = path.join(home, '.claude-mission-control');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'data.db'), 'x');
    const dir = resolveDataDir({}, home);
    expect(dir).toBe(path.join(home, '.switchyard'));
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'data.db'), 'utf-8')).toBe('x');
  });

  it('keeps_both_directories_when_new_one_exists', () => {
    const legacy = path.join(home, '.claude-mission-control');
    fs.mkdirSync(legacy);
    fs.mkdirSync(path.join(home, '.switchyard'));
    resolveDataDir({}, home);
    expect(fs.existsSync(legacy)).toBe(true);
  });
});
