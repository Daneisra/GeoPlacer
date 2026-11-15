import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProjectId, TemplateId, TemplateManager } from '@geoplacer/core';
import { TemplateError, asProjectId, createTemplateManager, loadRandomOrder, random, rgb } from '@geoplacer/core';
import {
  DataDirectoryLockedError,
  FileOrderCacheStore,
  NodeTemplateStorage,
  acquireDataDirectoryLock,
  nodeSha256Hasher,
  openNodeTemplateManager,
  pngjsCodec,
  randomIdSource,
  systemClock,
  type DataDirectoryLock,
  type LockMechanism,
  type NodeTemplateManagerHandle,
} from '../src/index.js';
import { rgbaPng, writePng } from '../../core/test/helpers/png.js';
import { storageConformance } from '../../core/test/helpers/storage-conformance.js';

const temps: string[] = [];
const locks: DataDirectoryLock[] = [];
/** One instance per data directory, as in production (the lock forbids a second one). */
const handles = new Map<string, NodeTemplateManagerHandle>();

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'geoplacer-test-'));
  temps.push(dir);
  return dir;
}
async function lockedStorage(root?: string): Promise<NodeTemplateStorage> {
  const lock = await acquireDataDirectoryLock(root ?? (await tempRoot()));
  locks.push(lock);
  return new NodeTemplateStorage(lock);
}
async function open(root: string): Promise<NodeTemplateManagerHandle> {
  let handle = handles.get(root);
  if (handle === undefined) {
    handle = await openNodeTemplateManager(root);
    handles.set(root, handle);
  }
  return handle;
}
const managerOf = async (root: string): Promise<TemplateManager> => (await open(root)).manager;
async function closeAll(): Promise<void> {
  await Promise.all([...handles.values()].map((h) => h.close()));
  handles.clear();
  await Promise.all(locks.splice(0).map((l) => l.release()));
}
afterAll(async () => {
  // The lock file is held open (Windows share lock): release before removing.
  await closeAll();
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

storageConformance({ name: 'filesystem', make: () => lockedStorage(), codec: pngjsCodec, hasher: nodeSha256Hasher });

const P = asProjectId('projet-a');
const palette = { id: 'p', colors: [{ rgb: rgb(0, 0, 0) }, { rgb: rgb(255, 255, 255) }, { rgb: rgb(255, 0, 0) }] };
const create = async (root: string, extra: { sourcePng?: Uint8Array; projectId?: ProjectId } = {}) =>
  (await managerOf(root)).create({
    projectId: extra.projectId ?? P,
    name: 'Fresque',
    sourcePng: extra.sourcePng ?? rgbaPng(5, 3, (x, y) => [x * 50, y * 100, 0, x === 0 ? 0 : 255]),
    palette,
    placement: { topLeft: { x: 0, y: 0 } },
    coordinateSystem: { yAxis: 'down' },
  });

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(TemplateError);
  expect((error as TemplateError).code).toBe(code);
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'));
}

describe('pngjs codec', () => {
  it('decodes palette + tRNS, grey 1/8/16-bit, grey+alpha, RGB and interlaced files to 8-bit RGBA', async () => {
    const cases: Array<[string, Uint8Array, number[]]> = [
      ['palette+tRNS', writePng({ width: 2, height: 1, colorType: 3, bitDepth: 8, palette: [[255, 0, 0], [0, 0, 255]], paletteAlpha: [0, 255], row: () => new Uint8Array([0, 1]) }), [255, 0, 0, 0, 0, 0, 255, 255]],
      ['palette 2-bit', writePng({ width: 2, height: 1, colorType: 3, bitDepth: 2, palette: [[0, 0, 0], [9, 8, 7]], row: () => new Uint8Array([0b0100_0000]) }), [9, 8, 7, 255, 0, 0, 0, 255]],
      ['grey 1-bit', writePng({ width: 2, height: 1, colorType: 0, bitDepth: 1, row: () => new Uint8Array([0b1000_0000]) }), [255, 255, 255, 255, 0, 0, 0, 255]],
      ['grey 16-bit', writePng({ width: 1, height: 1, colorType: 0, bitDepth: 16, row: () => new Uint8Array([0xff, 0xff]) }), [255, 255, 255, 255]],
      ['grey+alpha', writePng({ width: 1, height: 1, colorType: 4, bitDepth: 8, row: () => new Uint8Array([100, 50]) }), [100, 100, 100, 50]],
      ['RGB 8-bit', writePng({ width: 1, height: 1, colorType: 2, bitDepth: 8, row: () => new Uint8Array([1, 2, 3]) }), [1, 2, 3, 255]],
      ['RGBA 16-bit', writePng({ width: 1, height: 1, colorType: 6, bitDepth: 16, row: () => new Uint8Array([0xff, 0xff, 0, 0, 0x80, 0x00, 0xff, 0xff]) }), [255, 0, 128, 255]],
      ['interlaced 1x1', writePng({ width: 1, height: 1, colorType: 6, bitDepth: 8, interlace: 1, row: () => new Uint8Array([4, 5, 6, 7]) }), [4, 5, 6, 7]],
    ];
    for (const [label, bytes, rgba] of cases) {
      const decoded = await pngjsCodec.decode(bytes);
      expect([...decoded.rgba], label).toEqual(rgba);
    }
  });

  it('round-trips a quantized image exactly (strict canonical check in the manager)', async () => {
    const root = await tempRoot();
    const t = await create(root, { sourcePng: rgbaPng(64, 64, (x, y) => [(x * 7) % 256, (y * 11) % 256, (x * y) % 256, (x + y) % 3 === 0 ? 0 : 255]) });
    const loaded = await (await managerOf(root)).load({ projectId: P, templateId: t.id });
    expect([...loaded.template.image.pixels]).toEqual([...t.image.pixels]);
  });

  it('rejects corrupt data through the manager', async () => {
    const root = await tempRoot();
    const png = rgbaPng(4, 4, () => [1, 2, 3, 255]);
    png[png.length - 20] = (png[png.length - 20] ?? 0) ^ 0xff;
    await expectCode(create(root, { sourcePng: png }), 'INVALID_PNG');
  });
});

describe('NodeTemplateStorage', () => {
  it('uses the documented layout and leaves no temporary file', async () => {
    const root = await tempRoot();
    const t = await create(root);
    // New pixels (no red any more): a third blob. Same pixels would reuse the same address.
    await (await managerOf(root)).revise({ projectId: P, templateId: t.id }, { palette: { id: 'p2', colors: [{ rgb: rgb(0, 0, 0) }, { rgb: rgb(255, 255, 255) }] } });
    const files = await filesUnder(root);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(files).toContain(`projects/projet-a/templates/${t.id}/manifest.json`);
    expect(files).toContain(`projects/projet-a/templates/${t.id}/manifest.json.bak`);
    expect(files.filter((f) => /^projects\/projet-a\/blobs\/[0-9a-f]{64}\.png$/.test(f)).length).toBe(3);
  });

  it('lists only valid template directories holding a manifest', async () => {
    const root = await tempRoot();
    const t = await create(root);
    const templates = path.join(root, 'projects', 'projet-a', 'templates');
    await mkdir(path.join(templates, 'vide'), { recursive: true }); // interrupted creation
    await mkdir(path.join(templates, 'Majuscule'));
    await mkdir(path.join(templates, 'nul'));
    await writeFile(path.join(templates, 'fichier'), 'x');
    await writeFile(path.join(templates, t.id, 'manifest.json.1234.tmp'), 'partial');
    const handle = await open(root);
    expect(await new NodeTemplateStorage(handle.lock).listTemplates(P)).toEqual([t.id]);
    expect((await handle.manager.list(P)).templates.map((s) => s.templateId)).toEqual([t.id]);
  });

  it('rejects invalid ids, addresses and paths escaping the root', async () => {
    const storage = await lockedStorage();
    await expect(storage.readManifest('..' as ProjectId, 'x' as TemplateId)).rejects.toThrow(/invalid project id/);
    await expect(storage.readManifest(P, '../../etc' as TemplateId)).rejects.toThrow(/invalid template id/);
    await expect(storage.readManifest(P, 'com1' as TemplateId)).rejects.toThrow(/invalid template id/);
    await expect(storage.readBlob(P, '../manifest')).rejects.toThrow(/invalid blob address/);
    await expect(storage.writeBlob(P, 'A'.repeat(64), new Uint8Array(1))).rejects.toThrow(/invalid blob address/);
  });

  it('detects files altered on disk and recovers from the backup manifest (read-only)', async () => {
    const root = await tempRoot();
    const t = await create(root);
    const m = (await managerOf(root));
    const ref = { projectId: P, templateId: t.id };
    await m.revise(ref, { placement: { topLeft: { x: 4, y: 4 } } });
    const dir = path.join(root, 'projects', 'projet-a');
    const manifestPath = path.join(dir, 'templates', t.id, 'manifest.json');
    const good = await readFile(manifestPath, 'utf8');
    await writeFile(manifestPath, good.slice(0, 100));
    await expectCode(m.load(ref), 'INVALID_MANIFEST');
    const recovered = await m.load(ref, { recover: true });
    expect(recovered.report).toMatchObject({ manifestSource: 'backup', loadedRevision: 1 });
    expect(await readFile(manifestPath, 'utf8')).toBe(good.slice(0, 100)); // nothing rewritten
    await writeFile(manifestPath, good);
    const record = (await m.manifest(ref)).revisions[0];
    const blob = path.join(dir, 'blobs', `${record?.quantizedFileHash ?? ''}.png`);
    const bytes = await readFile(blob);
    bytes[bytes.length - 13] = (bytes[bytes.length - 13] ?? 0) ^ 1;
    await writeFile(blob, bytes);
    await expectCode(m.load(ref), 'INTEGRITY_ERROR');
    expect((await m.verify(ref)).revisions.map((r) => r.ok)).toEqual([false, false]);
  });

  it('repairs a corrupt manifest from the backup on disk, keeping the raw corrupt bytes', async () => {
    const root = await tempRoot();
    const t = await create(root);
    const m = await managerOf(root);
    const ref = { projectId: P, templateId: t.id };
    await m.revise(ref, { placement: { topLeft: { x: 4, y: 4 } } });
    await m.revise(ref, { placement: { topLeft: { x: 5, y: 5 } } });
    const dir = path.join(root, 'projects', 'projet-a', 'templates', t.id);
    const backupBefore = await readFile(path.join(dir, 'manifest.json.bak'));
    // Not even valid UTF-8: the evidence must be the exact bytes.
    const corrupt = Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x00, 0x41]);
    await writeFile(path.join(dir, 'manifest.json'), corrupt);
    expect((await m.list(P)).templates[0]?.manifestSource).toBe('backup');
    expect(await m.repair(ref, { apply: false })).toMatchObject({ action: 'restore-backup', applied: false });
    expect(await readFile(path.join(dir, 'manifest.json'))).toEqual(corrupt);
    const report = await m.repair(ref, { apply: true });
    expect(report).toMatchObject({ action: 'restore-backup', applied: true, currentRevision: 2 });
    expect(report.preservedAs).toMatch(/^manifest\.json\.corrupt-[0-9TZ-]+-[0-9a-f]{8}$/);
    expect(await readFile(path.join(dir, report.preservedAs ?? ''))).toEqual(corrupt);
    expect(await readFile(path.join(dir, 'manifest.json.bak'))).toEqual(backupBefore);
    expect((await m.load(ref)).report).toMatchObject({ manifestSource: 'current', loadedRevision: 2, problems: [] });
    expect((await filesUnder(root)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('isolates projects on disk', async () => {
    const root = await tempRoot();
    const a = await create(root);
    await create(root, { projectId: asProjectId('projet-b') });
    await rm(path.join(root, 'projects', 'projet-b'), { recursive: true });
    expect((await (await managerOf(root)).load({ projectId: P, templateId: a.id })).template.revision).toBe(1);
    expect(await (await managerOf(root)).list(asProjectId('projet-b'))).toEqual({ templates: [], failures: [] });
  });

  it('uses random UUID ids and the system clock by default', async () => {
    const manager = createTemplateManager({ storage: await lockedStorage(), hasher: nodeSha256Hasher, codec: pngjsCodec, ids: randomIdSource, clock: systemClock });
    const t = await manager.create({ projectId: P, name: 'x', sourcePng: rgbaPng(1, 1, () => [0, 0, 0, 255]), palette, placement: { topLeft: { x: 0, y: 0 } }, coordinateSystem: { yAxis: 'down' } });
    expect(t.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Math.abs(t.createdAt - Date.now())).toBeLessThan(60_000);
  });
});

describe('real process kill during writes (named steps, Phase 1B.8)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = path.join(here, 'fixtures', 'kill-child.ts');
  const repoRoot = path.resolve(here, '..', '..', '..');
  const childEnv = { ...process.env, TSX_TSCONFIG_PATH: path.join(here, 'fixtures', 'tsconfig.child.json') };

  /**
   * Runs kill-child, which kills itself at `step` (explicit synchronisation:
   * no timer). Resolves with the template id once the child is dead.
   */
  function runUntilStep(root: string, templateId: string | undefined, step: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['--import', 'tsx', child, root, templateId ?? '-', step], { cwd: repoRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      proc.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
      proc.on('exit', () => {
        const id = /ready (\S+)/.exec(out)?.[1];
        if (id === undefined) reject(new Error(`child failed before ready: ${err}`));
        else if (!out.includes(`reached ${step}`)) reject(new Error(`step ${step} never reached: ${out} ${err}`));
        else resolve(id);
      });
    });
  }

  // Each step once: the temp file created empty, written and fsynced, renamed; reservations; blobs.
  const steps = [
    'temp-created:manifest.json#1',
    'temp-written:manifest.json#2',
    'renamed:manifest.json#3',
    'reserved:revision-#1',
    'reserved:generation-#2',
    'temp-written:.png#1',
    'renamed:.png#1',
    'temp-created:manifest.json#4',
  ];

  it('always reopens to a complete, verified revision after a kill at each write step', { timeout: 180_000 }, async () => {
    const root = await tempRoot();
    let id: string | undefined;
    let generation = 0;
    for (const step of steps) {
      // Resolves on the child's exit: the kernel has released its lock.
      id = await runUntilStep(root, id, step);
      const handle = await openNodeTemplateManager(root);
      try {
        const ref = { projectId: asProjectId('projet-kill'), templateId: id as TemplateId };
        const loaded = await handle.manager.load(ref);
        expect({ step, problems: loaded.report.problems }).toEqual({ step, problems: [] });
        const report = await handle.manager.verify(ref);
        expect({ step, source: report.manifestSource, ok: report.revisions.every((r) => r.ok) }).toEqual({ step, source: 'current', ok: true });
        const manifest = await handle.manager.manifest(ref);
        expect(manifest.generation).toBeGreaterThanOrEqual(generation);
        generation = manifest.generation;
      } finally {
        await handle.close();
      }
    }
    expect(generation).toBeGreaterThan(steps.length);
  });

  /** Runs repair-child, which kills itself at `step` of the repair (or completes it with 'none'). */
  function repairUntilStep(root: string, templateId: string, step: string): Promise<'reached' | 'completed'> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'fixtures', 'repair-child.ts'), root, templateId, step], { cwd: repoRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      proc.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
      proc.on('exit', (code) => {
        if (out.includes(`reached ${step}`)) resolve('reached');
        else if (code === 0 && out.includes('repaired')) resolve('completed');
        else reject(new Error(`repair child failed (${String(code)}): ${out} ${err}`));
      });
    });
  }

  it('never gives a revision number to two contents across kills, corruption and repairs killed at each step', { timeout: 300_000 }, async () => {
    const root = await tempRoot();
    const P_KILL = asProjectId('projet-kill');
    const contentOf = new Map<number, string>();
    const generations: number[] = [];
    let id: string | undefined;
    const record = async (manager: TemplateManager, ref: { projectId: ProjectId; templateId: TemplateId }): Promise<void> => {
      const manifest = await manager.manifest(ref);
      generations.push(manifest.generation);
      for (const r of manifest.revisions) {
        const key = JSON.stringify([r.quantizedImageHash, r.placement, r.alphaThreshold]);
        const seen = contentOf.get(r.revision);
        if (seen !== undefined) expect(seen, `revision ${r.revision} reused`).toBe(key);
        contentOf.set(r.revision, key);
      }
    };
    const rounds: { write: string; repair: string }[] = [
      { write: 'renamed:manifest.json#2', repair: 'reserved:generation-#1' },
      { write: 'temp-written:manifest.json#3', repair: 'temp-created:manifest.json#1' },
      { write: 'reserved:revision-#2', repair: 'temp-written:manifest.json#1' },
      { write: 'renamed:.png#1', repair: 'renamed:manifest.json#1' },
      { write: 'temp-created:manifest.json#2', repair: 'none' },
    ];
    for (const { write, repair } of rounds) {
      id = await runUntilStep(root, id, write); // writes revisions until it kills itself
      const ref = { projectId: P_KILL, templateId: id as TemplateId };
      let handle = await openNodeTemplateManager(root);
      await record(handle.manager, ref);
      await handle.close();
      // Lose the current manifest (and the revision that may live only there).
      const manifestPath = path.join(root, 'projects', 'projet-kill', 'templates', id, 'manifest.json');
      await writeFile(manifestPath, '{"corrupt');
      const outcome = await repairUntilStep(root, id, repair); // the repair, killed at a named step
      expect({ repair, outcome }).toEqual({ repair, outcome: repair === 'none' ? 'completed' : 'reached' });
      handle = await openNodeTemplateManager(root);
      if ((await readFile(manifestPath, 'utf8')) === '{"corrupt') await handle.manager.repair(ref, { apply: true }); // finish it
      const loaded = await handle.manager.load(ref);
      expect(loaded.report.problems).toEqual([]);
      await record(handle.manager, ref);
      await handle.close();
    }
    // Generations never go back; revision numbers were used for more contents than kept (gaps), never twice.
    for (let i = 1; i < generations.length; i++) expect(generations[i]!).toBeGreaterThanOrEqual(generations[i - 1]!);
    expect(contentOf.size).toBeGreaterThan(1);
  });
});

