import { describe, expect, expectTypeOf, it } from 'vitest';
import { CORE_CONTRACT_VERSION, DEFAULT_MAX_ACTIVE_AGENTS } from '@geoplacer/core';
import type { ReadWriteCanvasProvider } from '@geoplacer/core';
import { SIMULATOR_TARGET_CORE_CONTRACT } from '../src/index.js';

describe('@geoplacer/simulator package', () => {
  it('resolves @geoplacer/core and targets its current contract', () => {
    expect(SIMULATOR_TARGET_CORE_CONTRACT).toBe(CORE_CONTRACT_VERSION);
  });

  it('sees the core contracts the future SimulatedCanvasProvider will implement', () => {
    // The simulator will be the read-write provider of V1 tests (Phase 1B.7).
    expectTypeOf<ReadWriteCanvasProvider['mode']>().toEqualTypeOf<'read-write'>();
    // Multi-agent runs are simulator-only; production V1 stays at one agent.
    expect(DEFAULT_MAX_ACTIVE_AGENTS).toBe(1);
  });
});
