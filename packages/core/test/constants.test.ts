import { describe, expect, it } from 'vitest';
import {
  CORE_CONTRACT_VERSION,
  DEFAULT_MAX_ACTIVE_AGENTS,
  TEMPLATE_MANIFEST_SCHEMA_VERSION,
  TRANSPARENT,
  TRANSPARENT_U32,
  UNKNOWN,
} from '../src/index.js';

describe('core constants', () => {
  it('limits V1 production to a single active agent', () => {
    expect(DEFAULT_MAX_ACTIVE_AGENTS).toBe(1);
  });

  it('uses sentinels that cannot collide with a 24-bit color', () => {
    expect(TRANSPARENT).toBe(-1);
    expect(UNKNOWN).toBe(-2);
    expect(TRANSPARENT).not.toBe(UNKNOWN);
    expect(TRANSPARENT_U32).toBe(0xffffffff);
    expect(TRANSPARENT_U32).toBeGreaterThan(0xffffff);
    // The storage sentinel fits in a Uint32Array cell unchanged.
    expect(new Uint32Array([TRANSPARENT_U32])[0]).toBe(TRANSPARENT_U32);
  });

  it('versions the template manifest schema and the contracts', () => {
    expect(TEMPLATE_MANIFEST_SCHEMA_VERSION).toBe(1);
    // Contract v2 (Phase 1B.2): asynchronous TemplateManager, manifest with revision records.
    expect(CORE_CONTRACT_VERSION).toBe(3);
  });
});
