import type { MouseButton } from '../shared/protocol.js';

/**
 * Abstraction over OS-level input injection.
 *
 * The real implementation uses `@hurdlegroup/robotjs` (an optional native
 * dependency). When it is missing or fails to load, the server falls back to
 * the no-op injector and sessions become view-only instead of crashing.
 */
export interface InputInjector {
  readonly kind: 'robotjs' | 'fake' | 'noop';
  /** Whether input events will actually reach the host OS. */
  readonly available: boolean;
  screenSize(): { width: number; height: number };
  moveMouse(x: number, y: number): void;
  toggleMouseButton(button: MouseButton, down: boolean): void;
  /** Scroll by whole wheel notches (positive dy scrolls up). */
  scroll(dxNotches: number, dyNotches: number): void;
  /** Press or release a key by its robotjs key name. */
  toggleKey(key: string, down: boolean): void;
  /** Type a short piece of literal text (used for keys robotjs cannot toggle). */
  typeText(text: string): void;
}

export type InjectorChoice = 'auto' | 'robotjs' | 'noop' | 'fake';

export function noopInjector(): InputInjector {
  return {
    kind: 'noop',
    available: false,
    screenSize: () => ({ width: 1, height: 1 }),
    moveMouse: () => {},
    toggleMouseButton: () => {},
    scroll: () => {},
    toggleKey: () => {},
    typeText: () => {},
  };
}

export interface RecordedInjection {
  type: 'move' | 'button' | 'scroll' | 'key' | 'text';
  args: (string | number | boolean)[];
}

export interface FakeInjector extends InputInjector {
  readonly kind: 'fake';
  readonly events: RecordedInjection[];
  clear(): void;
}

/** In-memory injector used by tests and the e2e suite. */
export function fakeInjector(): FakeInjector {
  const events: RecordedInjection[] = [];
  const record = (entry: RecordedInjection) => {
    // Bound memory in long e2e runs.
    if (events.length >= 10_000) events.shift();
    events.push(entry);
  };
  return {
    kind: 'fake',
    available: true,
    events,
    clear: () => {
      events.length = 0;
    },
    screenSize: () => ({ width: 1920, height: 1080 }),
    moveMouse: (x, y) => record({ type: 'move', args: [x, y] }),
    toggleMouseButton: (button, down) => record({ type: 'button', args: [button, down] }),
    scroll: (dx, dy) => record({ type: 'scroll', args: [dx, dy] }),
    toggleKey: (key, down) => record({ type: 'key', args: [key, down] }),
    typeText: (text) => record({ type: 'text', args: [text] }),
  };
}

const ROBOT_BUTTONS: Record<MouseButton, string> = { 0: 'left', 1: 'middle', 2: 'right' };

/** Wheel notch multiplier: Windows expects WHEEL_DELTA units, others line counts. */
const SCROLL_FACTOR = process.platform === 'win32' ? 120 : 3;

const SCREEN_SIZE_TTL_MS = 5_000;

/** Swallow native-injection errors so one bad event can't take down the server. */
function guard(fn: () => void): void {
  try {
    fn();
  } catch {
    // Invalid key name, transient OS error, etc. — drop the event.
  }
}

interface RobotModule {
  getScreenSize(): { width: number; height: number };
  moveMouse(x: number, y: number): void;
  mouseToggle(down: 'down' | 'up', button: string): void;
  scrollMouse(x: number, y: number): void;
  keyToggle(key: string, down: 'down' | 'up'): void;
  typeString(text: string): void;
  setMouseDelay(delay: number): void;
  setKeyboardDelay(delay: number): void;
}

function robotInjector(robot: RobotModule): InputInjector {
  // robotjs sleeps 10ms after every call by default; that would cap us at
  // ~100 events/second and make dragging feel like molasses.
  robot.setMouseDelay(0);
  robot.setKeyboardDelay(0);

  let cachedScreen = robot.getScreenSize();
  let cachedAt = Date.now();

  return {
    kind: 'robotjs',
    available: true,
    screenSize: () => {
      const now = Date.now();
      if (now - cachedAt > SCREEN_SIZE_TTL_MS) {
        cachedScreen = robot.getScreenSize();
        cachedAt = now;
      }
      return cachedScreen;
    },
    moveMouse: (x, y) => guard(() => robot.moveMouse(x, y)),
    toggleMouseButton: (button, down) =>
      guard(() => robot.mouseToggle(down ? 'down' : 'up', ROBOT_BUTTONS[button])),
    scroll: (dx, dy) => guard(() => robot.scrollMouse(dx * SCROLL_FACTOR, dy * SCROLL_FACTOR)),
    // robotjs throws on any key name it does not recognize; never let that
    // propagate out of a socket message handler and crash the server.
    toggleKey: (key, down) => guard(() => robot.keyToggle(key, down ? 'down' : 'up')),
    typeText: (text) => guard(() => robot.typeString(text)),
  };
}

/**
 * Resolve the injector to use. `auto` tries robotjs and falls back to noop.
 * Returns the injector plus a human-readable note when a fallback happened.
 */
export async function resolveInjector(
  choice: InjectorChoice,
): Promise<{ injector: InputInjector; note?: string }> {
  if (choice === 'noop') return { injector: noopInjector() };
  if (choice === 'fake') return { injector: fakeInjector() };
  try {
    const mod = (await import('@hurdlegroup/robotjs')) as unknown as
      | RobotModule
      | { default: RobotModule };
    const robot = 'getScreenSize' in mod ? mod : mod.default;
    return { injector: robotInjector(robot) };
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    const note = `robotjs unavailable (${reason}) — running in view-only mode`;
    if (choice === 'robotjs') throw new Error(note, { cause: err });
    return { injector: noopInjector(), note };
  }
}
