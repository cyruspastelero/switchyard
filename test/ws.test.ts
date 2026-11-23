// The built-in WebSocket server, driven byte by byte through a raw socket.
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from './support/harness.ts';
import { setupTestDb, teardownTestDb, authenticate } from './helpers.ts';

const tmpDir = setupTestDb();
const { attachWebSocketServer, acceptKey, encodeFrame, CLOSE } = await import('../src/ws.ts');
const { createServer } = await import('../src/server.ts');
type WsClient = import('../src/ws.ts').WsClient;

const PORT = 14311;
const APP_PORT = 14312;
const MAX = 1024;

let bare: http.Server;
let received: string[] = [];
let connected: WsClient[] = [];
let app: ReturnType<typeof createServer>;
let cookie = '';

beforeAll(async () => {
  bare = http.createServer((_req, res) => res.end('plain'));
  attachWebSocketServer(bare, {
    maxClients: 2,
    maxPayloadBytes: MAX,
    verify: (req) => (req.headers['x-refuse'] ? 401 : true),
    onConnection: (client) => {
      connected.push(client);
      client.onMessage((text) => received.push(text));
    },
  });
  await new Promise<void>((resolve) => bare.listen(PORT, '127.0.0.1', resolve));
  app = createServer(APP_PORT, true);
  app.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  cookie = await authenticate(`http://127.0.0.1:${APP_PORT}`, app.accessCode);
});

afterAll(() => {
  bare.closeAllConnections();
  bare.close();
  app.stop();
  teardownTestDb(tmpDir);
});

interface Raw {
  readonly socket: net.Socket;
  readonly head: string;
  /** Bytes received after the handshake response. */
  bytes(): Buffer;
  closed: Promise<void>;
}

const KEY = crypto.randomBytes(16).toString('base64');

function open(port: number, headers: Record<string, string> = {}, overrides: Record<string, string | null> = {}): Promise<Raw> {
  const base: Record<string, string | null> = {
    Host: `127.0.0.1:${port}`, Upgrade: 'websocket', Connection: 'Upgrade',
    'Sec-WebSocket-Key': KEY, 'Sec-WebSocket-Version': '13', ...headers, ...overrides,
  };
  const lines = Object.entries(base).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`);
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = Buffer.alloc(0);
    let done = false;
    const closed = new Promise<void>((r) => socket.on('close', () => r()));
    socket.on('error', reject);
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf('\r\n\r\n');
      if (!done && end !== -1) {
        done = true;
        const head = data.subarray(0, end).toString('latin1');
        const start = end + 4;
        resolve({ socket, head, bytes: () => data.subarray(start), closed });
      }
    });
    socket.write(`GET / HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
  });
}

/** A client frame: masked unless `masked` is false. */
function frame(opcode: number, payload: Buffer | string, opts: { fin?: boolean; masked?: boolean; rsv?: number } = {}): Buffer {
  const body = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  const masked = opts.masked ?? true;
  const first = ((opts.fin ?? true) ? 0x80 : 0) | (opts.rsv ?? 0) | opcode;
  const head = body.length < 126
    ? Buffer.from([first, (masked ? 0x80 : 0) | body.length])
    : Buffer.from([first, (masked ? 0x80 : 0) | 126, body.length >> 8, body.length & 0xff]);
  if (!masked) return Buffer.concat([head, body]);
  const out = Buffer.from(body);
  for (let i = 0; i < out.length; i++) out[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, out]);
}

const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The close code the server sent, read from the first frame in `bytes`. */
function closeCode(bytes: Buffer): number | null {
  return bytes.length >= 4 && bytes[0] === 0x88 ? bytes.readUInt16BE(2) : null;
}

