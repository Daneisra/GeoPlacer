import { describe, expect, it } from 'vitest';
import type { RevisionRecordV1, TemplateManifest } from '../src/index.js';
import {
  TemplateError,
  asProjectId,
  asTemplateId,
  diffRevision,
  manifestGeneration,
  parseManifest,
  rgb,
  serializeManifest,
  validateExtensions,
  validateStrategyConfig,
} from '../src/index.js';

const H = (c: string): string => c.repeat(64);

function revision(n: number, extra: Partial<RevisionRecordV1> = {}): RevisionRecordV1 {
  return {
    revision: n,
    createdAt: 1000 + n,
    reasons: n === 1 ? ['created'] : ['placement'],
    basedOn: n === 1 ? null : n - 1,
    width: 2,
    height: 1,
    placement: { topLeft: { x: 10, y: -5 } },
    coordinateSystem: { yAxis: 'down' },
    palette: { id: 'p', colors: [{ rgb: rgb(0, 0, 0), name: 'Noir' }, { rgb: rgb(255, 255, 255), unlockCost: 0 }] },
    alphaThreshold: 128,
    quantizationMethod: { algorithm: 'nearest-color', distance: 'oklab', version: 1 },
    sourceImageHash: H('a'),
    quantizedImageHash: H('b'),
    quantizedFileHash: H('c'),
    stats: { pixels: 2, transparent: 1, exact: 1, approximated: 0 },
    extensions: {},
    ...extra,
  };
}

function manifest(extra: Partial<TemplateManifest> = {}): TemplateManifest {
  return {
    schemaVersion: 1,
    projectId: asProjectId('projet-a'),
    templateId: asTemplateId('modele-1'),
    generation: 2,
    name: 'Mon modèle',
    drawingStrategy: { id: 'random', seed: 42 },
    priority: 0,
    status: 'active',
    createdAt: 1001,
    updatedAt: 1002,
    deletedAt: null,
    currentRevision: 2,
    revisions: [revision(1), revision(2, { placement: { topLeft: { x: 11, y: -5 } } })],
    extensions: {},
    ...extra,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateError);
    expect((error as TemplateError).code).toBe(code);
    return;
  }
  throw new Error(`expected TemplateError ${code}`);
}

// Raw JSON edited freely to build malformed manifests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

function mutate(edit: (m: Raw) => void): string {
  const raw = JSON.parse(serializeManifest(manifest())) as Raw;
  edit(raw);
  return JSON.stringify(raw);
}

