import { randomInt } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import {
  type ClientMessage,
  type InputEvent,
  type MouseButton,
  parseClientMessage,
  SESSION_CODE_ALPHABET,
  SESSION_CODE_LENGTH,
  type ServerMessage,
  sanitizeGuestName,
  WS_PATH,
} from '../shared/protocol.js';
import type { InputInjector } from './injector.js';
import { mapKey } from './keymap.js';
import { MoveThrottle, TokenBucket } from './throttle.js';

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_SIGNAL_BYTES = 64 * 1024;
const MAX_BAD_MESSAGES = 10;
/** Wrong codes / full sessions tolerated before a socket is dropped — stops code enumeration. */
const MAX_FAILED_JOINS = 10;
const MAX_SESSIONS_PER_IP = 4;
const INPUT_BUCKET_CAPACITY = 1200;
const INPUT_BUCKET_REFILL_PER_SECOND = 600;
const HEARTBEAT_INTERVAL_MS = 30_000;
const CLOSE_KICKED = 4001;
const CLOSE_SESSION_ENDED = 4002;

interface Guest {
  id: string;
  name: string;
  control: boolean;
  socket: WebSocket;
  pressedKeys: Set<string>;
  pressedButtons: Set<MouseButton>;
  moveThrottle: MoveThrottle;
  inputBucket: TokenBucket;
  wheelRemainder: { x: number; y: number };
}

interface Session {
  code: string;
  host: WebSocket;
  guests: Map<string, Guest>;
  paused: boolean;
  nextGuestNumber: number;
}

type Role = { kind: 'host'; session: Session } | { kind: 'guest'; session: Session; guest: Guest };

export interface HubOptions {
  injector: InputInjector;
  /** Server-wide switch: when false every session is view-only. */
  controlEnabled?: boolean;
  maxGuests?: number;
  maxSessions?: number;
  log?: (message: string) => void;
}

/**
 * Owns all sessions: pairs hosts with guests, relays WebRTC signaling, and
 * feeds validated guest input into the injector.
 */
export class SessionHub {
  readonly sessions = new Map<string, Session>();
  private readonly roles = new Map<WebSocket, Role>();
  private readonly badCounts = new Map<WebSocket, number>();
  private readonly failedJoins = new Map<WebSocket, number>();
  private readonly socketIps = new Map<WebSocket, string>();
  private readonly sessionsPerIp = new Map<string, number>();
  private readonly injector: InputInjector;
  private readonly controlEnabled: boolean;
  private readonly maxGuests: number;
  private readonly maxSessions: number;
  private readonly log: (message: string) => void;

  constructor(options: HubOptions) {
    this.injector = options.injector;
    this.controlEnabled = options.controlEnabled ?? true;
    this.maxGuests = options.maxGuests ?? 8;
    this.maxSessions = options.maxSessions ?? 32;
    this.log = options.log ?? (() => {});
  }

  get injectionAvailable(): boolean {
    return this.controlEnabled && this.injector.available;
  }

  handleConnection(socket: WebSocket, ip?: string): void {
    if (ip) this.socketIps.set(socket, ip);
    socket.on('message', (raw, isBinary) => {
      const message = this.decodeMessage(raw, isBinary);
      if (!message) {
        this.onBadMessage(socket);
        return;
      }
      this.onMessage(socket, message);
    });
    socket.on('close', () => this.onDisconnect(socket));
    socket.on('error', () => socket.terminate());
  }

  private decodeMessage(raw: unknown, isBinary: boolean): ClientMessage | null {
    if (isBinary || typeof raw !== 'object' || raw === null) return null;
    const text = String(raw);
    if (text.length > MAX_MESSAGE_BYTES) return null;
    try {
      return parseClientMessage(JSON.parse(text));
    } catch {
      return null;
    }
  }

  private onBadMessage(socket: WebSocket): void {
    const count = (this.badCounts.get(socket) ?? 0) + 1;
    this.badCounts.set(socket, count);
    this.send(socket, { t: 'error', code: 'BAD_MESSAGE', message: 'Malformed message.' });
    if (count >= MAX_BAD_MESSAGES) socket.close(1008, 'too many bad messages');
  }

