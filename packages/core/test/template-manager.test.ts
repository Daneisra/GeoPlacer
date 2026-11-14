import { describe, expect, it, vi } from 'vitest';
import type { Palette, PngCodec, ProjectId, TemplateManager, TemplateRef, TemplateStorage } from '../src/index.js';
import {
  GeometryError,
  StorageConflictError,
  TRANSPARENT_U32,
  TemplateError,
  asProjectId,
  createMemoryTemplateStorage,
  createTemplateManager,
  rgb,
  serializeManifest,
  type MemoryTemplateStorage,
  type TemplateLimits,
} from '../src/index.js';
import { rgbaPng } from './helpers/png.js';
import { manualClock, sequentialIds, testCodec, testHasher } from './helpers/ports.js';

const P1 = asProjectId('projet-a');
const P2 = asProjectId('projet-b');
const BLACK = rgb(0, 0, 0);
const WHITE = rgb(255, 255, 255);
const RED = rgb(255, 0, 0);
const palette: Palette = { id: 'base', colors: [{ rgb: BLACK, name: 'Noir' }, { rgb: WHITE, name: 'Blanc' }, { rgb: RED, name: 'Rouge' }] };
const down = { yAxis: 'down' } as const;
const at = (x: number, y: number) => ({ topLeft: { x, y } });

/** 4x2: red-ish, transparent (alpha 127), white (alpha 128), black / 4 near-black. */
const sourcePng = rgbaPng(4, 2, (x, y) => {
  if (y === 1) return [10, 10, 10, 255];
  return ([[250, 10, 10, 255], [255, 255, 255, 127], [255, 255, 255, 128], [0, 0, 0, 255]] as const)[x] ?? [0, 0, 0, 0];
});

interface Setup {
  readonly storage: MemoryTemplateStorage;
  readonly manager: TemplateManager;
  readonly clock: ReturnType<typeof manualClock>;
  readonly reopen: (storage?: TemplateStorage, codec?: PngCodec) => TemplateManager;
}

function setup(options: { limits?: TemplateLimits; codec?: PngCodec } = {}): Setup {
  const storage = createMemoryTemplateStorage();
  const clock = manualClock();
  const ids = sequentialIds();
  const make = (s: TemplateStorage = storage, codec: PngCodec = options.codec ?? testCodec): TemplateManager =>
    createTemplateManager({ storage: s, hasher: testHasher, codec, ids, clock, ...(options.limits ? { limits: options.limits } : {}) });
  return { storage, manager: make(), clock, reopen: make };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error, `expected ${code}`).toBeInstanceOf(TemplateError);
  expect((error as TemplateError).code).toBe(code);
}

async function create(s: Setup, extra: Partial<Parameters<TemplateManager['create']>[0]> = {}) {
  return s.manager.create({ projectId: P1, name: 'Fresque', sourcePng, palette, placement: at(100, 200), coordinateSystem: down, ...extra });
}

const refOf = (t: { projectId: ProjectId; id: TemplateRef['templateId'] }): TemplateRef => ({ projectId: t.projectId, templateId: t.id });

