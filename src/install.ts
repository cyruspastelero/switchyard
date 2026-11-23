import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Hook install / uninstall
// ---------------------------------------------------------------------------

export interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

export interface HookEntry {
  matcher?: string;
  hooks?: { type: string; command: string; async?: boolean; timeout?: number }[];
  type?: string;
  command?: string;
  description?: string;
  [key: string]: unknown;
}

export const DEFAULT_SETTINGS_PATH = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? '~',
  '.claude',
  'settings.json',
);

const HOOK_MARKERS = ['Switchyard', 'Mission Control'];
const HOOK_SCRIPT_NAMES = ['switchyard-hook', 'mission-control-hook'];

/** True for entries written by this tool, including those from before the rename. */
export function isOwnHookEntry(entry: HookEntry): boolean {
  if (entry.description && HOOK_MARKERS.some((m) => entry.description!.includes(m))) {
    return true;
  }
  return (entry.hooks ?? []).some(
    (h) => typeof h.command === 'string' && HOOK_SCRIPT_NAMES.some((n) => h.command.includes(n)),
  );
}

function getHookScriptPath(): string {
  // Resolve the hook script relative to the installed package
  return path.resolve(import.meta.dirname, '..', 'src', 'hook', 'switchyard-hook.js');
}

function readSettings(settingsPath: string): ClaudeSettings {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }
  const raw = fs.readFileSync(settingsPath, 'utf-8');
  if (raw.trim().length === 0) {
    return {};
  }
  // Let JSON.parse throw on corrupt files — caller sees the error
  // rather than silently overwriting the user's settings
  return JSON.parse(raw) as ClaudeSettings;
}

function writeSettings(settingsPath: string, settings: ClaudeSettings): void {
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

function backupSettings(settingsPath: string): void {
  if (!fs.existsSync(settingsPath)) {
    return;
  }
  const backupPath = settingsPath + '.backup';
  fs.copyFileSync(settingsPath, backupPath);
  console.log(`  Backup: ${backupPath}`);
}

function buildHookEntries(): { event: string; entry: HookEntry }[] {
  const hookScript = getHookScriptPath();
  return [
    {
      event: 'PreToolUse',
      entry: {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `node "${hookScript}"`,
            async: true,
            timeout: 5,
          },
        ],
        description: 'Switchyard: report tool use and fetch instructions',
      },
    },
    {
      event: 'PostToolUse',
      entry: {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `node "${hookScript}"`,
            async: true,
            timeout: 5,
          },
        ],
        description: 'Switchyard: report tool completion',
      },
    },
    {
      event: 'SubagentStart',
      entry: {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `node "${hookScript}"`,
            async: true,
            timeout: 5,
          },
        ],
        description: 'Switchyard: report subagent spawn',
      },
    },
    {
      event: 'SubagentStop',
      entry: {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `node "${hookScript}"`,
            async: true,
            timeout: 5,
          },
        ],
        description: 'Switchyard: report subagent end',
      },
    },
    {
      event: 'Stop',
      entry: {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `node "${hookScript}"`,
            async: true,
            timeout: 5,
          },
        ],
        description: 'Switchyard: report session end',
      },
    },
    ...(['Notification', 'UserPromptSubmit'] as const).map((event) => ({
      event,
      entry: {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `node "${hookScript}"`,
            async: true,
            timeout: 5,
          },
        ],
        description: event === 'Notification'
          ? 'Switchyard: report that the agent is waiting on you'
          : 'Switchyard: report that you answered the agent',
      },
    })),
  ];
}

export function installHooks(settingsPath: string = DEFAULT_SETTINGS_PATH): void {
  console.log('\n  Installing Switchyard hooks...\n');
  backupSettings(settingsPath);

  const settings = readSettings(settingsPath);
  const hooks = settings.hooks ?? {};

  for (const { event, entry } of buildHookEntries()) {
    const existing: HookEntry[] = hooks[event] ?? [];

    // Remove any previous entries, including ones from before the rename (idempotent)
    const filtered = existing.filter(
      (h) => !isOwnHookEntry(h),
    );

    // Add the new entry
    filtered.push(entry);
    hooks[event] = filtered;
  }

  settings.hooks = hooks;
  writeSettings(settingsPath, settings);

  console.log('  Hooks installed:');
  console.log('    - PreToolUse     -> report events + fetch instructions');
  console.log('    - PostToolUse    -> report tool completion');
  console.log('    - SubagentStart  -> report subagent spawn');
  console.log('    - SubagentStop   -> report subagent end');
  console.log('    - Stop           -> report session end');
  console.log('    - Notification   -> report waiting on you');
  console.log('    - UserPromptSubmit -> report you answered');
  console.log(`\n  Settings: ${settingsPath}\n`);
}

export function uninstallHooks(settingsPath: string = DEFAULT_SETTINGS_PATH): void {
  console.log('\n  Uninstalling Switchyard hooks...\n');

  const settings = readSettings(settingsPath);
  const hooks = settings.hooks;

  if (!hooks) {
    console.log('  No hooks found in settings.\n');
    return;
  }

  let removed = 0;

  for (const event of Object.keys(hooks)) {
    const entries: HookEntry[] = hooks[event] ?? [];
    const filtered = entries.filter(
      (h) => !isOwnHookEntry(h),
    );
    removed += entries.length - filtered.length;

    if (filtered.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = filtered;
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  } else {
    settings.hooks = hooks;
  }

  writeSettings(settingsPath, settings);
  console.log(`  Removed ${removed} hook(s).\n`);
}

