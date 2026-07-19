/**
 * Wire protocol shared by the browser client and the Node server.
 *
 * Every message is a JSON object with a `t` discriminant. The server treats
 * WebRTC signaling payloads as opaque (it only routes them), so the SDP/ICE
 * shapes are not modeled here beyond "unknown".
 */

export const WS_PATH = '/ws';

export const SESSION_CODE_LENGTH = 6;

/** Unambiguous alphabet for session codes: no 0/O, 1/I/L. */
export const SESSION_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const MAX_GUEST_NAME_LENGTH = 24;

/** Mouse buttons follow `MouseEvent.button`: 0 = left, 1 = middle, 2 = right. */
export type MouseButton = 0 | 1 | 2;

/** Input events a guest can send. Coordinates are normalized to [0, 1]. */
export type InputEvent =
  | { k: 'move'; x: number; y: number }
  | { k: 'down'; x: number; y: number; button: MouseButton }
  | { k: 'up'; button: MouseButton }
  | { k: 'wheel'; dx: number; dy: number }
  | { k: 'key'; key: string; down: boolean };

/** Messages the client sends to the server. */
export type ClientMessage =
  | { t: 'host:create' }
  | { t: 'guest:join'; code: string; name?: string }
  | { t: 'signal'; to?: string; data: unknown }
  | { t: 'input'; ev: InputEvent }
  | { t: 'host:control'; guestId: string; control: boolean }
  | { t: 'host:kick'; guestId: string }
  | { t: 'host:pause'; paused: boolean };

export interface GuestInfo {
  id: string;
  name: string;
  control: boolean;
}

export type ErrorCode =
  | 'BAD_CODE'
  | 'SESSION_FULL'
  | 'ALREADY_IN_SESSION'
  | 'NOT_IN_SESSION'
  | 'NOT_HOST'
  | 'BAD_MESSAGE'
  | 'RATE_LIMITED';

/** Messages the server sends to clients. */
export type ServerMessage =
  | { t: 'session:created'; code: string }
  | { t: 'guest:joined'; guestId: string; name: string; control: boolean; paused: boolean }
  | { t: 'guest:connected'; guest: GuestInfo }
  | { t: 'guest:disconnected'; guestId: string }
  | { t: 'signal'; from: string; data: unknown }
  | { t: 'control:changed'; control: boolean; paused: boolean }
  | { t: 'session:ended' }
  | { t: 'injector:status'; available: boolean }
  | { t: 'error'; code: ErrorCode; message: string };

const MOUSE_BUTTONS: readonly number[] = [0, 1, 2];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNormalized(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isSessionCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === SESSION_CODE_LENGTH &&
    [...value].every((ch) => SESSION_CODE_ALPHABET.includes(ch))
  );
}

export function parseInputEvent(value: unknown): InputEvent | null {
  if (!isRecord(value)) return null;
  switch (value.k) {
    case 'move':
      return isNormalized(value.x) && isNormalized(value.y)
        ? { k: 'move', x: value.x, y: value.y }
        : null;
    case 'down':
      return isNormalized(value.x) &&
        isNormalized(value.y) &&
        MOUSE_BUTTONS.includes(value.button as number)
        ? { k: 'down', x: value.x, y: value.y, button: value.button as MouseButton }
        : null;
    case 'up':
      return MOUSE_BUTTONS.includes(value.button as number)
        ? { k: 'up', button: value.button as MouseButton }
        : null;
    case 'wheel':
      return isFiniteNumber(value.dx) && isFiniteNumber(value.dy)
        ? { k: 'wheel', dx: value.dx, dy: value.dy }
        : null;
    case 'key':
      return typeof value.key === 'string' &&
        value.key.length > 0 &&
        value.key.length <= 32 &&
        typeof value.down === 'boolean'
        ? { k: 'key', key: value.key, down: value.down }
        : null;
    default:
      return null;
  }
}

/**
 * Parse and validate a raw client message. Returns null for anything that
 * does not exactly match the protocol — callers treat that as a bad message.
 */
export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value)) return null;
  switch (value.t) {
    case 'host:create':
      return { t: 'host:create' };
    case 'guest:join': {
      if (typeof value.code !== 'string') return null;
      const code = value.code.toUpperCase();
      if (!isSessionCode(code)) return null;
      if (value.name !== undefined && typeof value.name !== 'string') return null;
      return value.name === undefined
        ? { t: 'guest:join', code }
        : { t: 'guest:join', code, name: value.name };
    }
    case 'signal': {
      if (value.data === undefined) return null;
      if (value.to !== undefined && typeof value.to !== 'string') return null;
      return value.to === undefined
        ? { t: 'signal', data: value.data }
        : { t: 'signal', to: value.to, data: value.data };
    }
    case 'input': {
      const ev = parseInputEvent(value.ev);
      return ev ? { t: 'input', ev } : null;
    }
    case 'host:control':
      return typeof value.guestId === 'string' && typeof value.control === 'boolean'
        ? { t: 'host:control', guestId: value.guestId, control: value.control }
        : null;
    case 'host:kick':
      return typeof value.guestId === 'string' ? { t: 'host:kick', guestId: value.guestId } : null;
    case 'host:pause':
      return typeof value.paused === 'boolean' ? { t: 'host:pause', paused: value.paused } : null;
    default:
      return null;
  }
}

/** Normalize an untrusted display name into something safe to render. */
export function sanitizeGuestName(name: string | undefined, fallback: string): string {
  if (!name) return fallback;
  // Strip control characters, collapse whitespace, cap the length.
  const cleaned = name
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_GUEST_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : fallback;
}
