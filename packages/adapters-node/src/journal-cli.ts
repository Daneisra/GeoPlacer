/**
 * Local journal tool (Phase 1B.7).
 *
 *   npm run journal:diagnose -- <data directory> [--json]
 *       read-only: no lock, no write
 *   npm run journal:repair -- <data directory>
 *       shows the repair plan and its id: writes nothing
 *   npm run journal:repair -- <data directory> --apply <plan id>
 *       takes the data directory lock (refused while the engine runs),
 *       checks that nothing changed since the plan, makes a verified backup,
 *       repairs, writes a trace under journal/repairs/
 *
 * Output: names relative to the data directory only; no raw damaged bytes,
 * no event reasons.
 */

import { acquireDataDirectoryLock } from './lock.js';
import { JournalRepairError, applyJournalRepair, diagnoseJournal, planJournalRepair, type JournalDiagnosis, type RepairPlan } from './journal-tool.js';

function summary(d: JournalDiagnosis): string {
  const lines = [`verdict: ${d.verdict}`, `pointer: ${d.pointer.present ? (d.pointer.valid ? `generation ${d.pointer.generation}` : 'unreadable') : 'absent'}`];
  for (const g of d.generations) {
    const ckpt = g.checkpoint === null ? '' : `, checkpoint ${g.checkpoint.valid ? 'valid' : `invalid (${g.checkpoint.error})`}`;
    lines.push(
      `generation ${g.generation}: ${g.log.present ? `${g.log.lines} lines, events ${g.log.firstSeq ?? '-'}..${g.log.lastSeq ?? '-'}` : 'no log'}${ckpt}` +
        (g.log.corruptLines.length > 0 ? `, damaged lines ${g.log.corruptLines.map((c) => `${c.line}@${c.offset}`).join(' ')}` : '') +
        (g.log.sequenceGaps.length > 0 ? `, sequence gaps at lines ${g.log.sequenceGaps.map((x) => x.line).join(' ')}` : '') +
        (g.log.tornTailBytes > 0 ? `, torn last line (${g.log.tornTailBytes} bytes)` : ''),
    );
  }
  if (d.orphans.length > 0) lines.push(`orphans: ${d.orphans.join(' ')}`);
  if (d.state !== null) lines.push(`state: ${d.state.open.length} open attempt(s), ${d.state.closedSummaries} closed summaries, last event ${d.state.lastSeq}${d.state.canvasReadRequiredAfter === null ? '' : ', canvas read required'}`);
  if (d.affectedAttempts.length > 0) lines.push(`affected attempts: ${d.affectedAttempts.map((a) => `${a.attemptId} (${a.why})`).join(', ')}`);
  for (const p of d.problems) lines.push(`problem: ${p}`);
  for (const r of d.recommendations) lines.push(`recommendation: ${r}`);
  return lines.join('\n');
}

function planText(plan: RepairPlan): string {
  if (plan.operations.length === 0) return 'nothing to repair';
  const ops = plan.operations.map((op, i) => {
    switch (op.kind) {
      case 'backup':
        return `${i + 1}. copy the ${op.files} journal files into journal-backups/ and verify them (SHA-256)`;
      case 'cut-torn-tail':
        return `${i + 1}. move the torn last line of generation ${op.generation} aside (${op.bytes} bytes) and cut it off`;
      case 'restore-pointer':
        return `${i + 1}. write the CURRENT pointer to generation ${op.generation}`;
      case 'new-generation':
        return `${i + 1}. publish a new generation from generation ${op.from}: ${op.openToReconcile} open attempt(s) to reconcile, a fresh canvas read required before any lease, generations ${op.preserve.join(', ')} preserved${op.stateCertain ? '' : ' (WARNING: the open attempts of the damaged checkpoint cannot all be known)'}`;
    }
  });
  return [...ops, `plan id: ${plan.planId}`, 'to apply: --apply <plan id> (the engine must be stopped)'].join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, root, ...rest] = argv;
  if ((command !== 'diagnose' && command !== 'repair') || root === undefined) {
    process.stderr.write('usage: journal-tool diagnose <data directory> [--json] | repair <data directory> [--apply <plan id>]\n');
    return 2;
  }
  const json = rest.includes('--json');
  if (command === 'diagnose') {
    const d = await diagnoseJournal(root);
    process.stdout.write(json ? `${JSON.stringify(d, null, 2)}\n` : `${summary(d)}\n`);
    return d.verdict === 'healthy' || d.verdict === 'empty' ? 0 : 1;
  }
  const applyAt = rest.indexOf('--apply');
  if (applyAt === -1) {
    const plan = await planJournalRepair(root);
    process.stdout.write(json ? `${JSON.stringify({ planId: plan.planId, operations: plan.operations, verdict: plan.verdict }, null, 2)}\n` : `${summary(plan.diagnosis)}\n\n${planText(plan)}\n`);
    return 0;
  }
  const planId = rest[applyAt + 1];
  if (planId === undefined) throw new Error('--apply needs the plan id');
  const lock = await acquireDataDirectoryLock(root);
  try {
    const result = await applyJournalRepair(lock, planId, { now: Date.now() });
    process.stdout.write(`repaired: generation ${result.generation}, ${result.openToReconcile} open attempt(s) to reconcile\nbackup: ${result.backupDir}\ntrace: ${result.tracePath}\n`);
    return 0;
  } catch (error) {
    if (error instanceof JournalRepairError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await lock.release();
  }
}

main(process.argv.slice(2)).then(
  (status) => {
    process.exitCode = status;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
    process.exitCode = 1;
  },
);