describe('template manifest v1', () => {
  it('round-trips with a stable serialization', () => {
    const json = serializeManifest(manifest());
    expect(parseManifest(json)).toEqual(manifest());
    expect(serializeManifest(parseManifest(json))).toBe(json);
    expect(json.endsWith('\n')).toBe(true);
    expect(Object.keys(JSON.parse(json) as object)[0]).toBe('schemaVersion');
  });

  it('serializes independently of the key order of the input objects', () => {
    const shuffled = { ...manifest() };
    const reordered = Object.fromEntries(Object.entries(shuffled).reverse()) as unknown as TemplateManifest;
    expect(serializeManifest(reordered)).toBe(serializeManifest(manifest()));
  });

  it('preserves extensions verbatim (forward-compatible data, manifest and revisions)', () => {
    const json = serializeManifest(
      manifest({ extensions: { 'futur.champ': { a: [1, 2] }, note: 'x' }, revisions: [revision(1, { extensions: { ajout: true } }), revision(2)] })
    );
    expect(parseManifest(json).extensions).toEqual({ 'futur.champ': { a: [1, 2] }, note: 'x' });
    expect(parseManifest(json).revisions[0]?.extensions).toEqual({ ajout: true });
  });

  it('accepts extensions at the limits (depth 8, 64 entries, 10 000-character strings)', () => {
    const deep = JSON.parse('['.repeat(8) + ']'.repeat(8)) as unknown;
    const many = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, i]));
    for (const extensions of [{ futur: deep }, many, { 'a.b_c-d': 'x'.repeat(10_000), n: null, b: false, f: -1.5 }]) {
      expect(parseManifest(serializeManifest(manifest({ extensions }))).extensions).toEqual(extensions);
    }
    expect(validateExtensions({ ok: { nested: [1, 'deux', { trois: null }] } })).toEqual({ ok: { nested: [1, 'deux', { trois: null }] } });
    expectCode(() => validateExtensions(Object.create(null) as unknown), 'INVALID_MANIFEST');
    expectCode(() => validateExtensions({ futur: new Date(0) }), 'INVALID_MANIFEST');
    expectCode(() => validateExtensions({ futur: Number.NaN }), 'INVALID_MANIFEST');
  });

  it('validates strategy settings: unsigned 32-bit seed, distinct colorOrder', () => {
    expect(validateStrategyConfig({ id: 'random', seed: 0xffffffff })).toEqual({ id: 'random', seed: 0xffffffff });
    expect(validateStrategyConfig({ id: 'color-by-color', colorOrder: [3, 1, 2] })).toEqual({ id: 'color-by-color', colorOrder: [3, 1, 2] });
    expectCode(() => validateStrategyConfig({ id: 'random', seed: 2 ** 32 }), 'INVALID_MANIFEST');
  });

  it('rejects newer schemas explicitly', () => {
    expectCode(() => parseManifest(mutate((m) => (m.schemaVersion = 2))), 'UNSUPPORTED_SCHEMA');
  });

  it('rejects malformed manifests', () => {
    const cases: Array<[string, (m: Raw) => void]> = [
      ['schema 0', (m) => (m.schemaVersion = 0)],
      ['schema string', (m) => (m.schemaVersion = '1')],
      ['unknown field', (m) => (m.surprise = true)],
      ['unknown revision field', (m) => (m.revisions[0].surprise = true)],
      ['missing name', (m) => delete m.name],
      ['empty name', (m) => (m.name = '')],
      ['bad project id', (m) => (m.projectId = '../x')],
      ['bad template id', (m) => (m.templateId = 'A')],
      ['generation 0', (m) => (m.generation = 0)],
      ['bad status', (m) => (m.status = 'running')],
      ['bad strategy', (m) => (m.drawingStrategy = { id: 'spiral' })],
      ['current revision missing', (m) => (m.currentRevision = 3)],
      ['empty revisions', (m) => (m.revisions = [])],
      ['non contiguous revisions', (m) => (m.revisions[1].revision = 3)],
      ['basedOn in the future', (m) => (m.revisions[1].basedOn = 2)],
      ['bad hash', (m) => (m.revisions[0].sourceImageHash = 'ABC')],
      ['upper-case hash', (m) => (m.revisions[0].quantizedFileHash = 'A'.repeat(64))],
      ['stats mismatch', (m) => (m.revisions[0].stats.exact = 5)],
      ['pixels mismatch', (m) => (m.revisions[0].width = 3)],
      ['fractional coordinate', (m) => (m.revisions[0].placement.topLeft.x = 1.5)],
      ['bad y axis', (m) => (m.revisions[0].coordinateSystem.yAxis = 'left')],
      ['bad palette color', (m) => (m.revisions[0].palette.colors[0].rgb = 0x1000000)],
      ['empty palette', (m) => (m.revisions[0].palette.colors = [])],
      ['alpha threshold > 256', (m) => (m.revisions[0].alphaThreshold = 300)],
      ['bad reason', (m) => (m.revisions[0].reasons = ['whatever'])],
      ['extensions not an object', (m) => (m.extensions = [])],
      ['revision extensions missing', (m) => delete m.revisions[0].extensions],
      ['quantization version 2', (m) => (m.revisions[0].quantizationMethod.version = 2)],
      ['negative seed', (m) => (m.drawingStrategy = { id: 'random', seed: -1 })],
      ['seed above 32 bits', (m) => (m.drawingStrategy = { id: 'random', seed: 2 ** 32 })],
      ['fractional seed', (m) => (m.drawingStrategy = { id: 'random', seed: 1.5 })],
      ['duplicate colorOrder', (m) => (m.drawingStrategy = { id: 'color-by-color', colorOrder: [1, 2, 1] })],
      ['extension name with a space', (m) => (m.extensions = { 'a b': 1 })],
      ['extension name starting with a digit', (m) => (m.extensions = { '1x': 1 })],
      ['extension name too long', (m) => (m.extensions = { ['x'.repeat(65)]: 1 })],
      ['nested __proto__ key', (m) => (m.extensions = JSON.parse('{"futur":{"__proto__":{"admin":true}}}'))],
      ['top-level constructor key', (m) => (m.revisions[0].extensions = { constructor: 1 })],
      ['extensions too deep', (m) => (m.extensions = { futur: JSON.parse('['.repeat(9) + ']'.repeat(9)) })],
      ['extensions too large', (m) => (m.extensions = { futur: 'é'.repeat(9000).repeat(4).slice(0, 10_000), autre: 'é'.repeat(10_000), troisieme: 'é'.repeat(10_000), quatrieme: 'é'.repeat(10_000) })],
      ['extension string too long', (m) => (m.extensions = { futur: 'x'.repeat(10_001) })],
      ['too many extensions', (m) => (m.extensions = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i])))],
    ];
    for (const [label, edit] of cases) {
      try {
        parseManifest(mutate(edit));
      } catch (error) {
        expect((error as TemplateError).code, label).toBe('INVALID_MANIFEST');
        continue;
      }
      throw new Error(`accepted a malformed manifest: ${label}`);
    }
    expectCode(() => parseManifest('{"schemaVersion":1,'), 'INVALID_MANIFEST');
    expectCode(() => parseManifest('[]'), 'INVALID_MANIFEST');
    expectCode(() => parseManifest('null'), 'INVALID_MANIFEST');
  });

  it('reads the generation of a stored manifest for compare-and-swap', () => {
    expect(manifestGeneration(serializeManifest(manifest()))).toBe(2);
    expect(manifestGeneration(null)).toBeNull();
    expect(manifestGeneration('garbage')).toBeNull();
  });
});

