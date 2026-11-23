import { describe, it, expect, afterAll } from './support/harness.ts';
import { setupTestDb, teardownTestDb } from './helpers.ts';
import { connect } from 'node:net';

const tmpDir = setupTestDb();
const { createServer } = await import('../src/server.ts');

const PORT = 14303;
const server = createServer(PORT, true);
afterAll(() => {
  server.stop();
  teardownTestDb(tmpDir);
});

const portAnswers = () => new Promise<boolean>((resolve) => {
  const socket = connect(PORT, '127.0.0.1', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
});

describe('server start', () => {
  // The CLI writes the hook token in this callback. A start that loses the port must not replace the live server's token.
  it('runs_the_on_listening_callback_only_once_the_port_is_open', async () => {
    const answered = await new Promise<boolean>((resolve) => server.start(() => { portAnswers().then(resolve); }));
    expect(answered).toBe(true);
  });
});
