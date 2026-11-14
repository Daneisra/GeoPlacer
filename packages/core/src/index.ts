/**
 * @geoplacer/core — public entry point.
 *
 * Phase 1B.0: contracts only (src/contracts). Business logic (src/<domain>)
 * and implementations arrive in later phases, behind these interfaces.
 */

/** Version of the core contracts; bumped on breaking interface changes. */
export const CORE_CONTRACT_VERSION = 1 as const;

export * from './contracts/index.js';
export * from './geometry/index.js';