describe('random order cache on disk', () => {
  it('stores, verifies and rebuilds the order under the locked data directory', async () => {
    const root = await tempRoot();
    const handle = await open(root);
    const store = new FileOrderCacheStore(handle.lock);
    const img = { width: 50, height: 40, pixels: new Uint32Array(2000).map((_, i) => (i % 9 === 0 ? 0xffffffff : i % 5)) };
    const config = { id: 'random' as const, seed: 5 };
    const key = { projectId: 'projet-a', templateId: 'modele-x', revision: 2, strategy: 'random' as const, strategyVersion: 1, seed: 5, quantizedImageHash: 'b'.repeat(64), format: 1 as const };
    const expected = [...random.order(img, config)];
    expect((await loadRandomOrder(img, config, key, { hasher: nodeSha256Hasher, store })).source).toBe('generated');
    const file = path.join(root, 'cache', 'orders', 'projet-a', 'modele-x', 'random-r2-v1-s5.order');
    expect((await readFile(file)).subarray(0, 8).toString()).toBe('GPORDER1');
    const cached = await loadRandomOrder(img, config, key, { hasher: nodeSha256Hasher, store });
    expect(cached.source).toBe('cache');
    expect([...cached.order]).toEqual(expected);
    // Damaged on disk: rebuilt, same order.
    const bytes = await readFile(file);
    bytes[bytes.length - 3]! ^= 0xff;
    await writeFile(file, bytes);
    const rebuilt = await loadRandomOrder(img, config, key, { hasher: nodeSha256Hasher, store });
    expect(rebuilt).toMatchObject({ source: 'generated', problem: expect.stringMatching(/checksum mismatch/) as string });
    expect([...rebuilt.order]).toEqual(expected);
    // Deleting the whole cache is safe.
    await rm(path.join(root, 'cache'), { recursive: true });
    expect([...(await loadRandomOrder(img, config, key, { hasher: nodeSha256Hasher, store })).order]).toEqual(expected);
    expect(() => new FileOrderCacheStore({ ...handle.lock, assertHeld: () => { throw new Error('released'); } })).toThrow('released');
    await expect(store.read({ ...key, templateId: '../x' })).rejects.toThrow(/invalid/);
  });
});

