import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentId, AttemptId, ResourceRules, Rgb, TaskId } from '@geoplacer/core';
import { TRANSPARENT } from '@geoplacer/core';
import { SimulatedCanvasProvider, type WorldCommit } from '@geoplacer/simulator';
import { FileWorldStore, WorldStoreError, type WorldIdentity } from '../src/index.js';

const A = 'agent-1' as AgentId;
const RED = 0xff0000 as Rgb;
const GREEN = 0x00ff00 as Rgb;
// SYNTHETIC rules (tests only).
const rules: ResourceRules = {
  schemaVersion: 1,
  id: 'world-test',
  version: 1,
  energy: { costPerPixel: 1, baseCapacity: 100, capacityLimit: 100, regenAmount: 1, regenIntervalMs: 1000, aboveCapacity: 'keep' },
  palette: { initialColors: [RED, GREEN], unlockable: [] },
  upgrades: { maxEnergy: [], regenSpeed: [], energyPack: { cost: 1, energy: 1, maxPurchases: 0 } },
  currency: { maxSpendPerOperation: 1 },
};
const identity: WorldIdentity = { bounds: { minX: 10, minY: 20, width: 16, height: 8 }, coordinateSystem: { yAxis: 'down' }, rules: { id: rules.id, version: rules.version } };

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'gp-world-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const now = 1_000_000;
const clock = { now: () => now };

/** A durable world: a fresh one, or the one saved in `dir`. */
async function openWorld(dir: string, id: WorldIdentity = identity): Promise<{ canvas: SimulatedCanvasProvider; store: FileWorldStore; restored: boolean }> {
  const opened = await FileWorldStore.open(dir, id);
  let store: FileWorldStore | null = opened.kind === 'restored' ? opened.store : null;
  const commit = (c: WorldCommit) => store!.append(c);
  const canvas = new SimulatedCanvasProvider({
    bounds: id.bounds,
    coordinateSystem: id.coordinateSystem,
    rules,
    clock,
    commit,
    trackEvents: false,
    ...(opened.kind === 'restored' ? { initial: opened.world } : {}),
  });
  if (store === null) {
    store = await canvas.withWorld((view) => FileWorldStore.create(dir, id, view));
    await canvas.setAgent({ agent: A, energy: 10, unlockedColors: [RED, GREEN] });
  }
  return { canvas, store, restored: opened.kind === 'restored' };
}

const write = (canvas: SimulatedCanvasProvider, k: number, color: Rgb, id = `a${k}`) =>
  canvas.writer.applyPixels(A, [{ taskId: `t${k}` as TaskId, point: { x: 10 + (k % 16), y: 20 + Math.floor(k / 16) }, color }], { attemptId: id as AttemptId });

