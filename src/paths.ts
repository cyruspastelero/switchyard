import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Read SWITCHYARD_<name> first, then the legacy MC_<name>. */
export function readEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`SWITCHYARD_${name}`] || env[`MC_${name}`] || undefined;
}

export const LEGACY_DIR_NAME = '.claude-mission-control';
export const DIR_NAME = '.switchyard';

/**
 * Resolve the data directory. SWITCHYARD_DATA_DIR, then MC_DATA_DIR, then ~/.switchyard.
 * When the default is used and only the old directory exists, move it (one log line).
 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const explicit = readEnv('DATA_DIR', env);
  if (explicit) return explicit;

  const next = path.join(home, DIR_NAME);
  const legacy = path.join(home, LEGACY_DIR_NAME);
  if (!fs.existsSync(next) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, next);
      console.log(`Switchyard: moved ${legacy} to ${next}`);
    } catch (err) {
      console.warn(`Switchyard: could not move ${legacy} to ${next}: ${(err as Error).message}`);
      return legacy;
    }
  }
  return next;
}

/** Creates the data directory if needed and keeps it closed to other users of this machine (mode 0700). */
export function ensurePrivateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** The token file is the credential of the hook and the Mac app: owner-only, also when the file already existed. */
export function writeHookToken(dataDir: string, hookToken: string): void {
  const tokenPath = path.join(ensurePrivateDir(dataDir), 'hook-token');
  fs.writeFileSync(tokenPath, hookToken, { mode: 0o600 });
  fs.chmodSync(tokenPath, 0o600);
}
