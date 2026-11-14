/**
 * @geoplacer/adapters-node: Node.js implementations of the core ports.
 * Depends on @geoplacer/core only (plus pngjs); the core never imports it.
 */

import { createTemplateManager, type TemplateLimits, type TemplateManager } from '@geoplacer/core';
import { nodeSha256Hasher } from './hasher.js';
import { pngjsCodec } from './png-codec.js';
import { NodeTemplateStorage } from './storage.js';
import { randomIdSource, systemClock } from './system.js';

export { nodeSha256Hasher } from './hasher.js';
export { pngjsCodec } from './png-codec.js';
export { NodeTemplateStorage, type NodeTemplateStorageOptions } from './storage.js';
export { randomIdSource, systemClock } from './system.js';

/** TemplateManager persisted under `root` with the Node adapters. */
export function createNodeTemplateManager(root: string, options: { readonly limits?: TemplateLimits } = {}): TemplateManager {
  return createTemplateManager({
    storage: new NodeTemplateStorage(root),
    hasher: nodeSha256Hasher,
    codec: pngjsCodec,
    ids: randomIdSource,
    clock: systemClock,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
}
