/**
 * Time and randomness are injected everywhere in the scheduler so that tests are
 * deterministic and never wait for real time.
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Deterministic clock for tests. */
export class FakeClock implements Clock {
  private ms: number;

  constructor(start: Date | number | string) {
    this.ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  advanceMs(ms: number): void {
    this.ms += ms;
  }

  advanceMinutes(minutes: number): void {
    this.advanceMs(minutes * 60_000);
  }

  set(to: Date | number): void {
    this.ms = new Date(to).getTime();
  }
}

/** Returns a float in [0, 1). */
export type Rng = () => number;

/** Small deterministic PRNG (mulberry32) for reproducible jitter in tests. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