describe('TemplateManager: creation and import', () => {
  it('creates revision 1 with persisted, verifiable metadata', async () => {
    const s = setup();
    const t = await create(s);
    expect(t).toMatchObject({ id: 'modele-1', projectId: P1, name: 'Fresque', revision: 1, alphaThreshold: 128, status: 'active', priority: 0 });
    expect(t.quantization).toEqual({ algorithm: 'nearest-color', distance: 'oklab', version: 1 });
    expect(t.strategy).toEqual({ id: 'top-to-bottom' });
    expect([...t.image.pixels]).toEqual([RED, TRANSPARENT_U32, WHITE, BLACK, BLACK, BLACK, BLACK, BLACK]);
    expect(t.sourceImageHash).toMatch(/^[0-9a-f]{64}$/);

    const m = await s.manager.manifest(refOf(t));
    expect(m).toMatchObject({ schemaVersion: 1, generation: 1, currentRevision: 1, deletedAt: null, extensions: {} });
    expect(m.revisions[0]).toMatchObject({ revision: 1, reasons: ['created'], basedOn: null, width: 4, height: 2, alphaThreshold: 128 });
    expect(m.revisions[0]?.stats).toEqual({ pixels: 8, transparent: 1, exact: 2, approximated: 5 });
    // Exactly three objects: manifest, source blob, quantized blob.
    expect(s.storage.state.blobs.size).toBe(2);
    expect((await s.manager.verify(refOf(t))).revisions).toEqual([{ revision: 1, ok: true, problems: [] }]);
  });

  it('applies the alpha threshold (alpha < threshold is transparent) and keeps black opaque', async () => {
    const s = setup();
    const t = await create(s, { alphaThreshold: 129 });
    expect([...t.image.pixels].slice(0, 4)).toEqual([RED, TRANSPARENT_U32, TRANSPARENT_U32, BLACK]);
  });

  it('accepts a fully transparent image (0 paintable pixels) and a fully opaque one', async () => {
    const s = setup();
    const clear = await create(s, { sourcePng: rgbaPng(3, 3, () => [0, 0, 0, 0]) });
    expect([...clear.image.pixels].every((p) => p === TRANSPARENT_U32)).toBe(true);
    const opaque = await create(s, { sourcePng: rgbaPng(2, 2, () => [0, 0, 0, 255]) });
    expect([...opaque.image.pixels]).toEqual([BLACK, BLACK, BLACK, BLACK]);
    const list = (await s.manager.list(P1)).templates;
    expect(list.map((x) => [x.templateId, x.paintablePixels])).toEqual([
      ['modele-1', 0],
      ['modele-2', 4],
    ]);
  });

  it('is deterministic: same input, same hashes', async () => {
    const s = setup();
    const a = await create(s);
    const b = await create(s);
    expect(b.quantizedImageHash).toBe(a.quantizedImageHash);
    expect(s.storage.state.blobs.size).toBe(2); // content-addressed: shared blobs
  });

  it('rejects invalid and corrupt PNG files', async () => {
    const s = setup();
    await expectCode(create(s, { sourcePng: new TextEncoder().encode('not a png at all, really not') }), 'INVALID_PNG');
    const corrupt = sourcePng.slice();
    corrupt[corrupt.length - 20] = (corrupt[corrupt.length - 20] ?? 0) ^ 0xff; // inside IDAT
    await expectCode(create(s, { sourcePng: corrupt }), 'INVALID_PNG');
    expect(s.storage.state.manifests.size).toBe(0);
  });

  it('rejects excessive dimensions before decoding anything', async () => {
    const decode = vi.fn(testCodec.decode);
    const s = setup({ limits: { maxWidth: 3, maxHeight: 3, maxPixels: 9 }, codec: { ...testCodec, decode } });
    await expectCode(create(s), 'IMAGE_TOO_LARGE');
    expect(decode).not.toHaveBeenCalled();
    expect(s.storage.state.blobs.size).toBe(0);
  });

  it('detects a decoder that disagrees with the PNG header', async () => {
    const s = setup({ codec: { ...testCodec, decode: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) }) } });
    await expectCode(create(s), 'DECODE_MISMATCH');
  });

  it('validates inputs explicitly', async () => {
    const s = setup();
    await expectCode(create(s, { name: '  ' }), 'INVALID_NAME');
    await expectCode(create(s, { projectId: 'Projet' as ProjectId }), 'INVALID_ID');
    await expectCode(create(s, { alphaThreshold: 1.5 }), 'INVALID_INPUT');
    await expectCode(create(s, { quantization: { algorithm: 'nearest-color', distance: 'nope', version: 1 } }), 'UNSUPPORTED_QUANTIZATION');
    await expectCode(create(s, { palette: { id: 'x', colors: [] } }), 'INVALID_INPUT');
    await expectCode(create(s, { priority: 0.5 }), 'INVALID_INPUT');
    await expectCode(create(s, { strategy: { id: 'spiral' as 'random' } }), 'INVALID_INPUT');
    await expect(create(s, { placement: at(0.5, 0) })).rejects.toBeInstanceOf(GeometryError);
    const bounded = { yAxis: 'down', bounds: { minX: 0, minY: 0, width: 10, height: 10 } } as const;
    await expect(create(s, { coordinateSystem: bounded, placement: at(50, 50) })).rejects.toMatchObject({ code: 'PLACEMENT_OUTSIDE_BOUNDS' });
    expect((await create(s, { coordinateSystem: bounded, placement: at(8, 8) })).revision).toBe(1); // partially outside: accepted
  });
});

