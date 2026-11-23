#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createServer } from './server.ts';
import { installHooks, uninstallHooks } from './install.ts';
import { resolveDataDir, writeHookToken } from './paths.ts';
import { defaultServiceOptions, installService, uninstallService } from './service-install.ts';
import { tidyServerLog } from './server-log.ts';

const VERSION = '0.2.0';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

type CliCommand = 'start' | 'install' | 'uninstall' | 'install-service' | 'uninstall-service' | 'access-code';

function parseArgs(argv: readonly string[]): {
  command: CliCommand;
  port: number;
  open: boolean;
} {
  const args = argv.slice(2);
  let command: CliCommand = 'start';
  let port = 4280;
  let open = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === 'install') {
      command = 'install';
    } else if (arg === 'uninstall') {
      command = 'uninstall';
    } else if (arg === 'install-service' || arg === 'uninstall-service' || arg === 'access-code') {
      command = arg;
    } else if (arg === 'start') {
      command = 'start';
    } else if (arg === '--port' && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
        port = parsed;
      }
      i++;
    } else if (arg === '--open') {
      open = true;
    }
  }

  return { command, port, open };
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
  const bin =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';

  const args =
    process.platform === 'win32' ? ['/c', 'start', url] : [url];

  execFile(bin, args, () => {
    // Ignore errors — browser open is best-effort
  });
}

/** First non-internal IPv4 address, for the `--lan` banner. */
function lanAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

function printBanner(port: number, accessCode: string, localOnly: boolean): void {
  console.log('');
  console.log('  \x1b[1mSWITCHYARD\x1b[0m v' + VERSION);
  console.log('  \x1b[2m─────────────────────────────────────────\x1b[0m');
  console.log('');
  console.log('  \x1b[2mLocal:\x1b[0m       ' + `http://localhost:${port}`);
  if (localOnly) {
    console.log('  \x1b[2mNetwork:\x1b[0m     \x1b[2moff (this machine only)\x1b[0m');
  } else {
    console.log('  \x1b[2mNetwork:\x1b[0m     ' + `http://${lanAddress() ?? 'unknown'}:${port}` + '  \x1b[33m(--lan: unencrypted, reachable by anyone on this network)\x1b[0m');
  }
  console.log('');
  if (process.stdout.isTTY) {
    console.log('  \x1b[2mAccess Code:\x1b[0m  \x1b[1m\x1b[33m' + accessCode + '\x1b[0m');
  } else {
    // Not a terminal (the LaunchAgent log): a code written here would stay a working credential (issue #17).
    console.log('  Access code:  not logged. Copy it from the menu bar icon, or run `node src/index.ts access-code`.');
  }
  console.log('');
  printBannerFooter();
}

function printBannerFooter(): void {
  console.log('');
  console.log('  \x1b[2m─────────────────────────────────────────\x1b[0m');
  console.log('  Hooks: Listening for Claude Code events');
  console.log('  Press \x1b[1mCtrl+C\x1b[0m to stop.');
  console.log('');
}

function startServer(port: number, shouldOpen: boolean, localOnly: boolean): void {
  const { start, stop, accessCode, hookToken } = createServer(port, localOnly);

  process.on('SIGINT', () => {
    console.log('\n  Shutting down...');
    stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    stop();
    process.exit(0);
  });

  // Under the LaunchAgent stdout is the log file: drop old access codes and cap its size, now and daily.
  if (!process.stdout.isTTY) {
    const logFile = path.join(resolveDataDir(), 'server.log');
    tidyServerLog(logFile);
    setInterval(() => tidyServerLog(logFile), 24 * 60 * 60 * 1000).unref();
  }
  start();
  printBanner(port, accessCode, localOnly);
  writeHookToken(resolveDataDir(), hookToken);

  if (shouldOpen) {
    openBrowser(`http://localhost:${port}`);
  }
}

/** Asks the running server for its code over loopback with the hook token, the way the menu bar app does. */
async function printAccessCode(port: number): Promise<void> {
  const tokenFile = path.join(resolveDataDir(), 'hook-token');
  let token: string;
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch (err) {
    throw new Error(`no token at ${tokenFile} (is the server running?): ${(err as Error).message}`);
  }
  const res = await fetch(`http://127.0.0.1:${port}/api/contexts/access-code`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch((err: Error) => { throw new Error(`server not reachable on port ${port}: ${err.message}`); });
  if (!res.ok) throw new Error(`server answered ${res.status}`);
  const data = (await res.json()) as { accessCode?: unknown };
  if (typeof data.accessCode !== 'string') throw new Error('server sent no access code');
  console.log(data.accessCode);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { command, port, open } = parseArgs(process.argv);
// Loopback is the default. `--local` is still accepted (older LaunchAgents pass it); `--lan` opens the network.
const localOnly = !process.argv.includes('--lan');

switch (command) {
  case 'install':
    installHooks();
    break;
  case 'uninstall':
    uninstallHooks();
    break;
  case 'install-service':
  case 'uninstall-service':
    try {
      (command === 'install-service' ? installService : uninstallService)(defaultServiceOptions(port));
    } catch (err) {
      console.error(`\n  ${(err as Error).message}\n`);
      process.exit(1);
    }
    break;
  case 'access-code':
    printAccessCode(port).catch((err: Error) => {
      console.error(`\n  Could not get the access code: ${err.message}\n`);
      process.exit(1);
    });
    break;
  case 'start':
    startServer(port, open, localOnly);
    break;
}