  /** Count a failed join and drop the socket once it looks like code enumeration. */
  private onFailedJoin(socket: WebSocket): void {
    const count = (this.failedJoins.get(socket) ?? 0) + 1;
    this.failedJoins.set(socket, count);
    if (count >= MAX_FAILED_JOINS) socket.close(1008, 'too many failed joins');
  }

  private onMessage(socket: WebSocket, message: ClientMessage): void {
    switch (message.t) {
      case 'host:create':
        this.createSession(socket);
        break;
      case 'guest:join':
        this.joinSession(socket, message.code, message.name);
        break;
      case 'signal':
        this.routeSignal(socket, message.to, message.data);
        break;
      case 'input':
        this.handleInput(socket, message.ev);
        break;
      case 'host:control':
        this.setGuestControl(socket, message.guestId, message.control);
        break;
      case 'host:kick':
        this.kickGuest(socket, message.guestId);
        break;
      case 'host:pause':
        this.setPaused(socket, message.paused);
        break;
    }
  }

  private createSession(socket: WebSocket): void {
    if (this.roles.has(socket)) {
      this.send(socket, {
        t: 'error',
        code: 'ALREADY_IN_SESSION',
        message: 'This connection already belongs to a session.',
      });
      return;
    }
    if (this.sessions.size >= this.maxSessions) {
      this.send(socket, {
        t: 'error',
        code: 'SESSION_FULL',
        message: 'Too many active sessions on this server.',
      });
      return;
    }
    const ip = this.socketIps.get(socket);
    if (ip && (this.sessionsPerIp.get(ip) ?? 0) >= MAX_SESSIONS_PER_IP) {
      this.send(socket, {
        t: 'error',
        code: 'SESSION_FULL',
        message: 'Too many sessions from this device.',
      });
      return;
    }
    const code = this.generateCode();
    const session: Session = {
      code,
      host: socket,
      guests: new Map(),
      paused: false,
      nextGuestNumber: 1,
    };
    this.sessions.set(code, session);
    this.roles.set(socket, { kind: 'host', session });
    if (ip) this.sessionsPerIp.set(ip, (this.sessionsPerIp.get(ip) ?? 0) + 1);
    this.send(socket, { t: 'session:created', code });
    this.send(socket, { t: 'injector:status', available: this.injectionAvailable });
    this.log(`session ${code} created (${this.sessions.size} active)`);
  }

  private joinSession(socket: WebSocket, code: string, name: string | undefined): void {
    if (this.roles.has(socket)) {
      this.send(socket, {
        t: 'error',
        code: 'ALREADY_IN_SESSION',
        message: 'This connection already belongs to a session.',
      });
      return;
    }
    const session = this.sessions.get(code);
    if (!session) {
      this.send(socket, {
        t: 'error',
        code: 'BAD_CODE',
        message: 'No session with that code. Check it and try again.',
      });
      this.onFailedJoin(socket);
      return;
    }
    if (session.guests.size >= this.maxGuests) {
      this.send(socket, {
        t: 'error',
        code: 'SESSION_FULL',
        message: 'This session is full.',
      });
      this.onFailedJoin(socket);
      return;
    }
    const number = session.nextGuestNumber++;
    const guest: Guest = {
      id: `g${number}`,
      name: sanitizeGuestName(name, `Guest ${number}`),
      control: true,
      socket,
      pressedKeys: new Set(),
      pressedButtons: new Set(),
      moveThrottle: new MoveThrottle((x, y) => this.injectMove(x, y)),
      inputBucket: new TokenBucket(INPUT_BUCKET_CAPACITY, INPUT_BUCKET_REFILL_PER_SECOND),
      wheelRemainder: { x: 0, y: 0 },
    };
    session.guests.set(guest.id, guest);
    this.roles.set(socket, { kind: 'guest', session, guest });
    this.send(socket, {
      t: 'guest:joined',
      guestId: guest.id,
      name: guest.name,
      control: guest.control,
      paused: session.paused,
    });
    this.send(socket, { t: 'injector:status', available: this.injectionAvailable });
    this.send(session.host, {
      t: 'guest:connected',
      guest: { id: guest.id, name: guest.name, control: guest.control },
    });
    this.log(`guest ${guest.id} (${guest.name}) joined session ${session.code}`);
  }

