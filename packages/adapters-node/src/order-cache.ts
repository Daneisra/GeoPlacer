/**
 * File store of strategy orders (Phase 1B.6), under the locked data
 * directory: <root>/cache/orders/<projectId>/<templateId>/<strategy>-r<revision>-v<version>-s<seed>.order
 *
 * Written atomically (unique temp file, fsync, rename). Only a cache: the
 * core verifies every entry and rebuilds it when needed; deleting the
 * cache directory is always safe.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { OrderCacheKey, OrderCacheStore } from '@geoplacer/core';
import { isValidId } from '@geoplacer/core';
import type { DataDirectoryLock } from './lock.js';

export class FileOrderCacheStore implements OrderCacheStore {
  private readonly lock: DataDirectoryLock;

  constructor(lock: DataDirectoryLock) {
    lock.assertHeld();
    this.lock = lock;
  }

  private fileOf(key: OrderCacheKey): string {
    if (!isValidId(key.projectId) || !isValidId(key.templateId)) throw new Error('invalid project or template id');
    for (const n of [key.revision, key.strategyVersion, key.seed]) if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid cache key number');
    if (!/^[a-z-]{1,40}$/.test(key.strategy)) throw new Error('invalid strategy id');
    return path.join(this.lock.root, 'cache', 'orders', key.projectId, key.templateId, `${key.strategy}-r${key.revision}-v${key.strategyVersion}-s${key.seed}.order`);
  }

  async read(key: OrderCacheKey): Promise<Uint8Array | null> {
    try {
      const bytes = await readFile(this.fileOf(key));
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(key: OrderCacheKey, bytes: Uint8Array): Promise<void> {
    this.lock.assertHeld();
    const file = this.fileOf(key);
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx');
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}