describe('revision rules', () => {
  const current = revision(1);

  it('treats an identical change as a no-op', () => {
    expect(diffRevision(current, {})).toEqual({ reasons: [], requantize: false });
    expect(
      diffRevision(current, {
        placement: { topLeft: { x: 10, y: -5 } },
        coordinateSystem: { yAxis: 'down' },
        alphaThreshold: 128,
        quantization: { algorithm: 'nearest-color', distance: 'oklab', version: 1 },
        palette: current.palette,
        sourcePng: new Uint8Array(1),
      }, H('a')),
    ).toEqual({ reasons: [], requantize: false });
  });

  it('creates a placement / coordinate-system revision without re-quantizing', () => {
    expect(diffRevision(current, { placement: { topLeft: { x: 0, y: 0 } } })).toEqual({ reasons: ['placement'], requantize: false });
    expect(diffRevision(current, { coordinateSystem: { yAxis: 'up' } })).toEqual({ reasons: ['coordinate-system'], requantize: false });
  });

  it('re-quantizes for source, alpha threshold, quantization and palette colors', () => {
    expect(diffRevision(current, { sourcePng: new Uint8Array(1) }, H('d'))).toEqual({ reasons: ['source-image'], requantize: true });
    expect(diffRevision(current, { alphaThreshold: 1 })).toEqual({ reasons: ['alpha-threshold'], requantize: true });
    expect(diffRevision(current, { quantization: { algorithm: 'nearest-color', distance: 'rgb-euclidean', version: 1 } })).toEqual({
      reasons: ['quantization'],
      requantize: true,
    });
    const reversed = { id: 'p', colors: [...current.palette.colors].reverse() };
    expect(diffRevision(current, { palette: reversed })).toEqual({ reasons: ['palette'], requantize: true });
  });

  it('records a palette revision for names/costs only, reusing the quantized pixels', () => {
    const renamed = { id: 'p', colors: [{ rgb: rgb(0, 0, 0), name: 'Black' }, { rgb: rgb(255, 255, 255), unlockCost: 0 }] };
    expect(diffRevision(current, { palette: renamed })).toEqual({ reasons: ['palette'], requantize: false });
  });

  it('accumulates several reasons in a stable order', () => {
    expect(diffRevision(current, { placement: { topLeft: { x: 1, y: 1 } }, alphaThreshold: 200 }).reasons).toEqual(['alpha-threshold', 'placement']);
  });
});
