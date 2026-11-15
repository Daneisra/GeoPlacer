/**
 * Virtual clock for the simulator (Phase 1B.7): time only moves when told
 * to; `sleep` advances it instantly. Deterministic runs, no real waiting.
 */

import type { AbortSignalLike, Clock, Timestamp } from '@geoplacer/core';

export interface ManualClock extends Clock {
  /** Moves time forward by `ms` (>= 0). */
  advance(ms: number): Timestamp;
  /** Sets the time (never backwards). */
  set(at: Timestamp): void;
}

export function createManualClock(start: Timestamp = 1_000_000): ManualClock {
  if (!Number.isSafeInteger(start) || start < 0) throw new Error('the clock starts at a non-negative integer time');
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('advance by a non-negative integer');
      now += ms;
      return now;
    },
    set(at) {
      if (!Number.isSafeInteger(at) || at < now) throw new Error('the clock never goes backwards');
      now = at;
    },
    async sleep(ms: number, signal?: AbortSignalLike) {
      if (signal?.aborted === true) throw new Error('aborted');
      if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('sleep for a non-negative integer');
      now += ms;
    },
  };
}
