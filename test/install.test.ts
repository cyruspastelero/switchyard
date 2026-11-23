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

  it('second_install_keeps_the_pristine_backup', () => {
    const pristine = JSON.stringify({ hooks: { PreToolUse: [userEntry] } });
    fs.writeFileSync(settingsPath, pristine);
    installHooks(settingsPath);
    installHooks(settingsPath);
    expect(fs.readFileSync(settingsPath + '.backup', 'utf-8')).toBe(pristine);
  });

  it('uninstall_backs_up_settings_before_changing_them', () => {
    const before = JSON.stringify({ hooks: { Stop: [oldEntry('Stop')] } });
    fs.writeFileSync(settingsPath, before);
    uninstallHooks(settingsPath);
    expect(fs.readFileSync(settingsPath + '.backup', 'utf-8')).toBe(before);
  });

  it('settings_write_keeps_the_file_mode_and_leaves_no_temp_file', () => {
    fs.writeFileSync(settingsPath, '{}', { mode: 0o600 });
    fs.chmodSync(settingsPath, 0o600);
    installHooks(settingsPath);
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).sort()).toEqual(['settings.json', 'settings.json.backup']);
  });

  it('uninstall_keeps_a_user_hook_whose_description_mentions_switchyard', () => {
    const lookalike = {
      matcher: '*',
      hooks: [{ type: 'command', command: 'node "/me/notify.js"' }],
      description: 'Ping me when Switchyard or Mission Control is slow',
    };
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [lookalike] } }));
    installHooks(settingsPath);
    uninstallHooks(settingsPath);
    expect(read().hooks).toEqual({ Stop: [lookalike] });
  });

  it('uninstall_keeps_a_user_hook_that_only_mentions_the_script_name', () => {
    const wrapper = {
      matcher: '*',
      hooks: [{ type: 'command', command: 'echo "not the switchyard-hook.js script" >> /tmp/x' }],
    };
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [wrapper] } }));
    uninstallHooks(settingsPath);
    expect(read().hooks).toEqual({ Stop: [wrapper] });
  });
});