describe('TemplateManager: revisions', () => {
  it('creates a placement revision that reuses the blobs, and keeps old revisions loadable', async () => {
    const s = setup();
    const t = await create(s);
    s.clock.tick();
    const r = await s.manager.revise(refOf(t), { placement: at(0, 0) });
    expect(r).toMatchObject({ created: true, reasons: ['placement'] });
    expect(r.template.revision).toBe(2);
    expect(r.template.quantizedImageHash).toBe(t.quantizedImageHash);
    expect(s.storage.state.blobs.size).toBe(2);

    const old = await s.manager.load(refOf(t), { revision: 1 });
    expect(old.template.placement).toEqual(at(100, 200));
    expect(old.report).toEqual({ requestedRevision: 1, loadedRevision: 1, manifestSource: 'current', problems: [] });
    expect((await s.manager.load(refOf(t))).template.placement).toEqual(at(0, 0));
    await expectCode(s.manager.load(refOf(t), { revision: 3 }), 'REVISION_NOT_FOUND');
  });

  it('treats an identical change as a no-op (nothing written)', async () => {
    const s = setup();
    const t = await create(s);
    const r = await s.manager.revise(refOf(t), { placement: at(100, 200), alphaThreshold: 128, sourcePng, palette });
    expect(r).toMatchObject({ created: false, reasons: [] });
    expect((await s.manager.manifest(refOf(t))).generation).toBe(1);
  });

  it('re-quantizes on palette, threshold, quantization and source changes', async () => {
    const s = setup();
    const t = await create(s);
    const ref = refOf(t);
    const noRed: Palette = { id: 'base', colors: [{ rgb: BLACK }, { rgb: WHITE }] };
    const a = await s.manager.revise(ref, { palette: noRed });
    expect(a.reasons).toEqual(['palette']);
    expect(a.template.image.pixels[0]).not.toBe(RED);
    const b = await s.manager.revise(ref, { alphaThreshold: 200 });
    expect(b.template.image.pixels[2]).toBe(TRANSPARENT_U32);
    const c = await s.manager.revise(ref, { quantization: { algorithm: 'nearest-color', distance: 'rgb-euclidean', version: 1 } });
    expect(c.reasons).toEqual(['quantization']);
    const d = await s.manager.revise(ref, { sourcePng: rgbaPng(1, 1, () => [255, 0, 0, 255]) });
    expect(d.reasons).toEqual(['source-image']);
    expect(d.template.image.width).toBe(1);
    const m = await s.manager.manifest(ref);
    expect(m.revisions.map((r) => [r.revision, r.basedOn, r.reasons])).toEqual([
      [1, null, ['created']],
      [2, 1, ['palette']],
      [3, 2, ['alpha-threshold']],
      [4, 3, ['quantization']],
      [5, 4, ['source-image']],
    ]);
    // Revision 1 still loads with its own palette and pixels.
    expect((await s.manager.load(ref, { revision: 1 })).template.image.pixels[0]).toBe(RED);
  });

  it('never creates a revision for name, strategy, priority or status, and never alters records', async () => {
    const s = setup();
    const t = await create(s);
    const ref = refOf(t);
    const before = (await s.manager.manifest(ref)).revisions;
    await s.manager.updateSettings(ref, { name: 'Autre nom', strategy: { id: 'random', seed: 7 }, priority: 5 });
    const summary = await s.manager.setStatus(ref, 'paused');
    expect(summary).toMatchObject({ name: 'Autre nom', priority: 5, status: 'paused', currentRevision: 1, revisionCount: 1, manifestSource: 'current' });
    const after = await s.manager.manifest(ref);
    expect(after.revisions).toEqual(before);
    expect(after.generation).toBe(3);
    // Unchanged settings: no write at all.
    await s.manager.updateSettings(ref, { name: 'Autre nom' });
    expect((await s.manager.manifest(ref)).generation).toBe(3);
  });

  it('restores an old revision as a new one (history is append-only)', async () => {
    const s = setup();
    const t = await create(s);
    const ref = refOf(t);
    await s.manager.revise(ref, { placement: at(1, 1) });
    const r = await s.manager.restoreRevision(ref, 1);
    expect(r).toMatchObject({ created: true, reasons: ['restored'] });
    expect(r.template.revision).toBe(3);
    expect(r.template.placement).toEqual(at(100, 200));
    expect((await s.manager.manifest(ref)).revisions[2]).toMatchObject({ basedOn: 1, reasons: ['restored'] });
    expect((await s.manager.restoreRevision(ref, 1)).created).toBe(false);
  });

  it('serializes concurrent mutations of one template', async () => {
    const s = setup();
    const t = await create(s);
    const ref = refOf(t);
    await Promise.all([s.manager.revise(ref, { placement: at(1, 0) }), s.manager.revise(ref, { placement: at(2, 0) }), s.manager.updateSettings(ref, { priority: 3 })]);
    const m = await s.manager.manifest(ref);
    expect(m.revisions.map((r) => r.placement.topLeft.x)).toEqual([100, 1, 2]);
    expect(m.generation).toBe(4);
  });

  it('reports a conflict when another writer changed the manifest (compare-and-swap)', async () => {
    const s = setup();
    const t = await create(s);
    let injected = false;
    const racing: TemplateStorage = {
      ...s.storage,
      async writeManifest(p, id, json, expected) {
        if (!injected) {
          injected = true;
          const m = await s.manager.manifest({ projectId: p, templateId: id });
          await s.storage.writeManifest(p, id, serializeManifest({ ...m, generation: m.generation + 1, name: 'Autre' }), m.generation);
        }
        return s.storage.writeManifest(p, id, json, expected);
      },
    };
    await expectCode(s.reopen(racing).revise(refOf(t), { placement: at(0, 0) }), 'CONFLICT');
    await expect(s.storage.writeManifest(P1, t.id, '{}', 99)).rejects.toBeInstanceOf(StorageConflictError);
    await expect(s.storage.writeManifest(P1, t.id, '{}', null)).rejects.toBeInstanceOf(StorageConflictError);
  });
});