describe('number reservations on disk', () => {
  it('counts a reservation by its name, whatever its content; ignores unknown names; never reads an error as none', async () => {
    const root = await tempRoot();
    const t = await create(root);
    const dir = path.join(root, 'projects', 'projet-a', 'templates', t.id, 'reservations');
    expect((await readdir(dir)).sort()).toEqual(['generation-000000000000001', 'revision-000000000000001']);
    const storage = new NodeTemplateStorage((await open(root)).lock);
    await writeFile(path.join(dir, 'generation-000000000000009'), ''); // empty (crash before writing the content)
    await writeFile(path.join(dir, 'revision-000000000000004'), 'garbage');
    await writeFile(path.join(dir, 'notes.txt'), 'unknown names are ignored');
    await writeFile(path.join(dir, 'generation-abc'), '');
    expect(await storage.reservations(P, t.id)).toEqual({ generation: 9, revision: 4 });
    const revised = await (await managerOf(root)).revise({ projectId: P, templateId: t.id }, { placement: { topLeft: { x: 3, y: 3 } } });
    expect(revised.template.revision).toBe(5);
    expect((await (await managerOf(root)).manifest({ projectId: P, templateId: t.id })).generation).toBe(10);
    await expect(storage.reserve(P, t.id, 'revision', 5)).rejects.toThrow();
    // A reservation store that cannot be listed is an error, not "no reservation".
    await rm(dir, { recursive: true });
    await writeFile(dir, 'not a directory');
    await expect(storage.reservations(P, t.id)).rejects.toThrow();
  });
});

