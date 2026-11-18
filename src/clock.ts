/**
 * Time and randomness are injected rather than read from globals, so tests
 * and the simulation can control them exactly: no sleeping, no flaky timing.
 */
export interface Clock {
  now(): number; // epoch milliseconds
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock that only moves when told to. */
export class ManualClock implements Clock {
  constructor(private current = Date.UTC(2026, 0, 31, 9, 0, 0)) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export type Random = () => number; // [0, 1), like Math.random

/** Small deterministic PRNG (mulberry32): the same seed always gives the same sequence. */
export function seededRandom(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
