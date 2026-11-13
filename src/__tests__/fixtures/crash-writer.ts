/**
 * Test fixture (not a test): rewrites a JSON file forever with alternating
 * large payloads so the parent test can kill it at a random moment.
 * Usage: node --import tsx crash-writer.ts <file>
 */

import { writeJsonAtomic } from '../../utils/json-store.js';

const file = process.argv[2];
if (!file) throw new Error('missing file argument');

const payloadA = { version: 'A', rows: Array.from({ length: 400 }, (_, i) => Array(200).fill(i % 64)) };
const payloadB = { version: 'B', rows: Array.from({ length: 400 }, (_, i) => Array(200).fill((i + 7) % 64)) };

writeJsonAtomic(file, payloadA);
process.stdout.write('ready\n');

let flip = false;
for (;;) {
  writeJsonAtomic(file, flip ? payloadA : payloadB);
  flip = !flip;
}
