import { describe, expect, it } from 'vitest';
import { CORE_CONTRACT_VERSION } from '../src/index.js';

describe('@geoplacer/core package', () => {
  it('exposes the contract version', () => {
    expect(CORE_CONTRACT_VERSION).toBe(4);
  });
});
