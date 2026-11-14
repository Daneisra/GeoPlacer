import { describe, expect, it } from 'vitest';
import type { OrderCacheKey, OrderCacheStore } from '../src/index.js';
import { encodeOrderCache, loadRandomOrder, random } from '../src/index.js';
import { testHasher } from './helpers/ports.js';
import { image } from './helpers/strategy.js';

const img = image(40, 30, (x, y) => ((x * 3 + y) % 11 === 0 ? null : 1 + ((x + y) % 4)));
const config = { id: 'random' as const, seed: 77 };
const key: OrderCacheKey = { projectId: 'p', templateId: 't', revision: 3, strategy: 'random', strategyVersion: 1, seed: 77, quantizedImageHash: 'a'.repeat(64), format: 1 };
const expected = [...random.order(img, config)];

function memoryStore(initial?: Uint8Array): OrderCacheStore & { saved: Map<string, Uint8Array>; writes: number } {
  const saved = new Map<string, Uint8Array>();
  if (initial !== undefined) saved.set(JSON.stringify(key), initial);
  const store = {
    saved,
    writes: 0,
    async read(k: OrderCacheKey) {
      return saved.get(JSON.stringify(k)) ?? null;
    },
    async write(k: OrderCacheKey, bytes: Uint8Array) {
      store.writes++;
      saved.set(JSON.stringify(k), bytes.slice());
    },
  };
  return store;
}

describe('random order cache', () => {
  it('generates and writes the order when absent, then serves the verified entry', async () => {
    const store = memoryStore();
    const first = await loadRandomOrder(img, config, key, { hasher: testHasher, store });
    expect(first).toMatchObject({ source: 'generated', problem: null });
    expect([...first.order]).toEqual(expected);
    expect(store.writes).toBe(1);
    const second = await loadRandomOrder(img, config, key, { hasher: testHasher, store });
    expect(second.source).toBe('cache');
    expect([...second.order]).toEqual(expected);
  });

  it('rebuilds the same order from any damaged, mismatching or unusable entry, and says why', async () => {
    const good = await encodeOrderCache(key, random.order(img, config), testHasher);
    const header = good.indexOf(10) + 1;
    const flipped = good.slice();
    flipped[header + 5]! ^= 1; // payload byte: checksum mismatch
    const otherSeed = await encodeOrderCache({ ...key, seed: 78 }, random.order(img, { id: 'random', seed: 78 }), testHasher);
    const otherRevision = await encodeOrderCache({ ...key, revision: 2 }, random.order(img, config), testHasher);
    // A well-formed entry whose content is not a permutation (two indexes swapped for a duplicate).
    const bogusOrder = random.order(img, config);
    bogusOrder[1] = bogusOrder[0]!;
    const notPermutation = await encodeOrderCache(key, bogusOrder, testHasher);
    const cases: Array<[string, Uint8Array, RegExp]> = [
      ['truncated', good.subarray(0, good.length - 7), /truncated/],
      ['empty', new Uint8Array(0), /not an order cache entry/],
      ['garbage', Uint8Array.from([1, 2, 3, 10, 4]), /not an order cache entry/],
      ['bad hash', flipped, /checksum mismatch/],
      ['other seed', otherSeed, /key mismatch/],
      ['other revision', otherRevision, /key mismatch/],
      ['not a permutation', notPermutation, /not a permutation/],
    ];
    for (const [label, bytes, reason] of cases) {
      const store = memoryStore(bytes);
      const result = await loadRandomOrder(img, config, key, { hasher: testHasher, store });
      expect(result.source, label).toBe('generated');
      expect([...result.order], label).toEqual(expected);
      expect(result.problem, label).toMatch(reason);
      expect((await loadRandomOrder(img, config, key, { hasher: testHasher, store })).source, `${label}: rewritten`).toBe('cache');
    }
  });

  it('works without a store and survives failing reads and writes', async () => {
    expect([...(await loadRandomOrder(img, config, key, { hasher: testHasher })).order]).toEqual(expected);
    const broken: OrderCacheStore = {
      read: async () => {
        throw new Error('disk unavailable');
      },
      write: async () => {
        throw new Error('disk full');
      },
    };
    const result = await loadRandomOrder(img, config, key, { hasher: testHasher, store: broken });
    expect([...result.order]).toEqual(expected);
    expect(result.problem).toMatch(/cache read failed: disk unavailable; cache write failed: disk full/);
  });
});