describe('TemplateManager: integrity and recovery', () => {
  async function tamper(s: Setup, address: string): Promise<void> {
    const key = [...s.storage.state.blobs.keys()].find((k) => k.endsWith(address));
    if (key === undefined) throw new Error('blob not found');
    const bytes = s.storage.state.blobs.get(key) as Uint8Array;
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  }

  it('replaces a corrupt blob found at the address it must write (healing)', async () => {
    const s = setup();
    const t = await create(s);
    const record = (await s.manager.manifest(refOf(t))).revisions[0];
    const key = `${P1}/${record?.quantizedFileHash ?? ''}`;
    s.storage.state.blobs.set(key, new Uint8Array([1, 2, 3]));
    await expectCode(s.manager.load(refOf(t)), 'INTEGRITY_ERROR');
    // Creating the same content again rewrites the blob at its address.
    const again = await create(s, { name: 'Encore' });
    expect(again.quantizedImageHash).toBe(t.quantizedImageHash);
    expect((await s.manager.load(refOf(t))).template.revision).toBe(1);
  });

  it('never re-quantizes on load: one decode, no encode', async () => {
    const s = setup();
    const t = await create(s);
    const codec = { ...testCodec, decode: vi.fn(testCodec.decode), encode: vi.fn(testCodec.encode) };
    const loaded = await s.reopen(s.storage, codec).load(refOf(t));
    expect([...loaded.template.image.pixels]).toEqual([...t.image.pixels]);
    expect(codec.decode).toHaveBeenCalledTimes(1);
    expect(codec.encode).not.toHaveBeenCalled();
  });

  it('detects a wrong hash; explicit revisions never fall back; recover does (read-only)', async () => {
    const s = setup();
    const t = await create(s);
    const ref = refOf(t);
    const r2 = await s.manager.revise(ref, { alphaThreshold: 200 });
    const record2 = (await s.manager.manifest(ref)).revisions[1];
    await tamper(s, record2?.quantizedFileHash ?? '');
    await expectCode(s.manager.load(ref), 'INTEGRITY_ERROR');
    await expectCode(s.manager.load(ref, { revision: 2, recover: true }), 'INTEGRITY_ERROR');
    const generation = (await s.manager.manifest(ref)).generation;
    const recovered = await s.manager.load(ref, { recover: true });
    expect(recovered.report.loadedRevision).toBe(1);
    expect(recovered.report.problems[0]).toMatch(/revision 2/);
    expect((await s.manager.manifest(ref)).generation).toBe(generation); // nothing rewritten
    const report = await s.manager.verify(ref);
    expect(report.revisions.map((r) => r.ok)).toEqual([true, false]);
    expect(r2.template.revision).toBe(2);
  });

  it('detects a missing or altered source blob', async () => {
    const s = setup();
    const t = await create(s);
    await tamper(s, t.sourceImageHash);
    await expectCode(s.manager.load(refOf(t)), 'INTEGRITY_ERROR');
    await expectCode(s.manager.revise(refOf(t), { alphaThreshold: 1 }), 'INTEGRITY_ERROR');
  });

  it('refuses malformed or foreign manifests, and recovers from the backup when asked', async () => {
    const s = setup();
    const t = await create(s);
    const ref = refOf(t);
    await s.manager.revise(ref, { placement: at(5, 5) });
    const entry = s.storage.state.manifests.get(`${P1}/${t.id}`);
    if (entry === undefined) throw new Error('missing');
    entry.current = '{"schemaVersion":1,"truncated';
    await expectCode(s.manager.load(ref), 'INVALID_MANIFEST');
    const fromBackup = await s.manager.load(ref, { recover: true });
    expect(fromBackup.report.manifestSource).toBe('backup');
    expect(fromBackup.template.revision).toBe(1);
    expect((await s.manager.list(P1)).templates[0]?.manifestSource).toBe('backup');
    await expectCode(s.manager.revise(ref, { placement: at(6, 6) }), 'INVALID_MANIFEST');

    // A newer schema is never replaced by the older backup, even when recovering.
    entry.current = (entry.backup ?? '').replace('"schemaVersion": 1', '"schemaVersion": 9');
    await expectCode(s.manager.load(ref), 'UNSUPPORTED_SCHEMA');
    await expectCode(s.manager.load(ref, { recover: true }), 'UNSUPPORTED_SCHEMA');
    await expectCode(s.manager.verify(ref), 'UNSUPPORTED_SCHEMA');
    expect(await s.manager.list(P1)).toEqual({
      templates: [],
      failures: [{ templateId: t.id, code: 'UNSUPPORTED_SCHEMA', message: 'the manifest was written by a newer version of GeoPlacer' }],
    });

    // A valid manifest stored under another project is not accepted there.
    s.storage.state.manifests.set(`${P2}/${t.id}`, { current: entry.backup, backup: null });
    await expectCode(s.manager.load({ projectId: P2, templateId: t.id }), 'INVALID_MANIFEST');
  });
});

