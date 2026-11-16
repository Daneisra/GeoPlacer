/**
 * Phase 1C.0: what would moving the progress computation to a worker thread cost, before any
 * computation? A 4096 x 4096 snapshot (Int32Array, 64 MiB) sent to a worker and acknowledged:
 * - copied (structured clone): the main thread serialises 64 MiB;
 * - transferred (ArrayBuffer transfer): no copy, but the main thread loses the buffer (the
 *   scheduler would need its own copy first, i.e. the same 64 MiB copy);
 * - shared (SharedArrayBuffer): no copy, but the simulator's canvas and its snapshots would have
 *   to live in shared memory, with the writes synchronised (Atomics) against the reads.
 * Measured: round trip, and the longest event loop block on the main thread meanwhile.
 * usage: node --import tsx bench/worker-transfer.bench.ts [side]
 */

import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

const SIDE = Number(process.argv[2] ?? 4096);
const worker = new Worker(
  `const { parentPort } = require('node:worker_threads');
   parentPort.on('message', (m) => { const a = new Int32Array(m.buffer ?? m); let s = 0; for (let i = 0; i < a.length; i += 4096) s += a[i]; parentPort.postMessage(s); });`,
  { eval: true }
);
const roundTrip = (payload: unknown, transfer?: ArrayBuffer[]): Promise<number> =>
  new Promise((resolve) => {
    const t0 = performance.now();
    worker.once('message', () => resolve(performance.now() - t0));
    worker.postMessage(payload, transfer);
  });

async function measure(name: string, make: () => { payload: unknown; transfer?: ArrayBuffer[] }, runs = 5) {
  const times: number[] = [];
  let longest = 0;
  for (let i = 0; i < runs; i++) {
    const { payload, transfer } = make();
    let last = performance.now();
    let beating = true;
    const beat = () => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      if (beating) setImmediate(beat);
    };
    setImmediate(beat);
    times.push(await roundTrip(payload, transfer));
    beating = false;
  }
  times.sort((a, b) => a - b);
  return { name, roundTripMsMedian: Math.round(times[Math.floor(times.length / 2)]! * 10) / 10, longestMainBlockMs: Math.round(longest * 10) / 10 };
}

const n = SIDE * SIDE;
const source = new Int32Array(n).fill(7);
const out = [
  await measure('copy (structured clone)', () => ({ payload: source })),
  await measure('transfer (after the copy the scheduler needs)', () => {
    const t0 = performance.now();
    const copy = source.slice();
    const copyMs = performance.now() - t0;
    void copyMs;
    return { payload: copy.buffer, transfer: [copy.buffer] };
  }),
  await measure('shared memory (no copy)', () => {
    const shared = new Int32Array(new SharedArrayBuffer(n * 4));
    return { payload: shared };
  }),
];
const t0 = performance.now();
source.slice();
console.log(JSON.stringify({ side: SIDE, mib: Math.round((n * 4) / 1048576), sliceCopyMs: Math.round((performance.now() - t0) * 10) / 10, results: out }, null, 2));
await worker.terminate();
