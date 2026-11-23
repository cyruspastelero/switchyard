import { describe, it, expect, beforeEach, afterEach, vi } from './support/harness.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installHooks, uninstallHooks, type ClaudeSettings } from '../src/install.ts';

let dir: string;
let settingsPath: string;

function read(): ClaudeSettings {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as ClaudeSettings;
}

function oldEntry(event: string) {
  return {
    matcher: '*',
    hooks: [{ type: 'command', command: 'node "/old/src/hook/mission-control-hook.js"', async: true, timeout: 5 }],
    description: `Mission Control: old ${event} hook`,
  };
}

const userEntry = {
  matcher: '*',
  hooks: [{ type: 'command', command: 'node "/me/my-own-hook.js"' }],
  description: 'my own hook',
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchyard-install-'));
  settingsPath = path.join(dir, 'settings.json');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('install', () => {
  it('install_replaces_old_mission_control_hooks', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [oldEntry('PreToolUse'), userEntry],
          Stop: [oldEntry('Stop')],
          // Old entry recognised by script path even when the description was edited
          Notification: [{ ...oldEntry('Notification'), description: 'renamed by hand' }],
        },
      }),
    );

    installHooks(settingsPath);
    const hooks = read().hooks!;

    for (const event of ['PreToolUse', 'Stop', 'Notification']) {
      const commands = hooks[event].flatMap((e) => (e.hooks ?? []).map((h) => h.command));
      expect(commands.filter((c) => c.includes('mission-control-hook'))).toEqual([]);
      expect(commands.filter((c) => c.includes('switchyard-hook'))).toHaveLength(1);
    }
    expect(hooks.PreToolUse).toContainEqual(userEntry);
  });

  it('install_twice_leaves_one_hook_per_event', () => {
    installHooks(settingsPath);
    installHooks(settingsPath);
    for (const entries of Object.values(read().hooks!)) {
      expect(entries).toHaveLength(1);
    }
  });

  it('uninstall_removes_old_and_new_hooks_but_keeps_others', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { PreToolUse: [oldEntry('PreToolUse'), userEntry], Stop: [oldEntry('Stop')] } }),
    );
    installHooks(settingsPath);
    uninstallHooks(settingsPath);
    expect(read().hooks).toEqual({ PreToolUse: [userEntry] });
  });
});