describe('TemplateManager: projects, duplication, deletion', () => {
  it('isolates projects', async () => {
    const s = setup();
    const a = await create(s);
    const b = await create(s, { projectId: P2, name: 'Autre projet' });
    expect((await s.manager.list(P1)).templates.map((x) => x.name)).toEqual(['Fresque']);
    expect((await s.manager.list(P2)).templates.map((x) => x.name)).toEqual(['Autre projet']);
    await expectCode(s.manager.load({ projectId: P2, templateId: a.id }), 'NOT_FOUND');
    // Blobs are per project: damaging P1's copy does not affect P2.
    const key = `${P1}/${(await s.manager.manifest(refOf(a))).revisions[0]?.quantizedFileHash ?? ''}`;
    s.storage.state.blobs.delete(key);
    await expectCode(s.manager.load(refOf(a)), 'INTEGRITY_ERROR');
    expect((await s.manager.load(refOf(b))).template.revision).toBe(1);
  });

  it('duplicates the current revision (paused, new id, optionally into another project)', async () => {
    const s = setup();
    const t = await create(s);
    await s.manager.revise(refOf(t), { placement: at(3, 3) });
    const copy = await s.manager.duplicate(refOf(t), { name: 'Copie', projectId: P2 });
    expect(copy).toMatchObject({ projectId: P2, name: 'Copie', revision: 1, status: 'paused', placement: at(3, 3) });
    expect(copy.id).not.toBe(t.id);
    expect((await s.manager.manifest(refOf(copy))).revisions[0]).toMatchObject({ reasons: ['duplicated'], basedOn: null });
    expect((await s.manager.verify(refOf(copy))).revisions[0]?.ok).toBe(true);
  });

  it('deletes only with the exact name, as a tombstone (files kept)', async () => {
    const s = setup();
    const t = await create(s);
    const ref = refOf(t);
    await expectCode(s.manager.delete(ref, { confirmName: 'fresque' }), 'CONFIRMATION_REQUIRED');
    await s.manager.delete(ref, { confirmName: 'Fresque' });
    await expectCode(s.manager.load(ref), 'DELETED');
    await expectCode(s.manager.revise(ref, { placement: at(0, 0) }), 'DELETED');
    expect(await s.manager.list(P1)).toEqual({ templates: [], failures: [] });
    expect((await s.manager.manifest(ref)).deletedAt).not.toBeNull();
    expect(s.storage.state.blobs.size).toBe(2);
    await expectCode(s.manager.load({ projectId: P1, templateId: 'inconnu' as never }), 'NOT_FOUND');
  });
});