const MECHANISMS: LockMechanism[] = process.platform === 'win32' ? ['windows-share-lock', 'pid-file'] : ['pid-file'];

describe('data directory lock (one process)', () => {
  for (const mechanism of MECHANISMS) {
    it(`refuses a second holder and every write after release: ${mechanism}`, async () => {
      const root = await tempRoot();
      const first = await acquireDataDirectoryLock(root, { mechanism });
      const refused = await acquireDataDirectoryLock(root, { mechanism }).then(
        () => null,
        (e: unknown) => e
      );
      expect(refused).toBeInstanceOf(DataDirectoryLockedError);
      expect((refused as DataDirectoryLockedError).owner?.pid).toBe(process.pid);
      const storage = new NodeTemplateStorage(first);
      await storage.writeBlob(P, 'a'.repeat(64), new Uint8Array([1]));
      await first.release();
      await first.release(); // idempotent
      expect(first.held).toBe(false);
      await expect(storage.writeBlob(P, 'b'.repeat(64), new Uint8Array([1]))).rejects.toThrow(/released/);
      await expect(storage.writeManifest(P, 'x' as TemplateId, '{}', null)).rejects.toThrow(/released/);
      expect(() => new NodeTemplateStorage(first)).toThrow(/released/);
      const second = await acquireDataDirectoryLock(root, { mechanism });
      expect(second.held).toBe(true);
      await second.release();
    });
  }

  it('takes over a pid-file lock left by a dead process, but not one of a live process', async () => {
    const root = await tempRoot();
    const dead = { pid: 2 ** 30, host: (await import('node:os')).hostname(), startedAt: 'x', token: 'old' };
    await writeFile(path.join(root, '.geoplacer.lock'), JSON.stringify(dead));
    const lock = await acquireDataDirectoryLock(root, { mechanism: 'pid-file' });
    expect(JSON.parse(await readFile(path.join(root, '.geoplacer.lock'), 'utf8'))).toMatchObject({ pid: process.pid });
    await lock.release();
    await writeFile(path.join(root, '.geoplacer.lock'), JSON.stringify({ ...dead, pid: process.pid }));
    await expect(acquireDataDirectoryLock(root, { mechanism: 'pid-file' })).rejects.toBeInstanceOf(DataDirectoryLockedError);
    // Another host's lock is never judged stale from here.
    await writeFile(path.join(root, '.geoplacer.lock'), JSON.stringify({ ...dead, host: 'autre-machine' }));
    await expect(acquireDataDirectoryLock(root, { mechanism: 'pid-file' })).rejects.toBeInstanceOf(DataDirectoryLockedError);
    // Published with link(), a lock is never empty: an empty one is damaged and taken over.
    await writeFile(path.join(root, '.geoplacer.lock'), '');
    const again = await acquireDataDirectoryLock(root, { mechanism: 'pid-file' });
    await again.release();
    expect((await readdir(root)).filter((f) => f.endsWith('.tmp') || f.includes('.stale-'))).toEqual([]);
  });
});

