// Minimal RFC 6455 WebSocket server on top of node:http's `upgrade` event. No dependencies.
//
// Scope: the dashboard only listens, so this supports text frames out, and text, ping, pong and close in.
// No extensions, no subprotocols, no binary. Every limit is enforced before the bytes are buffered.

import crypto from 'node:crypto';
import http from 'node:http';
import type { Duplex } from 'node:stream';

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const KEY_PATTERN = /^[A-Za-z0-9+/]{22}==$/; // base64 of exactly 16 bytes
const CLOSE_GRACE_MS = 2_000;

/** Largest message a client may send. The dashboard sends nothing, so this is generous. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
/** A client that stops reading is dropped once this much output is queued for it. */
export const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 30_000;

const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

export const CLOSE = {
  normal: 1000,
  protocolError: 1002,
  unsupportedData: 1003,
  invalidPayload: 1007,
  policyViolation: 1008,
  tooBig: 1009,
  tryAgainLater: 1013,
} as const;

export interface WsClient {
  readonly isOpen: boolean;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
}

export interface WsServerOptions {
  /** Decides the handshake. Return true to accept, or the HTTP status to refuse with. Runs before any upgrade. */
  readonly verify: (req: http.IncomingMessage) => true | number;
  readonly onConnection: (client: WsClient, req: http.IncomingMessage) => void;
  readonly maxClients: number;
  readonly maxPayloadBytes?: number;
  /** Every tick: a client that sent nothing since the last ping is dropped, the rest get a ping. Default 30 s. */
  readonly heartbeatMs?: number;
  /** Checked every tick with the handshake request: false closes the client (its session ended). */
  readonly stillAllowed?: (req: http.IncomingMessage) => boolean;
}

export interface WsServer {
  readonly clients: ReadonlySet<WsClient>;
  close(): void;
}

export function acceptKey(key: string): string {
  return crypto.createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64');
}