describe('TemplateManager: listing isolation', () => {
  it('lists the readable templates and reports the others apart, without their content', async () => {
    const s = setup();
    const good = await create(s, { name: 'Lisible' });
    const corrupt = await create(s, { name: 'Corrompu secret' });
    const newer = await create(s, { name: 'Futur' });
    const io = await create(s, { name: 'Disque' });
    const entryOf = (id: string) => {
      const entry = s.storage.state.manifests.get(`${P1}/${id}`);
      if (entry === undefined) throw new Error('missing');
      return entry;
    };
    entryOf(corrupt.id).current = '{"name":"Corrompu secret", broken';
    entryOf(corrupt.id).backup = '{"also": "broken"}';
    const futur = entryOf(newer.id);
    futur.current = (futur.current ?? '').replace('"schemaVersion": 1', '"schemaVersion": 9');
    const failing: TemplateStorage = {
      ...s.storage,
      readManifest: async (projectId, templateId) => {
        if (templateId === io.id) throw new Error('EIO: C:\\secret\\path\\manifest.json');
        return s.storage.readManifest(projectId, templateId);
      },
    };
    const listing = await s.reopen(failing).list(P1);
    expect(listing.templates.map((x) => x.templateId)).toEqual([good.id]);
    expect(listing.failures).toEqual([
      { templateId: corrupt.id, code: 'INVALID_MANIFEST', message: 'the manifest and its backup are missing or invalid' },
      { templateId: newer.id, code: 'UNSUPPORTED_SCHEMA', message: 'the manifest was written by a newer version of GeoPlacer' },
      { templateId: io.id, code: 'READ_ERROR', message: 'the storage could not read the manifest' },
    ]);
    expect(JSON.stringify(listing.failures)).not.toMatch(/secret|broken|path/i);
  });
});

