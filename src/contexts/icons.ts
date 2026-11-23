// App icons uploaded by the Mac app, one PNG per bundle id. Kept in memory and, when a folder is given,
// in owner-only files there so they survive a server restart.

import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir } from '../paths.ts';

export const ICON_MAX_BYTES = 16_384;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Reverse-DNS only, so the id is also a safe file name. */
export function isBundleId(id: string): boolean {
  return id.length <= 255 && BUNDLE_ID.test(id);
}

export function isPng(data: Buffer): boolean {
  return data.length > PNG_SIGNATURE.length && data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

export class IconStore {
  private readonly icons = new Map<string, Buffer>();
  private readonly dir: string | null;

  constructor(dir: string | null = null) {
    this.dir = dir;
  }

  put(bundleId: string, png: Buffer): void {
    this.icons.set(bundleId, png);
    if (!this.dir) return;
    const file = path.join(ensurePrivateDir(this.dir), `${bundleId}.png`);
    fs.writeFileSync(file, png, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }

  get(bundleId: string): Buffer | null {
    const cached = this.icons.get(bundleId);
    if (cached || !this.dir) return cached ?? null;
    try {
      const png = fs.readFileSync(path.join(this.dir, `${bundleId}.png`));
      this.icons.set(bundleId, png);
      return png;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`reading the icon of ${bundleId} failed: ${(err as Error).message}`);
    }
  }
}