/** One unmasked server-to-client frame. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function refuse(socket: Duplex, status: number, extraHeaders = ''): void {
  const reason = http.STATUS_CODES[status] ?? 'Error';
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n${extraHeaders}\r\n`);
}

/** Checks the upgrade request itself. Returns the client's key, or the status to refuse with. */
function readHandshake(req: http.IncomingMessage): { key: string } | { status: number; headers?: string } {
  if (req.method !== 'GET') return { status: 405 };
  if ((req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return { status: 400 };
  if (req.headers['sec-websocket-version'] !== '13') return { status: 426, headers: 'Sec-WebSocket-Version: 13\r\n' };
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) return { status: 400 };
  return { key };
}

class Connection implements WsClient {
  private readonly socket: Duplex;
  private readonly maxPayload: number;
  private buffered: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private inFragmentedMessage = false;
  private open = true;
  private closeSent = false;
  /** Bytes arrived since the last heartbeat tick. */
  private heard = true;
  private messageListeners: readonly ((text: string) => void)[] = [];
  private closeListeners: readonly (() => void)[] = [];

  constructor(socket: Duplex, maxPayload: number) {
    this.socket = socket;
    this.maxPayload = maxPayload;
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('close', () => this.finish());
    socket.on('end', () => socket.destroy()); // the peer hung up without a close frame
    socket.on('error', () => this.finish()); // a reset peer is a closed connection, nothing more
  }

  get isOpen(): boolean {
    return this.open;
  }

  onMessage(listener: (text: string) => void): void {
    this.messageListeners = [...this.messageListeners, listener];
  }

  onClose(listener: () => void): void {
    this.closeListeners = [...this.closeListeners, listener];
  }

  send(text: string): void {
    if (!this.open) return;
    this.write(encodeFrame(OP.text, Buffer.from(text, 'utf-8')));
  }

  close(code: number = CLOSE.normal, reason = ''): void {
    if (this.closeSent) return;
    this.closeSent = true;
    const reasonBytes = Buffer.from(reason, 'utf-8').subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.write(encodeFrame(OP.close, payload));
    this.open = false;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), CLOSE_GRACE_MS).unref();
  }

  /** One heartbeat: false when the client sent nothing since the last one (a half-open peer). */
  tick(): boolean {
    if (!this.heard) return false;
    this.heard = false;
    this.write(encodeFrame(OP.ping, Buffer.alloc(0)));
    return true;
  }

  destroy(): void {
    this.socket.destroy();
  }

  /** Every frame out, pongs included: a client that stops reading is dropped once its queue passes the cap. */
  private write(frame: Buffer): void {
    if (this.socket.destroyed || !this.socket.writable) return;
    this.socket.write(frame);
    if (this.socket.writableLength > MAX_QUEUED_BYTES) this.socket.destroy();
  }

  private finish(): void {
    const wasListening = this.closeListeners;
    this.open = false;
    this.closeListeners = [];
    this.messageListeners = [];
    wasListening.forEach((listener) => listener());
  }

  private receive(chunk: Buffer): void {
    this.heard = true;
    if (this.closeSent) return;
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    while (!this.closeSent && this.readFrame()) {
      // keep reading whole frames
    }
  }

  /** Reads one frame from the buffer. Returns false when more bytes are needed. */
  private readFrame(): boolean {
    const data = this.buffered;
    if (data.length < 2) return false;
    const fin = (data[0] & 0x80) !== 0;
    const reserved = data[0] & 0x70;
    const opcode = data[0] & 0x0f;
    const masked = (data[1] & 0x80) !== 0;
    let length = data[1] & 0x7f;
    let offset = 2;

    // Reserved bits belong to extensions we never negotiate; clients must mask every frame.
    if (reserved !== 0 || !masked) return this.fail(CLOSE.protocolError, 'Protocol error');
    const isControl = opcode >= 0x8;
    if (isControl && (!fin || length > 125)) return this.fail(CLOSE.protocolError, 'Bad control frame');

    if (length === 126) {
      if (data.length < 4) return false;
      length = data.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (data.length < 10) return false;
      const big = data.readBigUInt64BE(2);
      if (big > BigInt(this.maxPayload)) return this.fail(CLOSE.tooBig, 'Message too big');
      length = Number(big);
      offset = 10;
    }
    // Refuse on the declared size, before buffering the payload.
    if (length + this.fragmentBytes > this.maxPayload) return this.fail(CLOSE.tooBig, 'Message too big');

    const end = offset + 4 + length;
    if (data.length < end) return false;
    const mask = data.subarray(offset, offset + 4);
    const payload = Buffer.from(data.subarray(offset + 4, end));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buffered = data.subarray(end);
    return this.handleFrame(opcode, fin, payload);
  }

  private handleFrame(opcode: number, fin: boolean, payload: Buffer): boolean {
    switch (opcode) {
      case OP.ping:
        this.write(encodeFrame(OP.pong, payload));
        return true;
      case OP.pong:
        return true;
      case OP.close:
        this.close(payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE.normal);
        return false;
      case OP.binary:
        return this.fail(CLOSE.unsupportedData, 'Text frames only');
      case OP.text:
        if (this.inFragmentedMessage) return this.fail(CLOSE.protocolError, 'Expected continuation');
        return this.collect(fin, payload);
      case OP.continuation:
        if (!this.inFragmentedMessage) return this.fail(CLOSE.protocolError, 'Unexpected continuation');
        return this.collect(fin, payload);
      default:
        return this.fail(CLOSE.protocolError, 'Unknown opcode');
    }
  }

  private collect(fin: boolean, payload: Buffer): boolean {
    this.fragments.push(payload);
    this.fragmentBytes += payload.length;
    this.inFragmentedMessage = !fin;
    if (!fin) return true;
    const whole = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentBytes = 0;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(whole);
    } catch {
      return this.fail(CLOSE.invalidPayload, 'Invalid UTF-8');
    }
    this.messageListeners.forEach((listener) => listener(text));
    return true;
  }

  private fail(code: number, reason: string): false {
    this.buffered = Buffer.alloc(0);
    this.fragments = [];
    this.close(code, reason);
    return false;
  }
}

/** Takes over the server's `upgrade` event. Every upgrade request is either verified and accepted, or refused. */
export function attachWebSocketServer(server: http.Server, options: WsServerOptions): WsServer {
  const clients = new Set<WsClient>();
  const requests = new Map<Connection, http.IncomingMessage>();
  const maxPayload = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const heartbeat = setInterval(() => {
    for (const [connection, req] of requests) {
      if (options.stillAllowed && !options.stillAllowed(req)) connection.close(CLOSE.policyViolation, 'Session ended');
      else if (!connection.tick()) connection.destroy();
    }
  }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const handshake = readHandshake(req);
    if ('status' in handshake) return refuse(socket, handshake.status, handshake.headers);
    const verdict = options.verify(req);
    if (verdict !== true) return refuse(socket, verdict);
    if (clients.size >= options.maxClients) return refuse(socket, 503);

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(handshake.key)}\r\n\r\n`,
    );
    const connection = new Connection(socket, maxPayload);
    clients.add(connection);
    requests.set(connection, req);
    connection.onClose(() => { clients.delete(connection); requests.delete(connection); });
    options.onConnection(connection, req);
    if (head.length > 0) socket.emit('data', head);
    socket.resume(); // node:http hands the socket over paused
  });

  return {
    clients,
    close(): void {
      clearInterval(heartbeat);
      for (const client of [...clients]) client.close(1001, 'Server shutting down');
    },
  };
}