describe('TemplateManager: explicit repair', () => {
  async function corrupted(s: Setup) {
    const t = await create(s);
    const ref = refOf(t);
    await s.manager.revise(ref, { placement: at(5, 5) });
    await s.manager.revise(ref, { placement: at(6, 6) });
    const entry = s.storage.state.manifests.get(`${P1}/${t.id}`);
    if (entry === undefined) throw new Error('missing');
    const backup = entry.backup;
    entry.current = '{"schemaVersion":1,"truncated';
    return { t, ref, entry, backup };
  }

  it('does nothing on a valid manifest', async () => {
    const s = setup();
    const t = await create(s);
    expect(await s.manager.repair(refOf(t), { apply: true })).toEqual({
      action: 'none', applied: false, problem: null, generation: 1, currentRevision: 1, preservedAs: null,
    });
  });

  it('diagnoses without writing, then restores the backup and preserves the corrupt file', async () => {
    const s = setup();
    const { ref, entry, backup } = await corrupted(s);
    const dry = await s.manager.repair(ref, { apply: false });
    expect(dry).toEqual({ action: 'restore-backup', applied: false, problem: 'the current manifest is malformed', generation: 4, currentRevision: 2, preservedAs: null });
    expect(entry.current).toBe('{"schemaVersion":1,"truncated');
    expect(s.storage.state.preserved.size).toBe(0);

    s.clock.tick(1000);
    const done = await s.manager.repair(ref, { apply: true });
    expect(done).toMatchObject({ action: 'restore-backup', applied: true, generation: 4, currentRevision: 2 });
    expect(done.preservedAs).not.toBeNull();
    expect(s.storage.state.preserved.get(done.preservedAs ?? '')).toBe('{"schemaVersion":1,"truncated');
    expect(entry.backup).toBe(backup); // the good backup is never overwritten by the corrupt file
    const loaded = await s.manager.load(ref);
    expect(loaded.report).toMatchObject({ manifestSource: 'current', loadedRevision: 2, problems: [] });
    // History up to the backup is intact and writable again.
    expect((await s.manager.verify(ref)).revisions.map((r) => r.ok)).toEqual([true, true]);
    const next = await s.manager.revise(ref, { placement: at(8, 8) });
    expect(next.template.revision).toBe(3);
    expect((await s.manager.manifest(ref)).generation).toBe(5);
    expect(await s.manager.repair(ref, { apply: true })).toMatchObject({ action: 'none' });
  });

  it('repairs a missing current manifest from the backup (nothing to preserve)', async () => {
    const s = setup();
    const { ref, entry } = await corrupted(s);
    entry.current = null;
    expect(await s.manager.repair(ref, { apply: true })).toMatchObject({ action: 'restore-backup', applied: true, problem: 'the current manifest is missing', preservedAs: null });
    expect((await s.manager.load(ref)).template.revision).toBe(2);
  });

  it('never replaces a newer schema, nor repairs from an invalid backup or one that does not verify', async () => {
    const s = setup();
    const { t, ref, entry, backup } = await corrupted(s);
    const untouched = async (code: string): Promise<void> => {
      const before = { current: entry.current, backup: entry.backup };
      await expectCode(s.manager.repair(ref, { apply: true }), code);
      expect({ current: entry.current, backup: entry.backup }).toEqual(before);
      expect(s.storage.state.preserved.size).toBe(0);
    };
    entry.current = (backup ?? '').replace('"schemaVersion": 1', '"schemaVersion": 9');
    await untouched('UNSUPPORTED_SCHEMA');

    entry.current = 'garbage';
    entry.backup = 'garbage too';
    await untouched('INVALID_MANIFEST');
    entry.backup = null;
    await untouched('INVALID_MANIFEST');

    entry.backup = backup;
    const record = (JSON.parse(backup ?? '') as { revisions: Array<{ quantizedFileHash: string }> }).revisions[1];
    s.storage.state.blobs.delete(`${P1}/${record?.quantizedFileHash ?? ''}`);
    await untouched('INTEGRITY_ERROR');
    await expectCode(s.manager.repair({ projectId: P1, templateId: 'absent' as never }, { apply: true }), 'NOT_FOUND');
    expect(t.id).toBeDefined();
  });
});

describe('TemplateManager: placement warnings', () => {
  it('warns explicitly when a placement crosses the canvas bounds', async () => {
    const s = setup();
    const bounded = { yAxis: 'down', bounds: { minX: 0, minY: 0, width: 100, height: 100 } } as const;
    const inside = await create(s, { placement: at(10, 10), coordinateSystem: bounded });
    expect(inside.warnings).toEqual([]);
    const ref = refOf(inside);
    const crossing = await s.manager.revise(ref, { placement: at(98, 99) });
    // 4x2 image at (98, 99): columns 98-99 and row 99 are inside -> 2 of 8 pixels inside.
    expect(crossing.template.warnings).toEqual([
      { code: 'PLACEMENT_PARTIALLY_OUTSIDE', pixelsOutside: 6, message: '6 of 8 template pixels lie outside the canvas bounds and will never be painted' },
    ]);
    expect((await s.manager.load(ref)).template.warnings[0]?.code).toBe('PLACEMENT_PARTIALLY_OUTSIDE');
    expect((await s.manager.list(P1)).templates[0]?.warnings[0]?.pixelsOutside).toBe(6);
    expect((await s.manager.load(ref, { revision: 1 })).template.warnings).toEqual([]);
    const unbounded = await create(s, { placement: at(-1_000_000, 5) });
    expect(unbounded.warnings).toEqual([]);
  });
});
