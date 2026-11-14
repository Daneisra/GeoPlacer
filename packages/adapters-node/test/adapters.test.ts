import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProjectId, TemplateId } from '@geoplacer/core';
import { TemplateError, asProjectId, createTemplateManager, rgb } from '@geoplacer/core';
import { NodeTemplateStorage, createNodeTemplateManager, nodeSha256Hasher, pngjsCodec, randomIdSource, systemClock } from '../src/index.js';
import { rgbaPng, writePng } from '../../core/test/helpers/png.js';
import { storageConformance } from '../../core/test/helpers/storage-conformance.js';

const temps: string[] = [];
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'geoplacer-test-'));
  temps.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

storageConformance({ name: 'filesystem', make: async () => new NodeTemplateStorage(await tempRoot()), codec: pngjsCodec, hasher: nodeSha256Hasher });

const P = asProjectId('projet-a');
const palette = { id: 'p', colors: [{ rgb: rgb(0, 0, 0) }, { rgb: rgb(255, 255, 255) }, { rgb: rgb(255, 0, 0) }] };
const create = (root: string, extra: { sourcePng?: Uint8Array; projectId?: ProjectId } = {}) =>
  createNodeTemplateManager(root).create({
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
    const loaded = await createNodeTemplateManager(root).load({ projectId: P, templateId: t.id });
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
    await createNodeTemplateManager(root).revise({ projectId: P, templateId: t.id }, { palette: { id: 'p2', colors: [{ rgb: rgb(0, 0, 0) }, { rgb: rgb(255, 255, 255) }] } });
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
    expect(await new NodeTemplateStorage(root).listTemplates(P)).toEqual([t.id]);
    expect((await createNodeTemplateManager(root).list(P)).map((s) => s.templateId)).toEqual([t.id]);
  });

  it('rejects invalid ids, addresses and paths escaping the root', async () => {
    const storage = new NodeTemplateStorage(await tempRoot());
    await expect(storage.readManifest('..' as ProjectId, 'x' as TemplateId)).rejects.toThrow(/invalid project id/);
    await expect(storage.readManifest(P, '../../etc' as TemplateId)).rejects.toThrow(/invalid template id/);
    await expect(storage.readManifest(P, 'com1' as TemplateId)).rejects.toThrow(/invalid template id/);
    await expect(storage.readBlob(P, '../manifest')).rejects.toThrow(/invalid blob address/);
    await expect(storage.writeBlob(P, 'A'.repeat(64), new Uint8Array(1))).rejects.toThrow(/invalid blob address/);
  });

  it('detects files altered on disk and recovers from the backup manifest (read-only)', async () => {
    const root = await tempRoot();
    const t = await create(root);
    const m = createNodeTemplateManager(root);
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

  it('isolates projects on disk', async () => {
    const root = await tempRoot();
    const a = await create(root);
    await create(root, { projectId: asProjectId('projet-b') });
    await rm(path.join(root, 'projects', 'projet-b'), { recursive: true });
    expect((await createNodeTemplateManager(root).load({ projectId: P, templateId: a.id })).template.revision).toBe(1);
    expect(await createNodeTemplateManager(root).list(asProjectId('projet-b'))).toEqual([]);
  });

  it('uses random UUID ids and the system clock by default', async () => {
    const manager = createTemplateManager({ storage: new NodeTemplateStorage(await tempRoot()), hasher: nodeSha256Hasher, codec: pngjsCodec, ids: randomIdSource, clock: systemClock });
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
      id = await runAndKill(root, id, delayMs);
      const manager = createNodeTemplateManager(root);
      const ref = { projectId: asProjectId('projet-kill'), templateId: id as TemplateId };
      const loaded = await manager.load(ref);
      expect(loaded.report.problems).toEqual([]);
      const report = await manager.verify(ref);
      expect(report.manifestSource).toBe('current');
      expect(report.revisions.every((r) => r.ok)).toBe(true);
    }
    const final = await createNodeTemplateManager(root).manifest({ projectId: asProjectId('projet-kill'), templateId: id as TemplateId });
    expect(final.revisions.length).toBeGreaterThan(delays.length); // the children really wrote revisions
  });
});

describe('package boundaries', () => {
  it('depends on @geoplacer/core and pngjs only', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@geoplacer/core', 'pngjs']);
    expect(pkg.dependencies.pngjs).toBe('7.0.0');
  });
});
