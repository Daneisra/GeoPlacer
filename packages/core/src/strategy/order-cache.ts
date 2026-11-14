/**
 * Random order cache (Phase 1B.6): the PCG32 V1 order of a revision, kept
 * across restarts, verified before every use, rebuilt when absent or
 * damaged. Never the source of truth.
 *
 * Format 1: "GPORDER1" + ASCII JSON header { key, length, sha256, endian }
 * + "\n" + payload (Uint32 order, little-endian). Verification: magic,
 * header, exact key, length, SHA-256 of the payload, then a permutation
 * check (every index in the image, paintable, exactly once).
 */

import type { Hasher, OrderCacheKey, OrderCacheStore, StrategyConfig, TemplateImage } from '../contracts/index.js';
import { TRANSPARENT_U32 } from '../contracts/index.js';
import { random } from './center-random.js';

const MAGIC = 'GPORDER1';
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

const ascii = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0x7f);
function fromAscii(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return text;
}
const canonical = (key: OrderCacheKey): string =>
  JSON.stringify([key.format, key.projectId, key.templateId, key.revision, key.strategy, key.strategyVersion, key.seed, key.quantizedImageHash]);

export interface CachedOrder {
  readonly order: Uint32Array;
  /** cache: verified entry; generated: rebuilt (no entry, or the reason in `problem`). */
  readonly source: 'cache' | 'generated';
  readonly problem: string | null;
}

/** Checks a cache entry; returns the order or the reason it cannot be used. */
async function verify(bytes: Uint8Array, key: OrderCacheKey, image: TemplateImage, hasher: Hasher): Promise<Uint32Array | string> {
  const newline = bytes.indexOf(10);
  if (newline < 0 || newline > 4096 || fromAscii(bytes.subarray(0, MAGIC.length)) !== MAGIC) return 'not an order cache entry';
  let header: { key?: unknown; length?: unknown; sha256?: unknown; endian?: unknown };
  try {
    header = JSON.parse(fromAscii(bytes.subarray(MAGIC.length, newline))) as typeof header;
  } catch {
    return 'unreadable header';
  }
  if (header.key !== canonical(key)) return 'key mismatch (revision, strategy, version, seed or image changed)';
  if (header.endian !== 'little' || !LITTLE_ENDIAN) return 'byte order not supported';
  const length = header.length;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return 'bad length';
  const payload = bytes.subarray(newline + 1);
  if (payload.byteLength !== length * 4) return 'truncated or oversized payload';
  if ((await hasher.sha256Hex(payload)) !== header.sha256) return 'checksum mismatch';
  const order = new Uint32Array(payload.slice().buffer);
  const { pixels } = image;
  const seen = new Uint8Array(pixels.length);
  let paintable = 0;
  for (let i = 0; i < pixels.length; i++) if (pixels[i] !== TRANSPARENT_U32) paintable++;
  if (order.length !== paintable) return 'not a permutation of the paintable pixels (count)';
  for (let k = 0; k < order.length; k++) {
    const i = order[k]!;
    if (i >= pixels.length || pixels[i] === TRANSPARENT_U32 || seen[i] === 1) return `not a permutation of the paintable pixels (position ${k})`;
    seen[i] = 1;
  }
  return order;
}

/** Serialized cache entry of an order (format 1). */
export async function encodeOrderCache(key: OrderCacheKey, order: Uint32Array, hasher: Hasher): Promise<Uint8Array> {
  const payload = new Uint8Array(order.buffer, order.byteOffset, order.byteLength);
  const header = ascii(`${MAGIC}${JSON.stringify({ key: canonical(key), length: order.length, sha256: await hasher.sha256Hex(payload), endian: 'little' })}\n`);
  const bytes = new Uint8Array(header.length + payload.length);
  bytes.set(header);
  bytes.set(payload, header.length);
  return bytes;
}

/**
 * The random order of a revision: from the cache when a verified entry
 * exists, otherwise generated and (best effort) written back. A cache
 * failure never makes the template unusable.
 */
export async function loadRandomOrder(
  image: TemplateImage,
  config: StrategyConfig,
  key: OrderCacheKey,
  deps: { readonly hasher: Hasher; readonly store?: OrderCacheStore }
): Promise<CachedOrder> {
  const problems: string[] = [];
  if (deps.store !== undefined) {
    try {
      const bytes = await deps.store.read(key);
      if (bytes !== null) {
        const checked = await verify(bytes, key, image, deps.hasher);
        if (typeof checked !== 'string') return { order: checked, source: 'cache', problem: null };
        problems.push(`cache rejected: ${checked}`);
      }
    } catch (error) {
      problems.push(`cache read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const order = random.order(image, config);
  if (deps.store !== undefined) {
    try {
      if (!LITTLE_ENDIAN) throw new Error('byte order not supported');
      await deps.store.write(key, await encodeOrderCache(key, order, deps.hasher));
    } catch (error) {
      problems.push(`cache write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { order, source: 'generated', problem: problems.length === 0 ? null : problems.join('; ') };
}
