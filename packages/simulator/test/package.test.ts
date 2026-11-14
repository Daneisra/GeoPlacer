import { describe, expect, it } from 'vitest';
import { CORE_CONTRACT_VERSION } from '@geoplacer/core';
import { SIMULATOR_TARGET_CORE_CONTRACT } from '../src/index.js';

describe('@geoplacer/simulator package', () => {
  it('resolves @geoplacer/core and targets its current contract', () => {
    expect(SIMULATOR_TARGET_CORE_CONTRACT).toBe(CORE_CONTRACT_VERSION);
  });
});