  private routeSignal(socket: WebSocket, to: string | undefined, data: unknown): void {
    const role = this.roles.get(socket);
    if (!role) {
      this.send(socket, {
        t: 'error',
        code: 'NOT_IN_SESSION',
        message: 'Join or create a session before signaling.',
      });
      return;
    }
    if (JSON.stringify(data).length > MAX_SIGNAL_BYTES) {
      this.onBadMessage(socket);
      return;
    }
    if (role.kind === 'host') {
      if (!to) {
        this.onBadMessage(socket);
        return;
      }
      const guest = role.session.guests.get(to);
      if (!guest) return; // Guest left between messages; drop silently.
      this.send(guest.socket, { t: 'signal', from: 'host', data });
    } else {
      this.send(role.session.host, { t: 'signal', from: role.guest.id, data });
    }
  }

  private handleInput(socket: WebSocket, ev: InputEvent): void {
    const role = this.roles.get(socket);
    if (role?.kind !== 'guest') return;
    const { session, guest } = role;
    if (!guest.control || session.paused || !this.injectionAvailable) return;
    if (!guest.inputBucket.take()) return;

    switch (ev.k) {
      case 'move':
        guest.moveThrottle.push(ev.x, ev.y);
        return;
      case 'down': {
        // Drop any pending trailing move so it can't fire *after* the press
        // and drag the cursor back to a stale position.
        guest.moveThrottle.dispose();
        this.injectMove(ev.x, ev.y);
        this.injector.toggleMouseButton(ev.button, true);
        guest.pressedButtons.add(ev.button);
        return;
      }
      case 'up': {
        this.injector.toggleMouseButton(ev.button, false);
        guest.pressedButtons.delete(ev.button);
        return;
      }
      case 'wheel': {
        // Accumulate fractional notches so slow trackpad scrolling still lands.
        const acc = guest.wheelRemainder;
        acc.x += clamp(ev.dx, -25, 25);
        acc.y += clamp(ev.dy, -25, 25);
        const nx = Math.trunc(acc.x);
        const ny = Math.trunc(acc.y);
        if (nx !== 0 || ny !== 0) {
          acc.x -= nx;
          acc.y -= ny;
          this.injector.scroll(nx, ny);
        }
        return;
      }
      case 'key': {
        const mapped = mapKey(ev.key);
        if (!mapped) return;
        if (mapped.type === 'text') {
          if (ev.down) this.injector.typeText(mapped.text);
          return;
        }
        this.injector.toggleKey(mapped.key, ev.down);
        if (ev.down) guest.pressedKeys.add(mapped.key);
        else guest.pressedKeys.delete(mapped.key);
        return;
      }
    }
  }

  private injectMove(x: number, y: number): void {
    const { width, height } = this.injector.screenSize();
    this.injector.moveMouse(Math.round(x * (width - 1)), Math.round(y * (height - 1)));
  }

  /** Release everything a guest is holding so keys never stick on the host. */
  private releaseInputs(guest: Guest): void {
    guest.moveThrottle.dispose();
    for (const key of guest.pressedKeys) this.injector.toggleKey(key, false);
    guest.pressedKeys.clear();
    for (const button of guest.pressedButtons) this.injector.toggleMouseButton(button, false);
    guest.pressedButtons.clear();
  }

  private requireHost(socket: WebSocket): Session | null {
    const role = this.roles.get(socket);
    if (role?.kind !== 'host') {
      this.send(socket, {
        t: 'error',
        code: 'NOT_HOST',
        message: 'Only the session host can do that.',
      });
      return null;
    }
    return role.session;
  }

