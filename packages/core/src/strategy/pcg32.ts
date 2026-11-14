/**
 * PCG32 (M. E. O'Neill, pcg-random.org): PCG-XSH-RR, 64-bit state, 32-bit
 * output, the generator of the reference `pcg32_random_r`,
 * `pcg32_srandom_r` and `pcg32_boundedrand_r` (pcg-c-basic).
 *
 * Explicit and versioned: the random drawing order depends on every output
 * of this generator, so it must never change silently. Its outputs are
 * checked against the reference test vectors (initstate 42, initseq 54).
 *
 * The 64-bit state lives in two uint32 halves; the multiplication uses
 * 16-bit limbs (exact in doubles) and Math.imul — no BigInt in the hot path.
 */

export const PCG32_ALGORITHM = 'pcg32-xsh-rr' as const;

const MUL_HI = 0x5851f42d;
const MUL_LO = 0x4c957f2d; // 6364136223846793005
const TWO32 = 0x1_0000_0000;

export interface Pcg32 {
  /** Next uniform uint32. */
  next(): number;
  /** Uniform integer in [0, bound), bound in [1, 2^32]; unbiased (rejection, as pcg32_boundedrand_r). */
  bounded(bound: number): number;
}

function split(value: number, what: string): [number, number] {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${what} must be a non-negative safe integer`);
  return [Math.floor(value / TWO32) >>> 0, value >>> 0];
}

/** Equivalent of pcg32_srandom_r(initstate, initseq) for non-negative safe integers. */
export function createPcg32(initState: number, initSeq: number): Pcg32 {
  const [stateHi0, stateLo0] = split(initState, 'initState');
  const [seqHi, seqLo] = split(initSeq, 'initSeq');
  // inc = (initseq << 1) | 1 (mod 2^64)
  const incHi = ((seqHi << 1) | (seqLo >>> 31)) >>> 0;
  const incLo = ((seqLo << 1) | 1) >>> 0;
  let hi = 0;
  let lo = 0;

  /** state = state * MUL + inc (mod 2^64). */
  function step(): void {
    const a0 = lo & 0xffff;
    const a1 = lo >>> 16;
    const b0 = MUL_LO & 0xffff;
    const b1 = MUL_LO >>> 16;
    const mid = a0 * b1 + a1 * b0; // < 2^33
    const low = a0 * b0 + (mid % 0x10000) * 0x10000; // < 2^33
    const productLo = low % TWO32;
    // High half of lo * MUL_LO, then the cross terms (only their low 32 bits matter).
    const productHi = a1 * b1 + Math.floor(mid / 0x10000) + Math.floor(low / TWO32) + Math.imul(hi, MUL_LO) + Math.imul(lo, MUL_HI);
    const sumLo = productLo + incLo;
    lo = sumLo >>> 0;
    hi = (productHi + incHi + (sumLo >= TWO32 ? 1 : 0)) >>> 0;
  }

  // pcg32_srandom_r
  step();
  const sumLo = lo + stateLo0;
  lo = sumLo >>> 0;
  hi = (hi + stateHi0 + (sumLo >= TWO32 ? 1 : 0)) >>> 0;
  step();

  function next(): number {
    const oldHi = hi;
    const oldLo = lo;
    step();
    // xorshifted = ((old >> 18) ^ old) >> 27, truncated to 32 bits; rot = old >> 59
    const xHi = oldHi ^ (oldHi >>> 18);
    const xLo = oldLo ^ ((oldLo >>> 18) | (oldHi << 14));
    const xorshifted = ((xLo >>> 27) | (xHi << 5)) >>> 0;
    const rot = oldHi >>> 27;
    return ((xorshifted >>> rot) | (xorshifted << (-rot & 31))) >>> 0;
  }

  return {
    next,
    bounded(bound: number): number {
      if (!Number.isSafeInteger(bound) || bound < 1 || bound > TWO32) throw new RangeError('bound must be an integer in [1, 2^32]');
      const threshold = (TWO32 - bound) % bound;
      for (;;) {
        const r = next();
        if (r >= threshold) return r % bound;
      }
    },
  };
}
