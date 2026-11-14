/**
 * Phase 1B.5 study: an optional on-disk cache of a strategy's full order
 * (no WorkPlanner yet). For center-out and random (PCG32, version 1, kept
 * unchanged) on 2000² and 4096² images:
 * - build: full order from the strategy (the cost a cache avoids);
 * - write: header (JSON key) + Uint32Array payload, temp file, fsync, rename;
 * - read + verify before use: key equality, SHA-256 of the payload, and a
 *   permutation check (every index paintable, inside the image, once);
 * - resume: a cursor position is just an offset into the order;
 * - memory: the order itself, 4 bytes per paintable pixel.
 *
 *   npm run bench:order-cache
 *
 * Cache key: SHA-256 of the canonical quantized pixels (quantizedImageHash
 * of the template revision), strategy id and version, seed, colorOrder. The
 * order does not depend on the placement (Phase 1B.3 filter property), so
 * the placement is NOT part of the key.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { open, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DrawingStrategyId, StrategyConfig, TemplateImage } from '@geoplacer/core';
import { DRAWING_STRATEGIES, TRANSPARENT_U32, serializeQuantized } from '@geoplacer/core';

const COLORS = Array.from({ length: 32 }, (_, i) => ((i * 2654435761) >>> 8) & 0xffffff);
const MAGIC = 'GPORDER1';

function makeImage(size: number): TemplateImage {
  const pixels = new Uint32Array(size * size);
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      const block = ((ix >> 4) * 31 + (iy >> 4) * 17) % 33;
      pixels[iy * size + ix] = block === 32 ? TRANSPARENT_U32 : (COLORS[block] ?? 0);
    }
  }
  return { width: size, height: size, pixels };
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

interface CacheKey {
  readonly imageHash: string;
  readonly strategy: DrawingStrategyId;
  readonly version: number;
  readonly seed: number | null;
  readonly colorOrder: readonly number[] | null;
}

async function writeCache(file: string, key: CacheKey, order: Uint32Array): Promise<void> {
  const payload = new Uint8Array(order.buffer, order.byteOffset, order.byteLength);
  const header = Buffer.from(`${MAGIC}${JSON.stringify({ key, length: order.length, sha256: sha256(payload) })}\n`);
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx');
  try {
    await handle.write(header);
    await handle.write(payload);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
}

/** Returns the verified order, or the reason it cannot be used. */
async function readCache(file: string, expected: CacheKey, image: TemplateImage): Promise<{ order: Uint32Array } | { rejected: string }> {
  const bytes = await readFile(file);
  const newline = bytes.indexOf(10);
  if (newline < 0 || bytes.subarray(0, MAGIC.length).toString() !== MAGIC) return { rejected: 'not a cache file' };
  const header = JSON.parse(bytes.subarray(MAGIC.length, newline).toString()) as { key: CacheKey; length: number; sha256: string };
  if (JSON.stringify(header.key) !== JSON.stringify(expected)) return { rejected: 'key mismatch (revision, strategy, version, seed or color order changed)' };
  const payload = bytes.subarray(newline + 1);
  if (payload.byteLength !== header.length * 4) return { rejected: 'truncated' };
  if (sha256(payload) !== header.sha256) return { rejected: 'checksum mismatch' };
  const order = new Uint32Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
  // Permutation of the paintable pixels: in range, paintable, each once, all present.
  const seen = new Uint8Array(image.pixels.length);
  for (let k = 0; k < order.length; k++) {
    const i = order[k]!;
    if (i >= image.pixels.length || image.pixels[i] === TRANSPARENT_U32 || seen[i] === 1) return { rejected: `not a permutation at position ${k}` };
    seen[i] = 1;
  }
  let paintable = 0;
  for (let i = 0; i < image.pixels.length; i++) if (image.pixels[i] !== TRANSPARENT_U32) paintable++;
  if (paintable !== order.length) return { rejected: 'missing pixels' };
  return { order };
}

const time = async <T>(fn: () => Promise<T> | T): Promise<[T, number]> => {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
};

const dir = mkdtempSync(path.join(tmpdir(), 'geoplacer-order-cache-'));
try {
  console.log(`Node ${process.version}, ${process.platform}/${process.arch}`);
  for (const size of [2000, 4096]) {
    const image = makeImage(size);
    const imageHash = sha256(serializeQuantized(image));
    for (const id of ['center-out', 'random'] as const) {
      const config: StrategyConfig = id === 'random' ? { id, seed: 42 } : { id };
      const strategy = DRAWING_STRATEGIES[id];
      const key: CacheKey = { imageHash, strategy: id, version: strategy.version, seed: config.seed ?? null, colorOrder: null };
      const file = path.join(dir, `${id}-${size}.order`);
      const [order, buildMs] = await time(() => strategy.order(image, config));
      const [, writeMs] = await time(() => writeCache(file, key, order));
      const [read, readVerifyMs] = await time(() => readCache(file, key, image));
      if (!('order' in read)) throw new Error(read.rejected);
      for (let k = 0; k < order.length; k++) if (read.order[k] !== order[k]) throw new Error('cache differs');
      // Resume at 99 %: the remaining order is a view, O(1).
      const [rest, resumeMs] = await time(() => read.order.subarray(Math.floor(order.length * 0.99)));
      // Invalidation: another seed or version is refused before any use.
      const other = await readCache(file, { ...key, seed: 43, version: strategy.version + 1 }, image);
      console.log(
        JSON.stringify({
          size: `${size}x${size}`,
          strategy: id,
          pixels: order.length,
          orderMiB: +(order.byteLength / 2 ** 20).toFixed(1),
          buildMs: Math.round(buildMs),
          writeMs: Math.round(writeMs),
          readVerifyMs: Math.round(readVerifyMs),
          resumeMs: +resumeMs.toFixed(3),
          remainingAt99: rest.length,
          otherKey: 'rejected' in other ? other.rejected : 'ACCEPTED (bug)',
        })
      );
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
