import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoveThrottle, TokenBucket } from '../src/server/throttle.js';

describe('MoveThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes the first move immediately', () => {
    const flushed: [number, number][] = [];
    const throttle = new MoveThrottle(
      (x, y) => flushed.push([x, y]),
      4,
      () => Date.now(),
    );
    throttle.push(0.1, 0.2);
    expect(flushed).toEqual([[0.1, 0.2]]);
  });

  it('coalesces a burst into first + latest', () => {
    const flushed: [number, number][] = [];
    const throttle = new MoveThrottle(
      (x, y) => flushed.push([x, y]),
      4,
      () => Date.now(),
    );
    throttle.push(0.1, 0.1);
    throttle.push(0.2, 0.2);
    throttle.push(0.3, 0.3);
    expect(flushed).toEqual([[0.1, 0.1]]);
    vi.advanceTimersByTime(5);
    expect(flushed).toEqual([
      [0.1, 0.1],
      [0.3, 0.3],
    ]);
  });

  it('drops pending moves on dispose', () => {
    const flushed: [number, number][] = [];
    const throttle = new MoveThrottle(
      (x, y) => flushed.push([x, y]),
      4,
      () => Date.now(),
    );
    throttle.push(0.1, 0.1);
    throttle.push(0.2, 0.2);
    throttle.dispose();
    vi.advanceTimersByTime(10);
    expect(flushed).toEqual([[0.1, 0.1]]);
  });
});

describe('TokenBucket', () => {
  it('allows bursts up to capacity then refuses', () => {
    const now = 0;
    const bucket = new TokenBucket(3, 1, () => now);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it('refills over time up to capacity', () => {
    let now = 0;
    const bucket = new TokenBucket(2, 1, () => now);
    bucket.take(2);
    expect(bucket.take()).toBe(false);
    now = 1000;
    expect(bucket.take()).toBe(true);
    now = 100_000;
    expect(bucket.take(2)).toBe(true); // capped at capacity, not unbounded
    expect(bucket.take()).toBe(false);
  });
});
