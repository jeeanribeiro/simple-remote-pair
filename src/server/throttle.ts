/**
 * Coalesces high-frequency mouse-move events: at most one flush per interval,
 * always ending with the latest position (trailing edge), so fast wiggles
 * never queue up behind slow native calls.
 */
export class MoveThrottle {
  private lastFlush = 0;
  private pending: { x: number; y: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flush: (x: number, y: number) => void,
    private readonly intervalMs = 4,
    private readonly now: () => number = Date.now,
  ) {}

  push(x: number, y: number): void {
    const t = this.now();
    if (this.timer === null && t - this.lastFlush >= this.intervalMs) {
      this.lastFlush = t;
      this.flush(x, y);
      return;
    }
    this.pending = { x, y };
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.pending) {
          const { x: px, y: py } = this.pending;
          this.pending = null;
          this.lastFlush = this.now();
          this.flush(px, py);
        }
      }, this.intervalMs);
    }
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}

/** Classic token bucket; used to cap per-guest input event rates. */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  take(count = 1): boolean {
    const t = this.now();
    const elapsed = (t - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
      this.lastRefill = t;
    }
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }
}