describe('data directory lock (independent processes)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = path.join(here, 'fixtures', 'lock-child.ts');
  const repoRoot = path.resolve(here, '..', '..', '..');

  interface Child {
    readonly pid: number;
    readonly line: Promise<string>;
    readonly exit: Promise<number | null>;
    kill(): void;
  }

  function start(root: string, mechanism: LockMechanism, holdMs: number): Child {
    const proc = spawn(process.execPath, ['--import', 'tsx', child, root, mechanism, String(holdMs)], {
      cwd: repoRoot,
      env: { ...process.env, TSX_TSCONFIG_PATH: path.join(here, 'fixtures', 'tsconfig.child.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const exit = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
    const line = new Promise<string>((resolve, reject) => {
      proc.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes('\n')) resolve(out.trim());
      });
      proc.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
      void exit.then((code) => reject(new Error(`child exited (${String(code)}) without a status line: ${err}`)));
    });
    return { pid: proc.pid ?? -1, line, exit, kill: () => proc.kill('SIGKILL') };
  }

  for (const mechanism of MECHANISMS) {
    it(`refuses a second process, then hands over after a clean exit and after a kill: ${mechanism}`, { timeout: 60_000 }, async () => {
      const root = await tempRoot();
      const a = start(root, mechanism, 60_000);
      expect(await a.line).toMatch(/^acquired \d+ /);
      const b = start(root, mechanism, 0);
      expect(await b.line).toBe(`refused DATA_DIRECTORY_LOCKED ${a.pid}`);
      expect(await b.exit).toBe(3);
      a.kill();
      await a.exit;
      const c = start(root, mechanism, 300);
      expect(await c.line).toMatch(/^acquired \d+ /);
      expect(await c.exit).toBe(0); // clean exit releases the lock
      const d = start(root, mechanism, 0);
      expect(await d.line).toMatch(/^acquired \d+ /);
      expect(await d.exit).toBe(0);
      // Every accepted process wrote a complete template; nothing else was written.
      const handle = await openNodeTemplateManager(root);
      const listing = await handle.manager.list(asProjectId('projet-lock'));
      await handle.close();
      expect(listing.failures).toEqual([]);
      expect(listing.templates.length).toBe(3);
    });

    it(`lets exactly one of several simultaneous processes in: ${mechanism}`, { timeout: 90_000 }, async () => {
      for (let round = 0; round < 3; round++) {
        const root = await tempRoot();
        const children = Array.from({ length: 4 }, () => start(root, mechanism, 1500));
        const lines = await Promise.all(children.map((c) => c.line));
        await Promise.all(children.map((c) => c.exit));
        expect(lines.filter((l) => l.startsWith('acquired')).length, lines.join(' | ')).toBe(1);
        expect(lines.filter((l) => l.startsWith('refused DATA_DIRECTORY_LOCKED')).length).toBe(3);
        const handle = await openNodeTemplateManager(root);
        expect((await handle.manager.list(asProjectId('projet-lock'))).templates.length).toBe(1);
        await handle.close();
      }
    });
  }
});

describe('package boundaries', () => {
  it('depends on @geoplacer/core and pngjs only', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@geoplacer/core', 'pngjs']);
    expect(pkg.dependencies.pngjs).toBe('7.0.0');
  });
});
