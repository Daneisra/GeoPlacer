import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { Attempt } from '@geoplacer/core';
import { createArraySnapshot } from '@geoplacer/core';
import { JournalRepairError, acquireDataDirectoryLock, applyJournalRepair, diagnoseJournal, nodeJournalFs, planJournalRepair, type DataDirectoryLock } from '../src/index.js';
import { FaultyFs } from './helpers/faulty-fs.js';
import { AGENT, checkpointName, journalFiles, logName, openHarness, openedJournals, runSteps } from './helpers/journal-scenario.js';

const temps: string[] = [];
const locks: DataDirectoryLock[] = [];
afterAll(async () => {
  await Promise.all(openedJournals.splice(0).map((j) => j.close()));
  await Promise.all(locks.splice(0).map((l) => l.release()));
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});
async function lockedRoot(): Promise<{ root: string; lock: DataDirectoryLock }> {
  const root = await mkdtemp(path.join(tmpdir(), 'geoplacer-jtool-'));
  temps.push(root);
  const lock = await acquireDataDirectoryLock(root);
  locks.push(lock);
  return { root, lock };
}
const jdir = (root: string): string => path.join(root, 'journal');

/** Every file of the data directory with its SHA-256 (lock file excluded: it belongs to the lock holder). */
async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || e.name === '.geoplacer.lock') continue;
    const rel = path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join('/');
    out[rel] = createHash('sha256').update(await readFile(path.join(root, rel))).digest('hex');
  }
  return out;
}

/** A journal with 2 generations, open attempts, and a damaged middle line naming an attempt (reason holds a marker). */
async function damagedJournal(): Promise<{ root: string; lock: DataDirectoryLock; open: string[]; marked: string }> {
  const { root, lock } = await lockedRoot();
  const h = openHarness(lock);
  await h.manager.recover(h.clock.now);
  await runSteps(h, 0, 16, 8);
  await runSteps(h, 16, 6);
  const marked = await h.manager.lease({ agent: AGENT, projectId: 'p' as never, templateId: 'm' as never, revision: 1, writes: [{ taskId: 'mk' as never, point: { x: 40, y: 40 }, color: 0xff0000 as never }], now: ++h.clock.now, ttlMs: 1e9 });
  await h.manager.fail(marked.attemptId, 'SECRET-MARKER-123', [], ++h.clock.now);
  await runSteps(h, 22, 4);
  // The damaged line below is the failure of `marked`: once lost, it is open again (to reconcile).
  const open = [...h.manager.open().map((a) => a.attemptId), marked.attemptId].sort();
  await h.journal.close();
  const file = path.join(jdir(root), logName(2));
  const lines = (await readFile(file, 'utf8')).split('\n');
  const target = lines.findIndex((l) => l.includes('SECRET-MARKER-123'));
  lines[target] = lines[target]!.replace('"failed"', '"failex"'); // CRC now wrong
  await writeFile(file, lines.join('\n'));
  return { root, lock, open, marked: marked.attemptId };
}

