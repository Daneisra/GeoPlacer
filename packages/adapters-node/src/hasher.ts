import { createHash } from 'node:crypto';
import type { Hasher } from '@geoplacer/core';

/** SHA-256 (lower-case hex) via node:crypto. */
export const nodeSha256Hasher: Hasher = {
  async sha256Hex(bytes: Uint8Array): Promise<string> {
    return createHash('sha256').update(bytes).digest('hex');
  },
};
