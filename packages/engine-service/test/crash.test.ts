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

function runChild(dir: string, step: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', child, dir, step], { cwd: repoRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const steps = ['appended#1', 'appended#4', 'appended#9'];

  it('the restarted engine reconciles the interrupted write, finishes the template, and never spends energy twice', { timeout: 300_000 }, async () => {
    for (const step of steps) {
      const dir = await tempDir();
      const out = await runChild(dir, step);
      expect(out, step).toContain(`reached ${step}`);
      const [, templateId, paintable] = /ready (\S+) (\d+)/.exec(out)!;
      const service = await EngineService.open({ dataDir: dir, eventIntervalMs: 20 });
      try {
        const before = service.status();
        expect(before.selection?.templateId, step).toBe(templateId);
        expect(before.world.available, step).toBe(true);
        // The interrupted write was started: it is reconciled at the next start, never resent blindly.
        expect(before.journal.toReconcileAtStart, step).toBeGreaterThanOrEqual(1);
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
