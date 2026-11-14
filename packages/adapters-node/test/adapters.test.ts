import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { Attempt, AttemptId, JournalEvent, ProjectId, TemplateId, TemplateManager } from '@geoplacer/core';
import {
  TemplateError,
  asProjectId,
  createTemplateManager,
  decodeChecksummedLines,
  decodeJournal,
  encodeJournalLine,
  isHistoryEntry,
  loadRandomOrder,
  random,
  rgb,
  transition,
} from '@geoplacer/core';
import {
  DataDirectoryLockedError,
  FileAttemptJournal,
  FileHistoryStore,
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

async function appendFileRaw(file: string, text: string): Promise<void> {
  await writeFile(file, text, { flag: 'a' });
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

describe('real process kill during writes', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = path.join(here, 'fixtures', 'kill-child.ts');
  const repoRoot = path.resolve(here, '..', '..', '..');

  function runAndKill(root: string, templateId: string | undefined, delayMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['--import', 'tsx', child, root, ...(templateId === undefined ? [] : [templateId])], {
        cwd: repoRoot,
        env: { ...process.env, TSX_TSCONFIG_PATH: path.join(here, 'fixtures', 'tsconfig.child.json') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      let id = templateId;
      proc.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const match = /ready (\S+)/.exec(out);
        if (match && id === undefined) id = match[1];
        if (match) setTimeout(() => proc.kill('SIGKILL'), delayMs);
      });
      proc.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
      proc.on('exit', (code, signal) => {
        if (id === undefined) reject(new Error(`child failed (code ${String(code)}): ${err}`));
        else if (signal === null && code !== null && code !== 0 && code !== 1) reject(new Error(`unexpected exit ${code}: ${err}`));
        else if (err.length > 0 && signal === null) reject(new Error(`child error: ${err}`));
        else resolve(id);
      });
    });
  }

  it('always reopens to a complete, verified revision', { timeout: 120_000 }, async () => {
    const root = await tempRoot();
    let id: string | undefined;
    const delays = [40, 75, 120, 180, 260, 33, 90, 150];
    for (const delayMs of delays) {
      // runAndKill resolves on the child's exit: the kernel has released its lock.
      id = await runAndKill(root, id, delayMs);
      const handle = await openNodeTemplateManager(root);
      try {
        const ref = { projectId: asProjectId('projet-kill'), templateId: id as TemplateId };
        const loaded = await handle.manager.load(ref);
        expect(loaded.report.problems).toEqual([]);
        const report = await handle.manager.verify(ref);
        expect(report.manifestSource).toBe('current');
        expect(report.revisions.every((r) => r.ok)).toBe(true);
      } finally {
        await handle.close();
      }
    }
    const last = await openNodeTemplateManager(root);
    const final = await last.manager.manifest({ projectId: asProjectId('projet-kill'), templateId: id as TemplateId });
    await last.close();
    // The children really wrote (not timing-sensitive: one write over the 8 runs is enough).
    expect(final.generation).toBeGreaterThan(1);
  });

  /** Runs repair-child and kills it after `delayMs` (it may finish first). */
  function repairAndKill(root: string, templateId: string, delayMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'fixtures', 'repair-child.ts'), root, templateId], {
        cwd: repoRoot,
        env: { ...process.env, TSX_TSCONFIG_PATH: path.join(here, 'fixtures', 'tsconfig.child.json') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready')) setTimeout(() => proc.kill('SIGKILL'), delayMs);
      });
      proc.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
      proc.on('exit', (code, signal) => (signal === null && code !== 0 ? reject(new Error(`repair child failed (${String(code)}): ${err}`)) : resolve()));
    });
  }

  it('never gives a revision number to two contents across kills, corruption and repairs killed midway', { timeout: 240_000 }, async () => {
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
    const delays = [60, 140, 35, 220, 90, 170];
    for (const [round, delayMs] of delays.entries()) {
      id = await runAndKill(root, id, delayMs); // writes revisions until killed
      const ref = { projectId: P_KILL, templateId: id as TemplateId };
      let handle = await openNodeTemplateManager(root);
      await record(handle.manager, ref);
      await handle.close();
      // Lose the current manifest (and the revision that may live only there).
      const manifestPath = path.join(root, 'projects', 'projet-kill', 'templates', id, 'manifest.json');
      await writeFile(manifestPath, '{"corrupt');
      await repairAndKill(root, id, [0, 2, 5, 10, 20, 50][round % 6]!); // repair, possibly killed midway
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

describe('attempt journal and history on disk', () => {
  const started = (id: string, at: number): JournalEvent => ({ type: 'started', attemptId: id as AttemptId, at });
  const leased = (id: string, at: number): JournalEvent => ({
    type: 'leased',
    attempt: {
      attemptId: id as AttemptId,
      agent: 'agent-1' as never,
      projectId: 'projet' as never,
      templateId: 'm' as never,
      revision: 1,
      writes: [{ taskId: `t-${id}` as never, point: { x: 1, y: 2 }, color: 0xff0000 as never }],
      energyCost: 1,
      state: 'leased',
      leasedAt: at,
      expiresAt: at + 10,
      startedAt: null,
      needsReconciliationAt: null,
      closedAt: null,
      results: [],
      reason: null,
    },
  });

  it('appends durable lines under the locked data directory and reads them back', async () => {
    const root = await tempRoot();
    const lock = await acquireDataDirectoryLock(root);
    locks.push(lock);
    const journal = new FileAttemptJournal(lock);
    expect(await journal.load()).toEqual({ events: [], discardedTailBytes: 0, corruptLines: [] });
    const events = [leased('a', 1), started('a', 2)];
    for (const e of events) await journal.append(e);
    expect(journal.file).toBe(path.join(root, 'journal', 'attempts.log'));
    expect(await readFile(journal.file, 'utf8')).toBe(events.map(encodeJournalLine).join(''));
    expect((await journal.load()).events).toEqual(events);
    await journal.close();
    expect(() => new FileAttemptJournal({ ...lock, assertHeld: () => { throw new Error('released'); } })).toThrow('released');
  });

  it('a torn last line is reported, moved aside and cut off before the next append; damage before the end is kept', async () => {
    const root = await tempRoot();
    const lock = await acquireDataDirectoryLock(root);
    locks.push(lock);
    const file = path.join(root, 'journal', 'attempts.log');
    await mkdir(path.dirname(file), { recursive: true });
    const torn = encodeJournalLine(started('a', 2)).slice(0, 17);
    await writeFile(file, encodeJournalLine(leased('a', 1)) + torn);
    const journal = new FileAttemptJournal(lock);
    expect(await journal.load()).toMatchObject({ events: [leased('a', 1)], discardedTailBytes: 17, corruptLines: [] });
    await journal.append(leased('b', 3));
    expect(await journal.load()).toEqual({ events: [leased('a', 1), leased('b', 3)], discardedTailBytes: 0, corruptLines: [] });
    const aside = (await readdir(path.dirname(file))).filter((n) => n.startsWith('attempts.log.torn-'));
    expect(aside).toHaveLength(1);
    expect(await readFile(path.join(path.dirname(file), aside[0]!), 'utf8')).toBe(torn);
    // Damage in the middle: reported on every load, never removed.
    const bytes = await readFile(file);
    bytes[20]! ^= 0x01;
    await writeFile(file, bytes);
    await journal.close();
    const reopened = new FileAttemptJournal(lock);
    await reopened.append(started('b', 4));
    const load = await reopened.load();
    expect(load).toMatchObject({ corruptLines: [1], discardedTailBytes: 0 });
    expect(load.events).toEqual([leased('b', 3), started('b', 4)]);
    expect((await readFile(file)).length).toBe(bytes.length + encodeJournalLine(started('b', 4)).length);
    await reopened.close();
  });

  it('a failed append (partial line written, then an error) never leaves damage before the end', async () => {
    const root = await tempRoot();
    const lock = await acquireDataDirectoryLock(root);
    locks.push(lock);
    const journal = new FileAttemptJournal(lock);
    await journal.append(leased('a', 1));
    // Fault injection on the real file handle: write 10 bytes, then fail.
    const handle = (journal as unknown as { lines: { handle: { write: (...args: unknown[]) => Promise<{ bytesWritten: number }> } } }).lines.handle;
    const realWrite = handle.write.bind(handle);
    handle.write = async (buffer: unknown) => {
      await realWrite((buffer as Buffer).subarray(0, 10), 0, 10, null);
      throw new Error('disk failure');
    };
    await expect(journal.append(started('a', 2))).rejects.toThrow('disk failure');
    expect((await journal.load()).discardedTailBytes).toBe(10);
    await journal.append(started('a', 3));
    expect(await journal.load()).toEqual({ events: [leased('a', 1), started('a', 3)], discardedTailBytes: 0, corruptLines: [] });
    expect((await readdir(path.dirname(journal.file))).filter((n) => n.startsWith('attempts.log.torn-'))).toHaveLength(1);
    await journal.close();
  });

  it('history: separate append-only file, filtered queries', async () => {
    const root = await tempRoot();
    const lock = await acquireDataDirectoryLock(root);
    locks.push(lock);
    const history = new FileHistoryStore(lock);
    const entry = (at: number, agent: string, templateId: string) => ({ at, agent: agent as never, templateId: templateId as never, revision: 1, attemptId: `a${at}` as never, state: 'finished' as const, applied: 1, alreadyCorrect: 0, rejected: 0, unknown: 0, observedCorrect: 0, observedIncorrect: 0 });
    for (const [i, [agent, t]] of [['x', 'm'], ['y', 'm'], ['x', 'n'], ['x', 'm']].entries()) await history.append(entry(i + 1, agent!, t!));
    expect((await history.query({ agent: 'x' as never, templateId: 'm' as never, limit: 10 })).map((e) => e.at)).toEqual([1, 4]);
    expect((await history.query({ since: 2, limit: 2 })).map((e) => e.at)).toEqual([3, 4]);
    await appendFileRaw(history.file, 'garbage\n');
    expect(await history.query({ limit: 10 })).toHaveLength(4);
    expect(history.lastQueryCorruptLines).toBe(1);
    expect(path.relative(root, history.file).split(path.sep)).toEqual(['journal', 'history.log']);
    await history.close();
  });

  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');

  /** Runs attempts-child until it is ready, kills it `delayMs` later; resolves with its recovery report. */
  function attemptsAndKill(root: string, base: number, delayMs: number): Promise<{ released: string[]; toReconcile: string[]; corruptLines: number[]; inconsistentEvents: number; discardedTailBytes: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'fixtures', 'attempts-child.ts'), root, String(base)], {
        cwd: repoRoot,
        env: { ...process.env, TSX_TSCONFIG_PATH: path.join(here, 'fixtures', 'tsconfig.child.json') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      let report: unknown;
      proc.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const match = /ready (\{.*\})\n/.exec(out);
        if (match && report === undefined) {
          report = JSON.parse(match[1]!);
          setTimeout(() => proc.kill('SIGKILL'), delayMs);
        }
      });
      proc.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
      proc.on('exit', (code, signal) => {
        if (report === undefined) reject(new Error(`attempts child failed (code ${String(code)}): ${err}`));
        else if (signal === null && code !== 0) reject(new Error(`attempts child exited ${String(code)}: ${err}`));
        else resolve(report as never);
      });
    });
  }

  it('real process kills during appends: the journal always replays without damage, uncertain attempts are reconciled', { timeout: 180_000 }, async () => {
    const root = await tempRoot();
    const delays = [50, 120, 30, 200, 80, 160, 45, 250];
    let reconciled = 0;
    let released = 0;
    for (const [round, delayMs] of delays.entries()) {
      const report = await attemptsAndKill(root, (round + 1) * 1_000_000_000, delayMs);
      // A process kill tears at most the last line: never damage before it.
      expect(report.corruptLines).toEqual([]);
      expect(report.inconsistentEvents).toBe(0);
      if (round > 0) {
        released += report.released.length;
        reconciled += report.toReconcile.length;
      }
      // Replay the file with the pure state machine: no invalid transition, no attempt twice.
      const bytes = await readFile(path.join(root, 'journal', 'attempts.log'));
      const load = decodeJournal(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      expect(load.corruptLines).toEqual([]);
      const attempts = new Map<string, Attempt>();
      for (const e of load.events) {
        const id = e.type === 'leased' ? e.attempt.attemptId : e.attemptId;
        const next = transition(attempts.get(id), e);
        expect(typeof next === 'string' ? next : 'ok').toBe('ok');
        attempts.set(id, next as Attempt);
      }
      // The history file is torn at most at its end too; every closed attempt in it is in the journal.
      const historyBytes = await readFile(path.join(root, 'journal', 'history.log'));
      const historyLoad = decodeChecksummedLines(new Uint8Array(historyBytes.buffer, historyBytes.byteOffset, historyBytes.byteLength), isHistoryEntry);
      expect(historyLoad.corruptLines).toEqual([]);
      for (const entry of historyLoad.values) expect(attempts.get(entry.attemptId)?.closedAt).not.toBeNull();
    }
    // The children left leased and started attempts behind at every kill: released and reconciled at restart.
    expect(released).toBeGreaterThan(0);
    expect(reconciled).toBeGreaterThan(0);
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