describe('handshake', () => {
  it('answers_with_the_rfc_6455_accept_key', async () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    const c = await open(PORT);
    expect(c.head).toMatch(/^HTTP\/1\.1 101 /);
    expect(c.head).toContain(`Sec-WebSocket-Accept: ${acceptKey(KEY)}`);
    c.socket.destroy();
    await c.closed;
  });

  it('refuses_a_bad_key_a_wrong_version_and_a_failed_verify', async () => {
    expect((await open(PORT, {}, { 'Sec-WebSocket-Key': 'short' })).head).toMatch(/^HTTP\/1\.1 400 /);
    expect((await open(PORT, {}, { 'Sec-WebSocket-Key': null })).head).toMatch(/^HTTP\/1\.1 400 /);
    const old = await open(PORT, {}, { 'Sec-WebSocket-Version': '8' });
    expect(old.head).toMatch(/^HTTP\/1\.1 426 /);
    expect(old.head).toContain('Sec-WebSocket-Version: 13');
    expect((await open(PORT, { 'X-Refuse': '1' })).head).toMatch(/^HTTP\/1\.1 401 /);
    expect((await open(PORT, {}, { Upgrade: 'h2c' })).head).toMatch(/^HTTP\/1\.1 400 /);
  });

  it('refuses_clients_over_the_limit', async () => {
    await settle();
    const a = await open(PORT);
    const b = await open(PORT);
    const c = await open(PORT);
    expect(a.head).toMatch(/ 101 /);
    expect(b.head).toMatch(/ 101 /);
    expect(c.head).toMatch(/^HTTP\/1\.1 503 /);
    a.socket.destroy();
    b.socket.destroy();
    await Promise.all([a.closed, b.closed]);
    await settle();
  });
});

describe('frames', () => {
  it('delivers_text_whole_fragmented_and_split_across_packets', async () => {
    received = [];
    const c = await open(PORT);
    c.socket.write(frame(0x1, 'héllo'));
    c.socket.write(Buffer.concat([frame(0x1, 'par', { fin: false }), frame(0x9, 'p'), frame(0x0, 'ts')]));
    const slow = frame(0x1, 'slow');
    for (const byte of slow) { c.socket.write(Buffer.from([byte])); await settle(1); }
    await settle();
    expect(received).toEqual(['héllo', 'parts', 'slow']);
    // The ping in the middle of the fragments was answered with a pong carrying the same payload.
    expect(c.bytes().equals(encodeFrame(0xa, Buffer.from('p')))).toBe(true);
    c.socket.destroy();
    await c.closed;
  });

  it('sends_text_frames_of_every_length_class_unmasked', async () => {
    connected = [];
    const c = await open(PORT);
    await settle();
    const big = 'x'.repeat(70_000);
    connected[0].send('hi');
    connected[0].send('y'.repeat(300));
    connected[0].send(big);
    await settle(150);
    const bytes = c.bytes();
    expect(bytes[0]).toBe(0x81);
    expect(bytes[1]).toBe(2);
    expect(bytes.subarray(2, 4).toString()).toBe('hi');
    expect(bytes[4]).toBe(0x81);
    expect(bytes[5]).toBe(126);
    expect(bytes.readUInt16BE(6)).toBe(300);
    const third = 8 + 300;
    expect(bytes[third + 1]).toBe(127);
    expect(Number(bytes.readBigUInt64BE(third + 2))).toBe(70_000);
    expect(bytes.length).toBe(third + 10 + 70_000);
    c.socket.destroy();
    await c.closed;
  });

  it('echoes_a_close_and_ends_the_connection', async () => {
    const c = await open(PORT);
    const body = Buffer.alloc(2);
    body.writeUInt16BE(1000);
    c.socket.write(frame(0x8, body));
    await c.closed;
    expect(closeCode(c.bytes())).toBe(1000);
  });

  const violations: readonly [string, () => Buffer, number][] = [
    ['an unmasked frame', () => frame(0x1, 'hi', { masked: false }), CLOSE.protocolError],
    ['a reserved bit', () => frame(0x1, 'hi', { rsv: 0x40 }), CLOSE.protocolError],
    ['a binary frame', () => frame(0x2, 'hi'), CLOSE.unsupportedData],
    ['an unknown opcode', () => frame(0x3, 'hi'), CLOSE.protocolError],
    ['a continuation with nothing to continue', () => frame(0x0, 'hi'), CLOSE.protocolError],
    ['a new text frame inside a fragmented message', () => Buffer.concat([frame(0x1, 'a', { fin: false }), frame(0x1, 'b')]), CLOSE.protocolError],
    ['a fragmented ping', () => frame(0x9, 'p', { fin: false }), CLOSE.protocolError],
    ['a ping longer than 125 bytes', () => frame(0x9, 'p'.repeat(126)), CLOSE.protocolError],
    ['invalid utf-8', () => frame(0x1, Buffer.from([0xc3, 0x28])), CLOSE.invalidPayload],
    ['a frame over the size limit', () => frame(0x1, 'z'.repeat(MAX + 1)), CLOSE.tooBig],
    ['fragments that add up past the limit', () => Buffer.concat([frame(0x1, 'z'.repeat(MAX - 10), { fin: false }), frame(0x0, 'z'.repeat(20))]), CLOSE.tooBig],
  ];

  it.each(violations)('closes_on_%s', async (_name, bytes, code) => {
    received = [];
    const c = await open(PORT);
    c.socket.write(bytes());
    await c.closed;
    expect(closeCode(c.bytes())).toBe(code);
    expect(received).toEqual([]);
  });

  it('refuses_a_huge_declared_length_before_any_payload_arrives', async () => {
    const c = await open(PORT);
    const head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(2 ** 40), 2);
    c.socket.write(head);
    await c.closed;
    expect(closeCode(c.bytes())).toBe(CLOSE.tooBig);
  });
});

