import { describe, it, expect, beforeEach, afterEach, vi } from './support/harness.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServicePlist, installService, uninstallService, SERVICE_LABEL, type ServiceOptions } from '../src/service-install.ts';

let dir: string;
let calls: string[][];
let opts: ServiceOptions;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchyard-service-'));
  calls = [];
  opts = {
    plistPath: path.join(dir, 'LaunchAgents', `${SERVICE_LABEL}.plist`),
    programArguments: ['/opt/node & co/bin/node', '/app/dist/index.js', '--local', '--port', '4280'],
    workingDirectory: '/app',
    logPath: path.join(dir, 'data', 'server.log'),
    pathEnv: '/usr/bin:/bin',
    uid: 501,
    platform: 'darwin',
    launchctl: (args) => { calls.push([...args]); },
    wait: () => {},
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('server LaunchAgent', () => {
  it('plist_keeps_the_server_alive_and_logs_to_the_data_dir', () => {
    const plist = buildServicePlist(opts);
    expect(plist).toContain(`<key>Label</key><string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain(`<key>StandardOutPath</key><string>${opts.logPath}</string>`);
    expect(plist).toContain(`<key>StandardErrorPath</key><string>${opts.logPath}</string>`);
    expect(plist).toContain('<string>--local</string>');
  });

  it('plist_escapes_xml_in_paths', () => {
    expect(buildServicePlist(opts)).toContain('<string>/opt/node &amp; co/bin/node</string>');
  });

  it('install_writes_the_plist_and_reloads_the_agent', () => {
    installService(opts);
    expect(fs.readFileSync(opts.plistPath, 'utf-8')).toBe(buildServicePlist(opts));
    expect(fs.statSync(opts.logPath).mode & 0o777).toBe(0o600); // the log holds the access code
    expect(calls).toEqual([
      ['bootout', `gui/501/${SERVICE_LABEL}`],
      ['bootstrap', 'gui/501', opts.plistPath],
    ]);
  });

  it('install_still_loads_when_the_agent_was_not_loaded_before', () => {
    opts = { ...opts, launchctl: (args) => { calls.push([...args]); if (args[0] === 'bootout') throw new Error('No such process'); } };
    installService(opts);
    expect(calls.at(-1)).toEqual(['bootstrap', 'gui/501', opts.plistPath]);
  });

  it('reinstall_retries_the_load_while_the_old_agent_is_still_shutting_down', () => {
    let bootstraps = 0;
    const waits: number[] = [];
    opts = {
      ...opts,
      wait: (ms) => { waits.push(ms); },
      launchctl: (args) => {
        calls.push([...args]);
        if (args[0] === 'bootstrap' && ++bootstraps < 3) throw new Error('Bootstrap failed: 5: Input/output error');
      },
    };
    installService(opts);
    expect(bootstraps).toBe(3);
    expect(waits.length).toBe(2);
  });

  it('install_reports_a_failed_load', () => {
    opts = { ...opts, launchctl: (args) => { if (args[0] === 'bootstrap') throw new Error('Input/output error'); } };
    expect(() => installService(opts)).toThrow(/load the Switchyard server LaunchAgent.*Input\/output error/);
  });

  it('install_is_refused_off_macos', () => {
    expect(() => installService({ ...opts, platform: 'linux' })).toThrow(/macOS/);
    expect(fs.existsSync(opts.plistPath)).toBe(false);
  });

  it('uninstall_unloads_and_removes_the_plist_but_keeps_the_log', () => {
    installService(opts);
    calls = [];
    uninstallService(opts);
    expect(calls).toEqual([['bootout', `gui/501/${SERVICE_LABEL}`]]);
    expect(fs.existsSync(opts.plistPath)).toBe(false);
    expect(fs.existsSync(opts.logPath)).toBe(true);
  });
});

describe('LaunchAgent defaults', () => {
  it('the_service_path_holds_only_system_directories', async () => {
    const { defaultServiceOptions } = await import('../src/service-install.ts');
    const saved = process.env.PATH;
    process.env.PATH = `/tmp/evil/node_modules/.bin:./relative:${saved}`;
    try {
      const dirs = defaultServiceOptions(4280).pathEnv.split(':');
      expect(dirs.some((d) => d.includes('node_modules') || !d.startsWith('/'))).toBe(false);
      expect(dirs).toContain('/usr/bin');
      expect(dirs).not.toContain('/tmp/evil/node_modules/.bin');
    } finally {
      process.env.PATH = saved;
    }
  });

  it('the_service_runs_node_directly_without_a_loader', async () => {
    const { defaultServiceOptions } = await import('../src/service-install.ts');
    const args = defaultServiceOptions(4280).programArguments;
    expect(args[0]).toBe(process.execPath);
    expect(args.join(' ')).not.toContain('tsx');
    expect(args.slice(-4)).toEqual(['start', '--local', '--port', '4280']);
  });
});
