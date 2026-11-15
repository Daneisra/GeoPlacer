/**
 * @geoplacer/simulator — public entry point.
 *
 * Phase 1B.7: a local simulated canvas provider (reader and writer behind
 * the core contracts, energy from the core rules, deterministic faults,
 * external actors) and a virtual clock. Multi-agent runs are limited to
 * this simulator; the V1 production configuration allows a single active
 * agent. Nothing here talks to a real service.
 */

import { CORE_CONTRACT_VERSION } from '@geoplacer/core';

/** Core contract version this simulator is written against. */
export const SIMULATOR_TARGET_CORE_CONTRACT = CORE_CONTRACT_VERSION;

export { createManualClock, type ManualClock } from './clock.js';
export { SimulatedCanvasError, SimulatedCanvasProvider, type CanvasEvent, type SimulatedAgent, type SimulatedCanvasOptions, type SimulatedFault, type WorldCommit, type WorldPixel, type WorldView } from './canvas.js';
