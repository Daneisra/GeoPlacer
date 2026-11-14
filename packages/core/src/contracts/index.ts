/**
 * Engine contracts (interfaces and constants only, no algorithms).
 *
 * Layering (imports only go downwards, no cycle):
 *   0 primitives, config
 *   1 geometry, palette, resources, accounts, ports
 *   2 template, canvas
 *   3 strategy, work, progress
 *   4 scheduler, upgrades
 */

export * from './primitives.js';
export * from './config.js';
export * from './geometry.js';
export * from './palette.js';
export * from './resources.js';
export * from './accounts.js';
export * from './ports.js';
export * from './template.js';
export * from './canvas.js';
export * from './strategy.js';
export * from './work.js';
export * from './progress.js';
export * from './scheduler.js';
export * from './upgrades.js';
