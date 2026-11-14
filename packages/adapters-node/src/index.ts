/**
 * @geoplacer/adapters-node: Node.js implementations of the core ports.
 * Depends on @geoplacer/core only (plus pngjs); the core never imports it.
 */

import { createTemplateManager, type TemplateLimits, type TemplateManager } from '@geoplacer/core';
import { nodeSha256Hasher } from './hasher.js';
import { acquireDataDirectoryLock, type DataDirectoryLock, type LockMechanism } from './lock.js';
import { pngjsCodec } from './png-codec.js';
import { NodeTemplateStorage } from './storage.js';
import { randomIdSource, systemClock } from './system.js';

export { nodeSha256Hasher } from './hasher.js';
export {
  DataDirectoryLockedError,
  acquireDataDirectoryLock,
  type DataDirectoryLock,
  type LockMechanism,
  type LockOptions,
  type LockOwner,
} from './lock.js';
export { pngjsCodec } from './png-codec.js';
export { NodeTemplateStorage, type NodeTemplateStorageOptions } from './storage.js';
export { randomIdSource, systemClock } from './system.js';

export interface NodeTemplateManagerHandle {
  readonly manager: TemplateManager;
  readonly lock: DataDirectoryLock;
  /** Releases the data directory; later writes are refused. */
  close(): Promise<void>;
}

/**
 * TemplateManager persisted under `root` with the Node adapters. Takes the
 * data directory lock first: a second instance on the same directory fails
 * with DataDirectoryLockedError.
 */
export async function openNodeTemplateManager(
  root: string,
  options: { readonly limits?: TemplateLimits; readonly lockMechanism?: LockMechanism } = {}
): Promise<NodeTemplateManagerHandle> {
  const lock = await acquireDataDirectoryLock(root, options.lockMechanism === undefined ? {} : { mechanism: options.lockMechanism });
  const manager = createTemplateManager({
    storage: new NodeTemplateStorage(lock),
    hasher: nodeSha256Hasher,
    codec: pngjsCodec,
    ids: randomIdSource,
    clock: systemClock,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return { manager, lock, close: () => lock.release() };
}
