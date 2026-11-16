/**
 * Computations cut into slices (Phase 1C.0).
 *
 * A long computation (classifying every pixel of a 4096 x 4096 template) is written ONCE, as a
 * generator that yields between slices of about `perSlice` pixels. Two drivers run it:
 * - runSliced: synchronously, without ever stopping (the behaviour before 1C.0, and every
 *   synchronous API such as computeProgress or nextBatch);
 * - runSlicedAsync: awaiting the host's `yieldTo()` between slices, so that HTTP requests,
 *   WebSocket messages and commands are served meanwhile.
 * Same code, same result: only the points where the host may run other work differ.
 *
 * The data a sliced computation reads must not change between its slices: the callers give it a
 * snapshot copied at the start of the cycle and an immutable template revision. A computation
 * abandoned at a slice boundary (pause, stop) is closed (`return()`), so that it never publishes a
 * partial result; the computations commit their state only when they finish.
 */

/** A computation that yields (nothing) between slices and returns its result. */
export type Sliced<T> = Generator<void, T, void>;

/** Counts the work done since the last yield. */
export class SliceBudget {
  private spent = 0;

  /** `perSlice`: pixels of work per slice (Infinity: never a slice boundary). */
  constructor(readonly perSlice: number) {}

  /** Records `pixels` of work; true when a slice is complete (the caller then yields). */
  add(pixels: number): boolean {
    this.spent += pixels;
    if (this.spent < this.perSlice) return false;
    this.spent = 0;
    return true;
  }
}

/** A budget that never ends a slice: the synchronous behaviour. */
export const unsliced = (): SliceBudget => new SliceBudget(Infinity);

/** Runs a sliced computation to the end, synchronously. */
export function runSliced<T>(work: Sliced<T>): T {
  for (;;) {
    const step = work.next();
    if (step.done === true) return step.value;
  }
}

/** Thrown by runSlicedAsync when `abandon()` asked to stop at a slice boundary. */
export class SliceAbandoned extends Error {
  constructor() {
    super('computation abandoned at a slice boundary');
    this.name = 'SliceAbandoned';
  }
}

/**
 * Runs a sliced computation, awaiting `yieldTo()` between slices. After each yield, `abandon()`
 * (optional) may stop it: the generator is closed (its `finally` blocks run) and SliceAbandoned
 * is thrown; nothing of the computation is published.
 */
export async function runSlicedAsync<T>(work: Sliced<T>, yieldTo: () => Promise<void>, abandon?: () => boolean): Promise<T> {
  for (;;) {
    const step = work.next();
    if (step.done === true) return step.value;
    await yieldTo();
    if (abandon?.() === true) {
      work.return(undefined as never);
      throw new SliceAbandoned();
    }
  }
}
