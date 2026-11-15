/**
 * Real-time clock of the service (Phase 1B.9): never goes backwards, not
 * even across a restart (it starts no earlier than the saved world), and
 * waits with timers that an AbortSignal cancels.
 */

import type { AbortSignalLike, Clock } from '@geoplacer/core';

export interface MonotonicClock extends Clock {
  /** Raises the floor (a time read from disk). */
  atLeast(t: number): void;
}

export function monotonicClock(floor = 0, source: () => number = Date.now): MonotonicClock {
  let last = floor;
  return {
    now() {
      last = Math.max(last, source());
      return last;
    },
    atLeast(t) {
      last = Math.max(last, t);
    },
    sleep(ms: number, signal?: AbortSignalLike) {
      return new Promise<void>((resolve) => {
        if (signal?.aborted === true || ms <= 0) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
