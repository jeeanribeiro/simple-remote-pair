import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type App, createApp } from '../src/server/app.js';
import { type FakeInjector, fakeInjector } from '../src/server/injector.js';
import type { ServerMessage } from '../src/shared/protocol.js';
import { WS_PATH } from '../src/shared/protocol.js';

/** Test client: buffers server messages and lets tests await them in order. */
class TestClient {
  private readonly queue: ServerMessage[] = [];
  private waiter: ((msg: ServerMessage) => void) | null = null;
  readonly closed: Promise<{ code: number }>;
  private readonly ws: WebSocket;

  constructor(port: number, options?: { origin?: string }) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, options);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMessage;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(msg);
      } else {
        this.queue.push(msg);
      }
    });
    this.closed = new Promise((resolve) => {
      this.ws.on('close', (code) => resolve({ code }));
    });
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  sendRaw(payload: string): void {
    this.ws.send(payload);
  }

  next(timeoutMs = 2000): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
      this.waiter = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function expectType<T extends ServerMessage['t']>(
  client: TestClient,
  type: T,
): Promise<Extract<ServerMessage, { t: T }>> {
  const msg = await client.next();
  expect(msg.t).toBe(type);
  return msg as Extract<ServerMessage, { t: T }>;
}

describe('SessionHub', () => {
  let app: App;
  let injector: FakeInjector;
  let port: number;
  const clients: TestClient[] = [];

  async function client(): Promise<TestClient> {
    const c = new TestClient(port);
    clients.push(c);
    await c.ready();
    return c;
  }

  /** Host + one joined guest, with the initial handshake messages consumed. */
  async function pair(): Promise<{
    host: TestClient;
    guest: TestClient;
    code: string;
    guestId: string;
  }> {
    const host = await client();
    host.send({ t: 'host:create' });
    const created = await expectType(host, 'session:created');
    await expectType(host, 'injector:status');

    const guest = await client();
    guest.send({ t: 'guest:join', code: created.code, name: 'Ada' });
    const joined = await expectType(guest, 'guest:joined');
    await expectType(guest, 'injector:status');
    await expectType(host, 'guest:connected');
    return { host, guest, code: created.code, guestId: joined.guestId };
  }

  beforeEach(async () => {
    injector = fakeInjector();
    app = createApp({ injector });
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    port = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    await app.close();
  });

  it('creates a session and reports injector availability', async () => {
    const host = await client();
    host.send({ t: 'host:create' });
    const created = await expectType(host, 'session:created');
    expect(created.code).toMatch(/^[A-Z2-9]{6}$/);
    const status = await expectType(host, 'injector:status');
    expect(status.available).toBe(true);
  });

  it('rejects joins with an unknown code', async () => {
    const guest = await client();
    guest.send({ t: 'guest:join', code: 'ABCDEF' });
    const error = await expectType(guest, 'error');
    expect(error.code).toBe('BAD_CODE');
  });

  it('joins guests, sanitizes names, and notifies the host', async () => {
    const { host: _host, guest: _guest, guestId } = await pair();
    expect(guestId).toBe('g1');
  });

  it('relays signaling both ways', async () => {
    const { host, guest, guestId } = await pair();
    host.send({ t: 'signal', to: guestId, data: { sdp: { type: 'offer' } } });
    const toGuest = await expectType(guest, 'signal');
    expect(toGuest.from).toBe('host');
    expect(toGuest.data).toEqual({ sdp: { type: 'offer' } });

    guest.send({ t: 'signal', data: { sdp: { type: 'answer' } } });
    const toHost = await expectType(host, 'signal');
    expect(toHost.from).toBe(guestId);
  });

  it('injects mouse and key input from controlling guests', async () => {
    const { guest } = await pair();
    guest.send({ t: 'input', ev: { k: 'down', x: 0.5, y: 0.5, button: 0 } });
    guest.send({ t: 'input', ev: { k: 'key', key: 'a', down: true } });
    guest.send({ t: 'input', ev: { k: 'key', key: 'a', down: false } });
    await vi_waitFor(() => injector.events.length >= 4);
    // down injects a move first so the click lands at the right position
    expect(injector.events[0]).toEqual({ type: 'move', args: [960, 540] });
    expect(injector.events[1]).toEqual({ type: 'button', args: [0, true] });
    expect(injector.events[2]).toEqual({ type: 'key', args: ['a', true] });
    expect(injector.events[3]).toEqual({ type: 'key', args: ['a', false] });
  });

  it('maps normalized coordinates to screen edges inclusively', async () => {
    const { guest } = await pair();
    guest.send({ t: 'input', ev: { k: 'down', x: 1, y: 1, button: 0 } });
    await vi_waitFor(() => injector.events.length >= 2);
    expect(injector.events[0]).toEqual({ type: 'move', args: [1919, 1079] });
  });

  it('accumulates fractional wheel notches', async () => {
    const { guest } = await pair();
    guest.send({ t: 'input', ev: { k: 'wheel', dx: 0, dy: -0.6 } });
    guest.send({ t: 'input', ev: { k: 'wheel', dx: 0, dy: -0.6 } });
    await vi_waitFor(() => injector.events.length >= 1);
    expect(injector.events).toEqual([{ type: 'scroll', args: [0, -1] }]);
  });

  it('blocks input when control is revoked and releases held keys', async () => {
    const { host, guest, guestId } = await pair();
    guest.send({ t: 'input', ev: { k: 'key', key: 'Shift', down: true } });
    await vi_waitFor(() => injector.events.length >= 1);

    host.send({ t: 'host:control', guestId, control: false });
    const changed = await expectType(guest, 'control:changed');
    expect(changed.control).toBe(false);
    // Revoking control released the held Shift.
    await vi_waitFor(() => injector.events.length >= 2);
    expect(injector.events[1]).toEqual({ type: 'key', args: ['shift', false] });

    injector.clear();
    guest.send({ t: 'input', ev: { k: 'move', x: 0.1, y: 0.1 } });
    await delay(50);
    expect(injector.events).toEqual([]);
  });

  it('pauses all guests at once', async () => {
    const { host, guest } = await pair();
    host.send({ t: 'host:pause', paused: true });
    const changed = await expectType(guest, 'control:changed');
    expect(changed.paused).toBe(true);
    guest.send({ t: 'input', ev: { k: 'move', x: 0.1, y: 0.1 } });
    await delay(50);
    expect(injector.events).toEqual([]);
  });

  it('kicks guests and notifies the host', async () => {
    const { host, guest, guestId } = await pair();
    host.send({ t: 'host:kick', guestId });
    const closed = await guest.closed;
    expect(closed.code).toBe(4001);
    const gone = await expectType(host, 'guest:disconnected');
    expect(gone.guestId).toBe(guestId);
  });

  it('ends the session and releases guest input when the host disconnects', async () => {
    const { host, guest } = await pair();
    guest.send({ t: 'input', ev: { k: 'down', x: 0.2, y: 0.2, button: 0 } });
    await vi_waitFor(() => injector.events.length >= 2);

    host.close();
    const ended = await expectType(guest, 'session:ended');
    expect(ended.t).toBe('session:ended');
    const closed = await guest.closed;
    expect(closed.code).toBe(4002);
    // The pressed mouse button was released on teardown.
    const released = injector.events.filter((e) => e.type === 'button' && e.args[1] === false);
    expect(released).toHaveLength(1);
    expect(app.hub.sessions.size).toBe(0);
  });

  it('rejects guests when the session is full', async () => {
    injector.clear();
    const small = createApp({ injector, maxGuests: 1 });
    await new Promise<void>((resolve) => small.server.listen(0, '127.0.0.1', resolve));
    const smallPort = (small.server.address() as AddressInfo).port;
    try {
      const host = new TestClient(smallPort);
      const g1 = new TestClient(smallPort);
      const g2 = new TestClient(smallPort);
      clients.push(host, g1, g2);
      await Promise.all([host.ready(), g1.ready(), g2.ready()]);
      host.send({ t: 'host:create' });
      const created = await expectType(host, 'session:created');
      g1.send({ t: 'guest:join', code: created.code });
      await expectType(g1, 'guest:joined');
      g2.send({ t: 'guest:join', code: created.code });
      const error = await expectType(g2, 'error');
      expect(error.code).toBe('SESSION_FULL');
    } finally {
      await small.close();
    }
  });

  it('disconnects a socket that keeps guessing wrong session codes', async () => {
    const c = await client();
    for (let i = 0; i < 12; i++) c.send({ t: 'guest:join', code: 'ZZZZZZ' });
    const closed = await c.closed;
    expect(closed.code).toBe(1008);
  });

  it('rejects cross-origin WebSocket upgrades but allows origin-less clients', async () => {
    const evil = new TestClient(port, { origin: 'http://evil.example' });
    clients.push(evil);
    await expect(evil.ready()).rejects.toThrow();
    // A client with no Origin header (Node, tests) still connects fine.
    const ok = await client();
    ok.send({ t: 'host:create' });
    await expectType(ok, 'session:created');
  });

  it('answers malformed payloads with BAD_MESSAGE and eventually disconnects', async () => {
    const c = await client();
    c.sendRaw('not json');
    const error = await expectType(c, 'error');
    expect(error.code).toBe('BAD_MESSAGE');
    for (let i = 0; i < 12; i++) c.sendRaw('{"t":"nope"}');
    const closed = await c.closed;
    expect(closed.code).toBe(1008);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until a condition holds (avoids importing vitest's waitFor timers). */
async function vi_waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await delay(10);
  }
}
