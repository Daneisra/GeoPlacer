import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EngineService } from '../src/index.js';
import { cleanup, decodeRegion, tempDir, waitFor } from './helpers.js';

afterEach(cleanup);

const here = path.dirname(fileURLToPath(import.meta.url));
const child = path.join(here, 'fixtures', 'engine-child.ts');
const repoRoot = path.resolve(here, '..', '..', '..');
const childEnv = { ...process.env, TSX_TSCONFIG_PATH: path.join(here, 'fixtures', 'tsconfig.child.json') };

function runChild(dir: string, step: string, checkpointEvery: number | undefined, cooperative: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...childEnv, ...(checkpointEvery === undefined ? {} : { GP_WORLD_CHECKPOINT: String(checkpointEvery) }), ...(cooperative ? {} : { GP_COOPERATIVE: '0' }) };
    const proc = spawn(process.execPath, ['--import', 'tsx', child, dir, step], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
    proc.stderr.on('data', (c: Buffer) => (err += c.toString()));
    proc.on('error', reject);
    proc.on('exit', () => (out.includes('ready') ? resolve(out) : reject(new Error(`child failed: ${err}`))));
  });
}

describe('EngineService: a real process killed during a simulation, then a restart (Phase 1B.9)', () => {
  // Kills right after the n-th durable change of the world (before it becomes visible and before
  // the write answers), at several points of the run.
  // Then, with a world checkpoint every 6 changes, at the steps of an automatic checkpoint.
  // Phase 1C.0: whether a write is started while an automatic checkpoint is written depends on the
  // timing of two independent I/O sequences (the checkpoint, the next attempt's journal): it is not
  // guaranteed, with or without yields (failures shown on the Phase 1C.0 code in both modes; the
  // Phase 1B.9 version of this test required it, and was not re-measured on the older code). At a
  // checkpoint step an interrupted write is
  // therefore possible, not required. A kill during a durable append is always inside a write
  // (`appended`), and the checkpoint steps alone are covered by world-store.test.ts.
  // The checkpoint steps run with and without yields. In every case the restart must finish the
  // template with every pixel painted once and the energy spent once.
  // [step, checkpoint every, cooperative]
  const steps: [string, number | undefined, boolean][] = [
    ['appended#1', undefined, true],
    ['appended#4', undefined, true],
    ['appended#9', undefined, true],
  ];
  for (const cooperative of [false, true]) steps.push(['checkpoint-written#1', 6, cooperative], ['pointer-renamed#1', 6, cooperative], ['old-removed#2', 6, cooperative]);

  it('the restarted engine reconciles the interrupted write, finishes the template, and never spends energy twice', { timeout: 600_000 }, async () => {
    for (const [stepName, checkpointEvery, cooperative] of steps) {
      const step = `${stepName}${cooperative ? '' : ' (no yields)'}`;
      const dir = await tempDir();
      const out = await runChild(dir, stepName, checkpointEvery, cooperative);
      expect(out, step).toContain(`reached ${stepName}`);
      const [, templateId, paintable] = /ready (\S+) (\d+)/.exec(out)!;
      const service = await EngineService.open({ dataDir: dir, eventIntervalMs: 20 });
      try {
        const before = service.status();
        expect(before.selection?.templateId, step).toBe(templateId);
        expect(before.world.available, step).toBe(true);
        // A write interrupted by the kill is reconciled at the next start, never resent blindly
        // (always the case for a durable append; possible at a checkpoint step).
        if (stepName.startsWith('appended')) expect(before.journal.toReconcileAtStart, step).toBeGreaterThanOrEqual(1);
        await service.start();
        const done = await waitFor(service, (s) => s.state === 'completed' || s.state === 'error', 60_000);
        expect(done.state, `${step}: ${done.reason ?? ''}`).toBe('completed');
        // Every paintable pixel is right...
        const img = await service.templateImage(templateId!);
        const region = decodeRegion((await service.canvasRegion({ minX: img.x, minY: img.y, width: img.width, height: img.height })).data);
        const want = decodeRegion(img.data);
        expect(want.every((v, i) => v === -1 || region[i] === v), step).toBe(true);
        // ...and painted once: the energy spent is exactly one unit per pixel (no regeneration here).
        expect((await service.resourcesView()).energy, step).toBe(1000 - Number(paintable));
      } finally {
        await service.close();
      }
    }
  });
});
