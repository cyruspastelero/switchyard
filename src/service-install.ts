// Runs the server as a macOS LaunchAgent so it survives the terminal (or agent session) that started it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveDataDir } from './paths.ts';

export const SERVICE_LABEL = 'ph.pastelero.switchyard.server';

export interface ServiceOptions {
  readonly plistPath: string;
  readonly programArguments: readonly string[];
  readonly workingDirectory: string;
  readonly logPath: string;
  readonly pathEnv: string;
  readonly uid: number;
  readonly platform: NodeJS.Platform;
  /** Runs `launchctl <args>`; throws when launchctl fails. */
  readonly launchctl: (args: readonly string[]) => void;
}

/**
 * PATH for the service: node's own directory and the system directories that hold git and lsof. The shell's PATH
 * is not copied, because it can carry project-local or user-writable directories the server would then run tools from.
 */
function servicePath(): string {
  return [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
}

/** Options for this machine: the same node binary, loader flags and entry script that are running now. */
export function defaultServiceOptions(port: number): ServiceOptions {
  const entry = path.resolve(process.argv[1]);
  return {
    plistPath: path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`),
    // Node runs the TypeScript entry directly (type stripping); execArgv carries any flags it was started with.
    programArguments: [process.execPath, ...process.execArgv, entry, 'start', '--local', '--port', String(port)],
    workingDirectory: path.resolve(import.meta.dirname, '..'),
    logPath: path.join(resolveDataDir(), 'server.log'),
    pathEnv: servicePath(),
    uid: os.userInfo().uid,
    platform: process.platform,
    launchctl: (args) => {
      execFileSync('/bin/launchctl', [...args], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf-8' });
    },
  };
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildServicePlist(opts: ServiceOptions): string {
  const args = opts.programArguments.map((a) => `    <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${xml(opts.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(opts.pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(opts.logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(opts.logPath)}</string>
</dict>
</plist>
`;
}

function requireMac(opts: ServiceOptions): void {
  if (opts.platform !== 'darwin') throw new Error('The server LaunchAgent is only available on macOS');
}

/** Unloads the agent. "Not loaded" is the normal case on a first install, so that failure is reported, not fatal. */
function unload(opts: ServiceOptions): void {
  try {
    opts.launchctl(['bootout', `gui/${opts.uid}/${SERVICE_LABEL}`]);
  } catch (err) {
    console.log(`  (was not loaded: ${firstLine(err)})`);
  }
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || String(err)).trim().split('\n')[0];
}

export function installService(opts: ServiceOptions): void {
  requireMac(opts);
  console.log('\n  Installing the Switchyard server LaunchAgent...\n');
  fs.mkdirSync(path.dirname(opts.plistPath), { recursive: true });
  fs.mkdirSync(path.dirname(opts.logPath), { recursive: true });
  // The log holds the dashboard access code: keep it readable by the owner only.
  fs.closeSync(fs.openSync(opts.logPath, 'a', 0o600));
  fs.chmodSync(opts.logPath, 0o600);
  fs.writeFileSync(opts.plistPath, buildServicePlist(opts), { mode: 0o644 });
  unload(opts);
  try {
    opts.launchctl(['bootstrap', `gui/${opts.uid}`, opts.plistPath]);
  } catch (err) {
    throw new Error(`Could not load the Switchyard server LaunchAgent (${opts.plistPath}): ${firstLine(err)}`);
  }
  console.log(`  LaunchAgent: ${opts.plistPath}`);
  console.log(`  Log (shows the access code after each start): ${opts.logPath}`);
  console.log('  The server now starts at login and restarts if it stops.\n');
}

export function uninstallService(opts: ServiceOptions): void {
  requireMac(opts);
  console.log('\n  Removing the Switchyard server LaunchAgent...\n');
  unload(opts);
  fs.rmSync(opts.plistPath, { force: true });
  console.log(`  Removed ${opts.plistPath}. The log and data stay in place.\n`);
}