describe('journal diagnostic (read-only)', () => {
  it('describes a healthy journal and changes nothing in the data directory', async () => {
    const { root, lock } = await lockedRoot();
    const h = openHarness(lock);
    await h.manager.recover(h.clock.now);
    await runSteps(h, 0, 20, 8);
    await h.journal.close();
    const before = await tree(root);
    const fs = new FaultyFs(nodeJournalFs);
    const d = await diagnoseJournal(root, { fs });
    expect(await tree(root)).toEqual(before);
    expect(fs.calls.map((c) => c.op).filter((op) => !['list', 'size', 'readFile', 'readChunks', 'readRange'].includes(op))).toEqual([]);
    expect(d.verdict).toBe('healthy');
    expect(d.generationInUse).toBe(2);
    expect(d.state?.open.map((o) => o.attemptId).sort()).toEqual(h.manager.open().map((a) => a.attemptId).sort());
    expect(d.generations.map((g) => g.generation)).toEqual([0, 1, 2]);
    expect(d.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
  });

  it('locates damaged lines, sequence gaps and affected attempts without exposing contents or paths', async () => {
    const { root, open, marked } = await damagedJournal();
    const before = await tree(root);
    const d = await diagnoseJournal(root);
    expect(await tree(root)).toEqual(before);
    expect(d.verdict).toBe('damaged');
    const g2 = d.generations.find((g) => g.generation === 2)!;
    expect(g2.log.corruptLines).toHaveLength(1);
    expect(g2.log.sequenceGaps).toHaveLength(1);
    expect(d.affectedAttempts.filter((a) => a.why === 'open-in-damaged-journal').map((a) => a.attemptId).sort()).toEqual(open);
    // The id read in the damaged line is reported (once, here as an open attempt).
    expect(d.affectedAttempts.map((a) => a.attemptId)).toContain(marked);
    const text = JSON.stringify(d);
    expect(text).not.toContain('SECRET-MARKER-123');
    expect(text).not.toContain(root);
    expect(text).not.toContain(tmpdir());
  });

  it('reports orphans of an interrupted compaction, a missing pointer, an invalid checkpoint', async () => {
    const { root, lock } = await lockedRoot();
    const h = openHarness(lock);
    await h.manager.recover(h.clock.now);
    await runSteps(h, 0, 16, 8);
    await h.journal.close();
    await writeFile(path.join(jdir(root), checkpointName(3)), 'orphan');
    expect((await diagnoseJournal(root)).orphans).toEqual([checkpointName(3)]);
    const ckpt = await readFile(path.join(jdir(root), checkpointName(2)));
    ckpt[ckpt.length - 2]! ^= 1;
    await writeFile(path.join(jdir(root), checkpointName(2)), ckpt);
    const bad = await diagnoseJournal(root);
    expect(bad.verdict).toBe('damaged');
    expect(bad.generations.find((g) => g.generation === 2)!.checkpoint).toMatchObject({ valid: false, error: 'BAD_CHECKSUM' });
    await rm(path.join(jdir(root), 'CURRENT'));
    expect((await diagnoseJournal(root)).verdict).toBe('unreadable');
  });
});

describe('journal repair (plan, confirmation, backup, trace)', () => {
  it('repairs a damaged journal: open attempts to reconcile, canvas read required, damaged generation preserved', async () => {
    const { root, lock, open } = await damagedJournal();
    const plan = await planJournalRepair(root);
    expect(plan.operations.map((o) => o.kind)).toEqual(['backup', 'new-generation']);
    expect(plan.operations[1]).toMatchObject({ from: 2, preserve: [1, 2], openToReconcile: open.length, stateCertain: true });
    // Planning writes nothing; a wrong id is refused.
    await expect(applyJournalRepair(lock, '0000000000000000', { now: 5e12 })).rejects.toThrow(JournalRepairError);
    const result = await applyJournalRepair(lock, plan.planId, { now: 5e12 });
    expect(result.generation).toBe(3);
    // Verified backup and trace.
    const backup = path.join(root, result.backupDir);
    const sums = (await readFile(path.join(backup, 'SHA256SUMS'), 'utf8')).trim().split('\n');
    for (const line of sums) {
      const [hash, name] = line.split('  ');
      expect(createHash('sha256').update(await readFile(path.join(backup, name!))).digest('hex')).toBe(hash);
    }
    const trace = JSON.parse(await readFile(path.join(root, result.tracePath), 'utf8')) as { planId: string; operations: unknown[] };
    expect(trace.planId).toBe(plan.planId);
    expect(JSON.stringify(trace)).not.toContain('SECRET-MARKER-123');
    // The engine: not damaged any more, every open attempt to reconcile, no lease before a newer canvas read.
    const h = openHarness(lock, { idPrefix: 'after', base: 6e12 });
    const report = await h.manager.recover(++h.clock.now);
    expect(report).toMatchObject({ damaged: false, fromCheckpoint: true, generation: 3, damage: { at: 5e12, reason: 'journal repaired' } });
    expect([...report.toReconcile].sort()).toEqual(open);
    h.observe();
    const writes = [{ taskId: 'n' as never, point: { x: 63, y: 63 }, color: 0xff0000 as never }];
    const lease = (evidence?: ReturnType<typeof createArraySnapshot>) => h.manager.lease({ agent: AGENT, projectId: 'p' as never, templateId: 'm' as never, revision: 1, writes, now: ++h.clock.now, ttlMs: 10, ...(evidence === undefined ? {} : { evidence }) });
    await expect(lease()).rejects.toMatchObject({ code: 'EVIDENCE_REQUIRED' });
    // A recent read of another pixel does not cover the leased point; a read that covers it does.
    const elsewhere = createArraySnapshot({ rect: { minX: 0, minY: 0, width: 1, height: 1 }, coordinateSystem: { yAxis: 'down' }, source: 'simulated', observedAt: ++h.clock.now, pixels: new Int32Array(1).fill(-1) });
    await expect(lease(elsewhere)).rejects.toMatchObject({ code: 'EVIDENCE_REQUIRED' });
    const covering = createArraySnapshot({ rect: { minX: 63, minY: 63, width: 1, height: 1 }, coordinateSystem: { yAxis: 'down' }, source: 'simulated', observedAt: ++h.clock.now, pixels: new Int32Array(1).fill(-1) });
    await expect(lease(covering)).resolves.toMatchObject({ state: 'leased' });
    for (const id of report.toReconcile) expect((h.manager.get(id) as Attempt).state).toBe('needs-reconciliation');
    // Later compactions with the tightest retention never delete the preserved damaged generations.
    await h.journal.close();
    const tight = openHarness(lock, { idPrefix: 'tight', base: 7e12, retainGenerations: 1 });
    await tight.manager.recover(++tight.clock.now);
    await tight.manager.compact(++tight.clock.now);
    await tight.manager.compact(++tight.clock.now);
    const files = await journalFiles(root);
    expect(files.gens.logs).toEqual(expect.arrayContaining([1, 2]));
    expect(files.pointer).toBe(5);
    expect((await diagnoseJournal(root)).verdict).toBe('healthy');
    await tight.journal.close();
  });

  it('a torn tail only: the plan cuts it, and the journal is healthy after', async () => {
    const { root, lock } = await lockedRoot();
    const h = openHarness(lock);
    await h.manager.recover(h.clock.now);
    await runSteps(h, 0, 5);
    await h.journal.close();
    await writeFile(path.join(jdir(root), logName(0)), (await readFile(path.join(jdir(root), logName(0)), 'utf8')) + '0123abcd {"v":2,');
    const plan = await planJournalRepair(root);
    expect(plan.verdict).toBe('torn-tail');
    expect(plan.operations.map((o) => o.kind)).toEqual(['backup', 'cut-torn-tail']);
    await applyJournalRepair(lock, plan.planId, { now: 5e12 });
    expect((await diagnoseJournal(root)).verdict).toBe('healthy');
    expect((await readdir(jdir(root))).some((n) => n.startsWith('attempts.log.torn-'))).toBe(true);
  });

  it('no pointer, or an unusable checkpoint without earlier generation: rebuilt with uncertainty flagged', async () => {
    const { root, lock } = await lockedRoot();
    const h = openHarness(lock, { retainGenerations: 1 });
    await h.manager.recover(h.clock.now);
    await runSteps(h, 0, 24, 8);
    await runSteps(h, 24, 3);
    await h.journal.close();
    const ckpt = path.join(jdir(root), checkpointName(3));
    const bytes = await readFile(ckpt);
    bytes[bytes.length - 2]! ^= 1;
    await writeFile(ckpt, bytes);
    const plan = await planJournalRepair(root);
    expect(plan.operations[1]).toMatchObject({ kind: 'new-generation', stateCertain: false });
    const result = await applyJournalRepair(lock, plan.planId, { now: 5e12 });
    expect(result.generation).toBe(4);
    const m = openHarness(lock, { idPrefix: 'm', base: 6e12 });
    expect(await m.manager.recover(++m.clock.now)).toMatchObject({ damaged: false, damage: { at: 5e12 } });
    await m.journal.close();
    // Pointer removed: unreadable, then restored and repaired.
    await rm(path.join(jdir(root), 'CURRENT'));
    const plan2 = await planJournalRepair(root);
    expect(plan2.operations.map((o) => o.kind)).toEqual(['backup', 'restore-pointer', 'new-generation']);
    await applyJournalRepair(lock, plan2.planId, { now: 7e12 });
    const n = openHarness(lock, { idPrefix: 'n', base: 8e12 });
    expect(await n.manager.recover(++n.clock.now)).toMatchObject({ damaged: false, damage: { at: 7e12 } });
    await n.journal.close();
  });

  it('a journal changed after the plan was shown is refused', async () => {
    const { root, lock } = await damagedJournal();
    const plan = await planJournalRepair(root);
    await writeFile(path.join(jdir(root), logName(2)), (await readFile(path.join(jdir(root), logName(2)), 'utf8')) + '\n');
    await expect(applyJournalRepair(lock, plan.planId, { now: 5e12 })).rejects.toMatchObject({ code: 'PLAN_CHANGED' });
  });

  it('a failure at any file operation of the repair never loses an open attempt; planning again then succeeds', { timeout: 120_000 }, async () => {
    let reachedEnd = false;
    let failures = 0;
    for (let k = 0; !reachedEnd && k < 120; k++) {
      const { root, lock, open } = await damagedJournal();
      const fs = new FaultyFs(nodeJournalFs);
      const plan = await planJournalRepair(root);
      fs.armed = true;
      fs.failAt = k;
      fs.mode = 'after';
      const outcome = await applyJournalRepair(lock, plan.planId, { fs, now: 5e12 }).then(
        () => 'ok',
        (e: unknown) => String(e),
      );
      if (fs.count <= k) reachedEnd = true;
      // Most injected failures stop the repair (some, in a retried or optional step, do not): the invariant below holds either way.
      else if (outcome !== 'ok') failures++;
      // Whatever happened: the journal is diagnosable, the open attempts are all there.
      const d = await diagnoseJournal(root);
      expect(['damaged', 'healthy']).toContain(d.verdict);
      expect(d.state?.open.map((o) => o.attemptId).sort()).toEqual(open);
      if (d.verdict === 'damaged') {
        const again = await planJournalRepair(root);
        await applyJournalRepair(lock, again.planId, { now: 6e12 });
      }
      const m = openHarness(lock, { idPrefix: `f${k}`, base: 7e12 });
      const report = await m.manager.recover(++m.clock.now);
      expect({ k, damaged: report.damaged, reconcile: [...report.toReconcile].sort() }).toEqual({ k, damaged: false, reconcile: open });
      await m.journal.close();
    }
    expect(reachedEnd).toBe(true);
    expect(failures).toBeGreaterThan(20);
  });
});

describe('journal command line', () => {
  // Explicit budget, like every other test that starts child processes: four cold `node --import tsx`
  // starts take about 2.7 s on an idle machine, 11.7 s measured while an install saturated the CPU.
  it('diagnose is read-only and prints names relative to the data directory; repair without --apply changes nothing', { timeout: 60_000 }, async () => {
    const { root, lock } = await damagedJournal();
    await lock.release();
    locks.splice(locks.indexOf(lock), 1);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', path.join(here, '..', 'src', 'journal-cli.ts'), ...args], {
        cwd: path.resolve(here, '..', '..', '..'),
        env: { ...process.env, TSX_TSCONFIG_PATH: path.join(here, 'fixtures', 'tsconfig.child.json') },
        encoding: 'utf8',
      });
    const before = await tree(root);
    const diag = run(['diagnose', root]);
    expect(diag.status).toBe(1); // damaged
    expect(diag.stdout).toContain('verdict: damaged');
    expect(diag.stdout).not.toContain(root);
    const json = run(['diagnose', root, '--json']);
    expect((JSON.parse(json.stdout) as { verdict: string }).verdict).toBe('damaged');
    const plan = run(['repair', root]);
    expect(plan.status).toBe(0);
    expect(plan.stdout).toMatch(/plan id: [0-9a-f]{16}/);
    expect(await tree(root)).toEqual(before);
    const planId = /plan id: ([0-9a-f]{16})/.exec(plan.stdout)![1]!;
    const applied = run(['repair', root, '--apply', planId]);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain('repaired: generation 3');
    expect(run(['diagnose', root]).stdout).toContain('verdict: healthy');
  });
});