describe('durable simulated world (Phase 1B.9)', () => {
  it('restores pixels and agent resources after a restart, with the energy spent exactly once', async () => {
    const dir = await tempDir();
    const first = await openWorld(dir);
    expect(first.restored).toBe(false);
    for (let k = 0; k < 6; k++) await write(first.canvas, k, k % 2 === 0 ? RED : GREEN);
    await first.canvas.editExternal([{ point: { x: 11, y: 20 }, color: TRANSPARENT }]);
    const before = await first.canvas.snapshot();
    const energyBefore = first.canvas.observe(A).energy;
    expect(energyBefore).toBe(4);
    await first.store.close();

    const second = await openWorld(dir);
    expect(second.restored).toBe(true);
    const after = await second.canvas.snapshot();
    for (let y = 20; y < 28; y++) for (let x = 10; x < 26; x++) expect(after.get({ x, y })).toBe(before.get({ x, y }));
    expect(after.get({ x: 11, y: 20 })).toBe(TRANSPARENT);
    expect(second.canvas.observe(A).energy).toBe(energyBefore);
    await second.store.close();
  });

  it('keeps the same world across checkpoints and removes the previous generation', async () => {
    const dir = await tempDir();
    const w = await openWorld(dir);
    await write(w.canvas, 0, RED);
    await w.canvas.withWorld((view) => w.store.checkpoint(view));
    await write(w.canvas, 1, GREEN);
    expect(w.store.generation).toBe(2);
    expect(w.store.recordsSinceCheckpoint).toBe(1);
    await w.store.close();
    expect((await readdir(dir)).sort()).toEqual(['CURRENT', 'world-2.ckpt', 'world-2.log']);
    const again = await openWorld(dir);
    expect(again.canvas.at({ x: 10, y: 20 })).toBe(RED);
    expect(again.canvas.at({ x: 11, y: 20 })).toBe(GREEN);
    expect(again.canvas.observe(A).energy).toBe(8);
    await again.store.close();
  });

  it('a commit that fails changes nothing: the write fails before applying, nothing is spent', async () => {
    const dir = await tempDir();
    const w = await openWorld(dir);
    await w.store.close(); // every later append fails
    await expect(write(w.canvas, 0, RED)).rejects.toThrow(WorldStoreError);
    expect(w.canvas.at({ x: 10, y: 20 })).toBe(TRANSPARENT);
    expect(w.canvas.observe(A).energy).toBe(10);
  });

  it('cuts a torn last line (a change never made visible) and keeps the rest', async () => {
    const dir = await tempDir();
    const w = await openWorld(dir);
    await write(w.canvas, 0, RED);
    await w.store.close();
    await appendFile(path.join(dir, 'world-1.log'), '0123abcd {"seq":3,"kind":"wri');
    const opened = await FileWorldStore.open(dir, identity);
    expect(opened.kind).toBe('restored');
    if (opened.kind !== 'restored') return;
    expect(opened.report.tornTailCut).toBe(true);
    expect(opened.report.replayed).toBe(2); // agent configured, then the write
    await opened.store.close();
    const log = await readFile(path.join(dir, 'world-1.log'), 'utf8');
    expect(log.endsWith('\n')).toBe(true);
    expect(log.split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('refuses a damaged line followed by others, a damaged checkpoint, a missing pointer: explicit reset needed', async () => {
    const dir = await tempDir();
    const w = await openWorld(dir);
    await write(w.canvas, 0, RED);
    await write(w.canvas, 1, GREEN);
    await w.store.close();
    const logFile = path.join(dir, 'world-1.log');
    const lines = (await readFile(logFile, 'utf8')).split('\n');
    lines[1] = lines[1]!.replace('"seq":2', '"seq":9');
    await writeFile(logFile, lines.join('\n'));
    await expect(FileWorldStore.open(dir, identity)).rejects.toMatchObject({ code: 'WORLD_DAMAGED' });

    const dir2 = await tempDir();
    const w2 = await openWorld(dir2);
    await w2.store.close();
    const ckpt = path.join(dir2, 'world-1.ckpt');
    const bytes = await readFile(ckpt);
    bytes.writeUInt8(bytes[bytes.length - 1]! ^ 0xff, bytes.length - 1);
    await writeFile(ckpt, bytes);
    await expect(FileWorldStore.open(dir2, identity)).rejects.toMatchObject({ code: 'WORLD_DAMAGED' });

    const dir3 = await tempDir();
    const w3 = await openWorld(dir3);
    await w3.store.close();
    await rm(path.join(dir3, 'CURRENT'));
    await expect(FileWorldStore.open(dir3, identity)).rejects.toMatchObject({ code: 'WORLD_DAMAGED' });
  });

  it('refuses a world saved for another canvas or other rules', async () => {
    const dir = await tempDir();
    const w = await openWorld(dir);
    await w.store.close();
    await expect(FileWorldStore.open(dir, { ...identity, bounds: { ...identity.bounds, width: 32 } })).rejects.toMatchObject({ code: 'WORLD_IDENTITY_MISMATCH' });
    await expect(FileWorldStore.open(dir, { ...identity, rules: { id: rules.id, version: 2 } })).rejects.toMatchObject({ code: 'WORLD_IDENTITY_MISMATCH' });
    await expect(FileWorldStore.open(dir, { ...identity, coordinateSystem: { yAxis: 'up' } })).rejects.toMatchObject({ code: 'WORLD_IDENTITY_MISMATCH' });
  });

  it('removes the leftovers of an interrupted checkpoint (files of another generation)', async () => {
    const dir = await tempDir();
    const w = await openWorld(dir);
    await w.store.close();
    await writeFile(path.join(dir, 'world-2.ckpt'), 'partial');
    await writeFile(path.join(dir, 'CURRENT.tmp'), 'partial');
    const opened = await FileWorldStore.open(dir, identity);
    expect(opened.kind).toBe('restored');
    if (opened.kind !== 'restored') return;
    expect(opened.report.removed).toEqual(['world-2.ckpt']);
    await opened.store.close();
    expect((await readdir(dir)).sort()).toEqual(['CURRENT', 'world-1.ckpt', 'world-1.log']);
  });
});

describe('durable simulated world: real process kills at named steps (no timer)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = path.join(here, 'fixtures', 'world-child.ts');
  const repoRoot = path.resolve(here, '..', '..', '..');
  const childEnv = { ...process.env, TSX_TSCONFIG_PATH: path.join(here, 'fixtures', 'tsconfig.child.json') };

  function run(dir: string, step: string): Promise<{ out: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['--import', 'tsx', child, dir, step], { cwd: repoRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
      proc.stderr.on('data', (c: Buffer) => (err += c.toString()));
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (!out.includes('ready')) reject(new Error(`child failed before ready: ${err}`));
        else resolve({ out: `${out}${err === '' ? '' : `
stderr: ${err}`}`, code });
      });
    });
  }

  const acked = (out: string): number => Math.max(-1, ...[...out.matchAll(/acked (\d+)/g)].map((m) => Number(m[1])));

  // Each named step of the store, at several occurrences (inside the run of writes and checkpoints).
  const steps = ['appended#3', 'appended#6', 'checkpoint-written#1', 'log-created#1', 'pointer-written#1', 'pointer-renamed#1', 'old-removed#1', 'checkpoint-written#3', 'pointer-renamed#4'];

  it('after a kill at each step, the world reopens to every acknowledged write, at most one more, in order; then completes', { timeout: 300_000 }, async () => {
    const childIdentity: WorldIdentity = { bounds: { minX: 0, minY: 0, width: 8, height: 8 }, coordinateSystem: { yAxis: 'down' }, rules: { id: 'world-child', version: 1 } };
    for (const step of steps) {
      const dir = await tempDir();
      const killed = await run(dir, step);
      expect(killed.out, step).toContain(`reached ${step}`);
      const last = acked(killed.out);
      const opened = await FileWorldStore.open(dir, childIdentity);
      expect(opened.kind, step).toBe('restored');
      if (opened.kind !== 'restored') continue;
      const painted = [...opened.world.pixels].map((v, k) => (v === TRANSPARENT ? -1 : v === k + 1 ? k : -2));
      expect(painted.includes(-2), `${step}: a pixel with a wrong color`).toBe(false);
      const count = painted.filter((v) => v >= 0).length;
      // A prefix: every acknowledged write, plus at most the one in flight.
      expect(painted.slice(0, count).every((v, k) => v === k), `${step}: not a prefix`).toBe(true);
      expect(count, step).toBeGreaterThanOrEqual(last + 1);
      expect(count, step).toBeLessThanOrEqual(last + 2);
      // Energy spent exactly once per applied pixel.
      expect(opened.world.agents.find((a) => a.agent === 'agent-1')?.energy, step).toBe(1000 - count);
      await opened.store.close();
      // The run resumes after the restored prefix and completes.
      const resumed = await run(dir, 'never#1');
      expect(resumed.out, step).toContain(`ready ${count}`);
      expect(resumed.out, step).toContain('done');
    }
  });
});
