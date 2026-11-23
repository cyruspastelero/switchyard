import path from 'node:path';
import { getAgents, getDb } from '../db.ts';
import { resolveDataDir } from '../paths.ts';
import { ContextsService } from './service.ts';

export { handleContexts, isContextsUrl } from './api.ts';
export { ContextsService } from './service.ts';

/** Production wiring: the shared DB handle and the live agent table. */
export function createContextsService(): ContextsService {
  return new ContextsService({ db: getDb(), listAgents: getAgents, iconDir: path.join(resolveDataDir(), 'icons') });
}
