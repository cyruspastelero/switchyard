import { describe, it, expect, beforeAll, afterAll } from '../support/harness.ts';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setupTestDb, teardownTestDb, hookFetch } from '../helpers.ts';

const tmpDir = setupTestDb();
const { createServer } = await import('../../src/server.ts');
const { getAgents } = await import('../../src/db.ts');

const activity = readFileSync(new URL('../../src/dashboard/activity.js', import.meta.url), 'utf8');

/** A top-level function declaration from a dashboard script, as source text. */
function fn(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found`);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

type Tree = { sessions: Record<string, { main: { id: string } | null; subs: { id: string }[] }> };
function agentTree(agents: readonly unknown[]): Tree {
  return runInNewContext(`${fn(activity, 'isMainAgentId')}\n${fn(activity, 'buildAgentTree')}\nbuildAgentTree()`, { state: { agents } }) as Tree;
}

const PORT = 14298;
let server: ReturnType<typeof createServer>;
beforeAll(async () => {
  server = createServer(PORT, true);
  server.start();
  await new Promise((r) => setTimeout(r, 300));
  const hf = hookFetch(server.hookToken);
  for (const agent_id of ['main', 'helper-1']) {
    await hf(`http://localhost:${PORT}/api/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'tree-sess', agent_id, event_type: 'pre_tool_use', tool_name: 'Read', tool_input: { file_path: '/tmp/a.ts' } }),
    });
  }
});
afterAll(() => {
  server.stop();
  teardownTestDb(tmpDir);
});

describe('agents tree', () => {
  it('an_ingested_main_session_is_the_main_row_not_a_subagent', () => {
    const agents = getAgents().filter((a) => a.session_id === 'tree-sess');
    expect(agents.map((a) => a.agent_id).sort()).toEqual(['tree-sess:helper-1', 'tree-sess:main']);
    const group = agentTree(agents).sessions['tree-sess'];
    expect(group.main?.id).toBe('tree-sess:main');
    expect(group.subs.map((s) => s.id)).toEqual(['tree-sess:helper-1']);
  });

  it('a_bare_main_agent_id_is_still_the_main_row', () => {
    const group = agentTree([{ id: 's:main', session_id: 's', agent_id: 'main' }]).sessions.s;
    expect(group.main?.id).toBe('s:main');
  });
});
