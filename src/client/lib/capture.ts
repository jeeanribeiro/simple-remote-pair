import type { MouseButton, InputEvent as RemoteInputEvent } from '../../shared/protocol.js';

/** Pixels of `wheel` delta that equal one wheel notch (Chrome's default). */
const WHEEL_PX_PER_NOTCH = 100;
/** Lines per notch when the browser reports line-based deltas. */
const WHEEL_LINES_PER_NOTCH = 3;
const DOUBLE_ESC_WINDOW_MS = 400;

export interface CaptureCallbacks {
  send: (event: RemoteInputEvent) => void;
  /** Called when the user releases control (double-Esc or window blur). */
  onRelease: () => void;
}

/**
 * Captures pointer, wheel and keyboard input over the remote video and turns
 * it into protocol events with coordinates normalized to the *video content*
 * (accounting for the letterboxing `object-fit: contain` introduces — mapping
 * against the raw element rect would drift as soon as aspect ratios differ).
 */
export class InputCapture {
  private enabled = false;
  private rafId = 0;
  private pendingMove: { x: number; y: number } | null = null;
  private lastSentMove: { x: number; y: number } | null = null;
  private readonly pressedKeys = new Set<string>();
  private readonly pressedButtons = new Set<MouseButton>();
  private lastEscapeAt = 0;
  private readonly abort = new AbortController();

  constructor(
    private readonly stage: HTMLElement,
    private readonly video: HTMLVideoElement,
    private readonly callbacks: CaptureCallbacks,
  ) {
    const opts = { signal: this.abort.signal };
    const wheelOpts = { signal: this.abort.signal, passive: false };
    stage.addEventListener('pointermove', (e) => this.onPointerMove(e), opts);
    stage.addEventListener('pointerdown', (e) => this.onPointerDown(e), opts);
    stage.addEventListener('pointerup', (e) => this.onPointerUp(e), opts);
    stage.addEventListener('contextmenu', (e) => e.preventDefault(), opts);
    stage.addEventListener('wheel', (e) => this.onWheel(e), wheelOpts);
    // Key listeners live on window, not the stage: while controlling, clicking
    // a header button (Fullscreen/Leave) would move focus off the stage and
    // silently break both key forwarding and the double-Esc release. The
    // handlers already no-op unless `enabled`, and the AbortController cleans
    // them up either way.
    window.addEventListener('keydown', (e) => this.onKey(e, true), opts);
    window.addEventListener('keyup', (e) => this.onKey(e, false), opts);
    window.addEventListener('blur', () => this.enabled && this.release(), opts);
  }

  get active(): boolean {
    return this.enabled;
  }

  enable(): void {
    this.enabled = true;
    this.stage.focus();
  }

  /** Stop forwarding and release everything still held on the host. */
  release(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.releasePressed();
    this.callbacks.onRelease();
  }

  dispose(): void {
    this.enabled = false;
    this.releasePressed();
    this.abort.abort();
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }

  private releasePressed(): void {
    for (const key of this.pressedKeys) this.callbacks.send({ k: 'key', key, down: false });
    this.pressedKeys.clear();
    for (const button of this.pressedButtons) this.callbacks.send({ k: 'up', button });
    this.pressedButtons.clear();
    this.pendingMove = null;
  }

  /**
   * Map viewport coordinates onto the displayed video content, normalized to
   * [0, 1]. Returns null while the stream has no dimensions yet or when the
   * point falls into a letterbox bar.
   */
  private mapPoint(clientX: number, clientY: number): { x: number; y: number } | null {
    const { videoWidth, videoHeight } = this.video;
    if (videoWidth === 0 || videoHeight === 0) return null;
    const rect = this.video.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
    const contentWidth = videoWidth * scale;
    const contentHeight = videoHeight * scale;
    const offsetX = rect.left + (rect.width - contentWidth) / 2;
    const offsetY = rect.top + (rect.height - contentHeight) / 2;

    const x = (clientX - offsetX) / contentWidth;
    const y = (clientY - offsetY) / contentHeight;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.enabled) return;
    const point = this.mapPoint(event.clientX, event.clientY);
    if (!point) return;
    this.pendingMove = point;
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      const move = this.pendingMove;
      this.pendingMove = null;
      if (!move) return;
      if (this.lastSentMove && this.lastSentMove.x === move.x && this.lastSentMove.y === move.y) {
        return;
      }
      this.lastSentMove = move;
      this.callbacks.send({ k: 'move', x: move.x, y: move.y });
    });
  }

  private onPointerDown(event: PointerEvent): void {
    if (!this.enabled) return;
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    const point = this.mapPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    // preventDefault suppresses the browser's default focus-on-click, so
    // refocus explicitly to keep Keyboard Lock and key routing on the stage.
    this.stage.focus();
    this.stage.setPointerCapture(event.pointerId);
    const button = event.button as MouseButton;
    this.pressedButtons.add(button);
    this.callbacks.send({ k: 'down', x: point.x, y: point.y, button });
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.enabled) return;
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    const button = event.button as MouseButton;
    if (!this.pressedButtons.has(button)) return;
    this.pressedButtons.delete(button);
    this.callbacks.send({ k: 'up', button });
  }

  private onWheel(event: WheelEvent): void {
    if (!this.enabled) return;
    event.preventDefault();
    const perNotch =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINES_PER_NOTCH : WHEEL_PX_PER_NOTCH;
    // Browser deltas are positive scrolling down; wheel notches are positive up.
    this.callbacks.send({
      k: 'wheel',
      dx: event.deltaX / perNotch,
      dy: -event.deltaY / perNotch,
    });
  }

  private onKey(event: KeyboardEvent, down: boolean): void {
    if (!this.enabled) return;
    event.preventDefault();
    if (event.repeat) return;

    if (event.key === 'Escape' && down) {
      const now = performance.now();
      if (now - this.lastEscapeAt < DOUBLE_ESC_WINDOW_MS) {
        this.lastEscapeAt = 0;
        this.release();
        return;
      }
      this.lastEscapeAt = now;
    }

    if (down) this.pressedKeys.add(event.key);
    else this.pressedKeys.delete(event.key);
    this.callbacks.send({ k: 'key', key: event.key, down });
  }
}
