/**
 * @geoplacer/core — public entry point.
 *
 * Contracts (src/contracts), pure business logic (src/<domain>), no I/O.
 */

/** Version of the core contracts; bumped on breaking interface changes. */
export const CORE_CONTRACT_VERSION = 4 as const;

export * from './contracts/index.js';
export * from './geometry/index.js';
export * from './color/index.js';
export * from './palette/index.js';
export * from './template/index.js';
export * from './strategy/index.js';
export * from './canvas/index.js';
export * from './progress/index.js';