describe('dashboard socket', () => {
  const origin = `http://127.0.0.1:${APP_PORT}`;

  it('needs_a_session_cookie', async () => {
    expect((await open(APP_PORT)).head).toMatch(/^HTTP\/1\.1 401 /);
    expect((await open(APP_PORT, { Cookie: 'switchyard_session=nope' })).head).toMatch(/^HTTP\/1\.1 401 /);
  });

  it('refuses_another_origin_even_with_the_cookie', async () => {
    for (const bad of ['http://evil.example', 'http://localhost:3000', 'http://192.168.1.50:8080', 'null']) {
      expect((await open(APP_PORT, { Cookie: cookie, Origin: bad })).head).toMatch(/^HTTP\/1\.1 403 /);
    }
  });

  it('refuses_a_rebound_host_name', async () => {
    expect((await open(APP_PORT, { Cookie: cookie }, { Host: `evil.example:${APP_PORT}` })).head).toMatch(/^HTTP\/1\.1 403 /);
  });

  it('sends_the_current_state_to_the_signed_in_dashboard', async () => {
    const c = await open(APP_PORT, { Cookie: cookie, Origin: origin });
    expect(c.head).toMatch(/^HTTP\/1\.1 101 /);
    await settle(200);
    const bytes = c.bytes();
    expect(bytes[0]).toBe(0x81);
    const length = bytes[1];
    expect(JSON.parse(bytes.subarray(2, 2 + length).toString())).toEqual({ type: 'agents', data: [] });
    c.socket.destroy();
    await c.closed;
  });
});

describe('heartbeat and session checks', () => {
  const HB_PORT = 14470;
  let hb: http.Server;
  let allowed = true;

  beforeAll(async () => {
    hb = http.createServer((_req, res) => res.end('plain'));
    attachWebSocketServer(hb, {
      maxClients: 5,
      heartbeatMs: 100,
      verify: () => true,
      stillAllowed: () => allowed,
      onConnection: () => undefined,
    });
    await new Promise<void>((resolve) => hb.listen(HB_PORT, '127.0.0.1', resolve));
  });
  afterAll(() => {
    hb.closeAllConnections();
    hb.close();
  });

  it('drops_a_client_that_never_answers_a_ping', async () => {
    allowed = true;
    const c = await open(HB_PORT);
    const gone = await Promise.race([c.closed.then(() => true), settle(800).then(() => false)]);
    expect(gone).toBe(true);
  });

  it('keeps_a_client_that_answers_its_pings', async () => {
    allowed = true;
    const c = await open(HB_PORT);
    const timer = setInterval(() => { if (!c.socket.destroyed) c.socket.write(frame(0xa, '')); }, 50);
    const gone = await Promise.race([c.closed.then(() => true), settle(600).then(() => false)]);
    clearInterval(timer);
    expect(gone).toBe(false);
    c.socket.destroy();
  });

  it('closes_a_client_whose_session_has_ended', async () => {
    allowed = true;
    const c = await open(HB_PORT);
    allowed = false;
    await c.closed;
    expect(closeCode(c.bytes().subarray(c.bytes().indexOf(0x88)))).toBe(CLOSE.policyViolation);
  });
});