  private setGuestControl(socket: WebSocket, guestId: string, control: boolean): void {
    const session = this.requireHost(socket);
    const guest = session?.guests.get(guestId);
    if (!session || !guest) return;
    guest.control = control;
    if (!control) this.releaseInputs(guest);
    this.send(guest.socket, { t: 'control:changed', control, paused: session.paused });
  }

  private kickGuest(socket: WebSocket, guestId: string): void {
    const session = this.requireHost(socket);
    const guest = session?.guests.get(guestId);
    if (!session || !guest) return;
    // Tear down state synchronously: a hostile client can withhold the close
    // handshake for up to 30s, and until the role is gone it could keep
    // injecting input and holding a guest slot. Removing the role now means
    // any further frames hit the "not in session" path instead.
    this.releaseInputs(guest);
    session.guests.delete(guest.id);
    this.roles.delete(guest.socket);
    this.socketIps.delete(guest.socket);
    this.send(session.host, { t: 'guest:disconnected', guestId: guest.id });
    guest.socket.close(CLOSE_KICKED, 'Removed by host');
  }

  private setPaused(socket: WebSocket, paused: boolean): void {
    const session = this.requireHost(socket);
    if (!session) return;
    session.paused = paused;
    for (const guest of session.guests.values()) {
      if (paused) this.releaseInputs(guest);
      this.send(guest.socket, { t: 'control:changed', control: guest.control, paused });
    }
  }

  private onDisconnect(socket: WebSocket): void {
    this.badCounts.delete(socket);
    this.failedJoins.delete(socket);
    const ip = this.socketIps.get(socket);
    this.socketIps.delete(socket);
    const role = this.roles.get(socket);
    this.roles.delete(socket);
    if (!role) return;
    if (role.kind === 'host') {
      const { session } = role;
      this.sessions.delete(session.code);
      if (ip) {
        const remaining = (this.sessionsPerIp.get(ip) ?? 1) - 1;
        if (remaining > 0) this.sessionsPerIp.set(ip, remaining);
        else this.sessionsPerIp.delete(ip);
      }
      for (const guest of session.guests.values()) {
        this.releaseInputs(guest);
        this.roles.delete(guest.socket);
        this.send(guest.socket, { t: 'session:ended' });
        guest.socket.close(CLOSE_SESSION_ENDED, 'Session ended');
      }
      this.log(`session ${session.code} ended (${this.sessions.size} active)`);
    } else {
      const { session, guest } = role;
      this.releaseInputs(guest);
      session.guests.delete(guest.id);
      this.send(session.host, { t: 'guest:disconnected', guestId: guest.id });
      this.log(`guest ${guest.id} left session ${session.code}`);
    }
  }

  private generateCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < SESSION_CODE_LENGTH; i++) {
        code += SESSION_CODE_ALPHABET[randomInt(SESSION_CODE_ALPHABET.length)];
      }
      if (!this.sessions.has(code)) return code;
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface AttachOptions {
  /**
   * Destroy upgrade requests to unknown paths. Off in dev so Vite's HMR
   * upgrade listener still receives them; on in production where this is the
   * only upgrade handler, so stray upgrades don't leak sockets.
   */
  destroyUnknownUpgrades?: boolean;
}

/**
 * Reject cross-site WebSocket hijacking: a browser always sends an Origin, and
 * the same-origin client always connects via `location.host`, so an Origin
 * whose host differs from the request Host is a foreign page. Origin-less
 * clients (Node, tests) are allowed through.
 */
function isAllowedOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

/**
 * Attach a hub to an HTTP server at the protocol's WebSocket path. Coexists
 * with other upgrade listeners (e.g. Vite's HMR socket) by only claiming
 * upgrades addressed to WS_PATH.
 */
export function attachHub(
  server: Server,
  hub: SessionHub,
  options: AttachOptions = {},
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const alive = new WeakMap<WebSocket, boolean>();
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== WS_PATH) {
      if (options.destroyUnknownUpgrades) socket.destroy();
      return;
    }
    if (!isAllowedOrigin(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });
  wss.on('connection', (socket, request: IncomingMessage) => {
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
    hub.handleConnection(socket, request.socket.remoteAddress);
  });
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}
