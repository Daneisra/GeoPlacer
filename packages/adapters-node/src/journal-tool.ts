/**
 * Journal diagnostic and repair (Phase 1B.7).
 *
 * diagnoseJournal: STRICTLY READ-ONLY. No lock, no write, no append path
 * (which would cut a torn tail): it only lists and reads files. The report
 * holds file names relative to the data directory, sizes, SHA-256, line
 * numbers, offsets, sequence numbers and attempt ids; never raw bytes of a
 * damaged line nor free text (reasons) from the events.
 *
 * planJournalRepair: what a repair would do, and a plan id (SHA-256 of the
 * operations and of the digests of the journal files). Writes nothing.
 *
 * applyJournalRepair: requires the data directory lock and the plan id
 * shown to the user (the files must not have changed since), copies the
 * journal into a verified backup, applies the plan through the same publish
 * path as a compaction, and writes a trace. A damaged generation is never
 * deleted: it is preserved, and the new generation marks every open
 * attempt as needing reconciliation and requires a fresh canvas read
 * before any lease (all points, since a lost line may have been a lease).
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentId, Hasher, JournalState, Timestamp } from '@geoplacer/core';
import { JournalLineScanner, JournalStateBuilder, decodeCheckpoint, readCheckpointHeader } from '@geoplacer/core';
import { FileAttemptJournal, JOURNAL_DIR, JournalOpenError, POINTER_FILE, checkpointName, decodePointer, encodePointer, generationsIn, logName } from './attempt-journal.js';
import { nodeSha256Hasher } from './hasher.js';
import { nodeJournalFs, type JournalFs } from './journal-fs.js';
import type { DataDirectoryLock } from './lock.js';

export interface DiagnosedLine {
  readonly line: number;
  readonly offset: number;
  readonly length: number;
}

export interface GenerationDiagnosis {
  readonly generation: number;
  readonly log: {
    readonly name: string;
    readonly present: boolean;
    readonly lines: number;
    readonly corruptLines: readonly DiagnosedLine[];
    readonly tornTailBytes: number;
    readonly firstSeq: number | null;
    readonly lastSeq: number | null;
    /** Lines of Phase 1B.6 (no sequence number). */
    readonly unnumberedLines: number;
    readonly sequenceGaps: readonly { readonly line: number; readonly expected: number; readonly found: number }[];
  };
  readonly checkpoint: { readonly name: string; readonly present: boolean; readonly valid: boolean; readonly error: string | null; readonly lastSeq: number | null } | null;
}

export type JournalVerdict = 'empty' | 'healthy' | 'torn-tail' | 'damaged' | 'unreadable';

export interface JournalDiagnosis {
  readonly verdict: JournalVerdict;
  readonly pointer: { readonly present: boolean; readonly valid: boolean; readonly generation: number | null };
  /** Generation whose files give the state (null: cannot be decided). */
  readonly generationInUse: number | null;
  readonly files: readonly { readonly name: string; readonly bytes: number; readonly sha256: string }[];
  readonly generations: readonly GenerationDiagnosis[];
  /** Files of generations above the pointer (interrupted compaction): ignored for state. */
  readonly orphans: readonly string[];
  readonly state: {
    readonly lastSeq: number;
    readonly fromCheckpoint: number | null;
    readonly open: readonly { readonly attemptId: string; readonly agent: string; readonly state: string; readonly pixels: number }[];
    readonly closedSummaries: number;
    readonly canvasReadRequiredAfter: Timestamp | null;
    readonly inconsistentEvents: readonly { readonly generation: number; readonly line: number; readonly attemptId: string | null }[];
  } | null;
  /** Attempts whose state is uncertain because of the damage. */
  readonly affectedAttempts: readonly { readonly attemptId: string; readonly why: 'open-in-damaged-journal' | 'named-in-damaged-line' | 'inconsistent-event' }[];
  /** Canvas points read (best effort) in damaged lines: detail only, never trusted. */
  readonly pointsInDamagedLines: readonly string[];
  readonly problems: readonly string[];
  readonly recommendations: readonly string[];
}

export interface ToolOptions {
  readonly fs?: JournalFs;
  readonly hasher?: Hasher;
}

const at = (root: string, name: string): string => path.join(root, JOURNAL_DIR, name);
const SAFE_ID = /"attemptId":"([A-Za-z0-9._:-]{1,100})"/g;
const SAFE_POINT = /"point":\{"x":(-?\d{1,10}),"y":(-?\d{1,10})\}/g;

async function digestFiles(root: string, fs: JournalFs, hasher: Hasher): Promise<{ name: string; bytes: number; sha256: string }[]> {
  const names = (await fs.list(path.join(root, JOURNAL_DIR))).sort();
  const out: { name: string; bytes: number; sha256: string }[] = [];
  for (const name of names) {
    const size = await fs.size(at(root, name));
    if (size === null) continue; // vanished
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(at(root, name));
    } catch (error) {
      const c = (error as { code?: string }).code;
      if (c === 'EISDIR' || c === 'ENOENT' || c === 'EPERM') continue; // a directory (repairs/) or a vanished file
      throw error;
    }
    out.push({ name, bytes: size, sha256: await hasher.sha256Hex(bytes) });
  }
  return out;
}

/** Read-only diagnosis of `<root>/journal`. */
export async function diagnoseJournal(root: string, options: ToolOptions = {}): Promise<JournalDiagnosis> {
  const fs = options.fs ?? nodeJournalFs;
  const hasher = options.hasher ?? nodeSha256Hasher;
  const names = await fs.list(path.join(root, JOURNAL_DIR));
  const files = await digestFiles(root, fs, hasher);
  const { logs, checkpoints, legacyLog } = generationsIn(names);
  const problems: string[] = [];
  const recommendations: string[] = [];
  let pointer: JournalDiagnosis['pointer'] = { present: names.includes(POINTER_FILE), valid: false, generation: null };
  if (pointer.present) {
    const g = decodePointer(await fs.readFile(at(root, POINTER_FILE)));
    pointer = { present: true, valid: g !== null, generation: g };
    if (g === null) problems.push('CURRENT pointer unreadable');
  } else if (logs.length > 0 || checkpoints.length > 0) problems.push('generation files without a CURRENT pointer');
  const known = [...new Set([...(legacyLog ? [0] : []), ...logs, ...checkpoints])].sort((a, b) => a - b);
  if (known.length === 0 && !pointer.present) {
    return { verdict: 'empty', pointer, generationInUse: 0, files, generations: [], orphans: [], state: null, affectedAttempts: [], pointsInDamagedLines: [], problems, recommendations };
  }
  const inUse = pointer.valid ? pointer.generation! : !pointer.present && logs.length === 0 && checkpoints.length === 0 ? 0 : null;
  const orphans = inUse === null ? [] : names.filter((n) => [...logs.filter((g) => g > inUse).map(logName), ...checkpoints.filter((g) => g > inUse).map(checkpointName)].includes(n)).sort();

  // Every generation file is examined (not only the one in use).
  const generations: GenerationDiagnosis[] = [];
  const damagedIds = new Set<string>();
  const damagedPoints = new Set<string>();
  const checkpointStates = new Map<number, JournalState>();
  for (const g of known) {
    const logFile = logName(g);
    const present = names.includes(logFile);
    const corrupt: DiagnosedLine[] = [];
    const gaps: { line: number; expected: number; found: number }[] = [];
    let lines = 0;
    let firstSeq: number | null = null;
    let lastSeq: number | null = null;
    let unnumbered = 0;
    let torn = 0;
    if (present) {
      const scanner = new JournalLineScanner((l) => {
        lines++;
        if (l.decoded === null) {
          corrupt.push({ line: l.line, offset: l.offset, length: l.length });
          return;
        }
        if (l.decoded.seq === null) {
          unnumbered++;
          return;
        }
        if (lastSeq !== null && l.decoded.seq !== lastSeq + 1) gaps.push({ line: l.line, expected: lastSeq + 1, found: l.decoded.seq });
        firstSeq ??= l.decoded.seq;
        lastSeq = l.decoded.seq;
      });
      await fs.readChunks(at(root, logFile), (chunk) => scanner.push(chunk));
      torn = scanner.end();
      // Ids and points in damaged lines: best effort, as report detail only.
      for (const c of corrupt) {
        const text = new TextDecoder('latin1').decode(await fs.readRange(at(root, logFile), c.offset, c.length));
        for (const m of text.matchAll(SAFE_ID)) damagedIds.add(m[1]!);
        for (const m of text.matchAll(SAFE_POINT)) damagedPoints.add(`${m[1]},${m[2]}`);
      }
    }
    let checkpoint: GenerationDiagnosis['checkpoint'] = null;
    if (g > 0) {
      const name = checkpointName(g);
      if (!names.includes(name)) checkpoint = { name, present: false, valid: false, error: 'missing', lastSeq: null };
      else {
        const bytes = await fs.readFile(at(root, name));
        try {
          const decoded = await decodeCheckpoint(bytes, hasher, g);
          checkpointStates.set(g, decoded.state);
          checkpoint = { name, present: true, valid: true, error: null, lastSeq: decoded.state.lastSeq };
        } catch (error) {
          let lastSeqHeader: number | null = null;
          try {
            lastSeqHeader = readCheckpointHeader(bytes).header.lastSeq;
          } catch {
            // header unreadable too
          }
          checkpoint = { name, present: true, valid: false, error: (error as { code?: string }).code ?? 'unreadable', lastSeq: lastSeqHeader };
        }
      }
    }
    generations.push({ generation: g, log: { name: logFile, present, lines, corruptLines: corrupt, tornTailBytes: torn, firstSeq, lastSeq, unnumberedLines: unnumbered, sequenceGaps: gaps }, checkpoint });
  }

  // The state, rebuilt as the journal would (with the same fallback rule).
  let state: JournalDiagnosis['state'] = null;
  let damaged = problems.length > 0;
  if (inUse !== null) {
    const gen = (g: number): GenerationDiagnosis | undefined => generations.find((x) => x.generation === g);
    let sources = [inUse];
    let base: JournalState | null = null;
    let fromCheckpoint: number | null = null;
    if (inUse > 0) {
      if (checkpointStates.has(inUse)) {
        base = checkpointStates.get(inUse)!;
        fromCheckpoint = inUse;
      } else {
        damaged = true;
        problems.push(`checkpoint of generation ${inUse} unusable`);
        const prev = inUse - 1;
        if (gen(prev)?.log.present && (prev === 0 || checkpointStates.has(prev))) {
          sources = [prev, inUse];
          base = prev === 0 ? null : checkpointStates.get(prev)!;
          fromCheckpoint = prev === 0 ? null : prev;
          problems.push(`state rebuilt from generation ${prev}`);
        } else {
          problems.push('no earlier generation kept: the open attempts of the checkpoint are unknown');
        }
      }
    }
    const builder = base === null ? new JournalStateBuilder() : JournalStateBuilder.from(base);
    const inconsistent: { generation: number; line: number; attemptId: string | null }[] = [];
    let expected = (base?.lastSeq ?? 0) + 1;
    for (const g of sources) {
      const d = gen(g);
      if (d === undefined || !d.log.present) {
        if (g > 0) {
          damaged = true;
          problems.push(`log of generation ${g} missing`);
        }
        continue;
      }
      if (d.log.corruptLines.length > 0 || d.log.sequenceGaps.length > 0 || (g > 0 && d.log.unnumberedLines > 0)) damaged = true;
      if (d.log.firstSeq !== null && d.log.firstSeq !== expected) {
        damaged = true;
        problems.push(`generation ${g} starts at event ${d.log.firstSeq}, expected ${expected}`);
      }
      const scanner = new JournalLineScanner((l) => {
        if (l.decoded === null) return;
        const id = l.decoded.event.type === 'leased' ? l.decoded.event.attempt.attemptId : 'attemptId' in l.decoded.event ? l.decoded.event.attemptId : null;
        if (builder.apply(l.decoded.event, l.decoded.seq) !== null) inconsistent.push({ generation: g, line: l.line, attemptId: id });
      });
      await fs.readChunks(at(root, logName(g)), (chunk) => scanner.push(chunk));
      expected = builder.lastSeq + 1;
    }
    if (inconsistent.length > 0) damaged = true;
    const s = builder.toState();
    state = {
      lastSeq: s.lastSeq,
      fromCheckpoint,
      open: s.open.map((a) => ({ attemptId: a.attemptId, agent: a.agent, state: a.state, pixels: a.writes.length })),
      closedSummaries: s.closed.length,
      canvasReadRequiredAfter: s.canvasReadRequiredAfter,
      inconsistentEvents: inconsistent,
    };
  } else damaged = true;

  const active = inUse === null ? undefined : generations.find((x) => x.generation === inUse);
  const affected: JournalDiagnosis['affectedAttempts'][number][] = [];
  if (damaged && state !== null) for (const o of state.open) affected.push({ attemptId: o.attemptId, why: 'open-in-damaged-journal' });
  for (const id of damagedIds) if (!affected.some((a) => a.attemptId === id)) affected.push({ attemptId: id, why: 'named-in-damaged-line' });
  for (const e of state?.inconsistentEvents ?? []) if (e.attemptId !== null && !affected.some((a) => a.attemptId === e.attemptId)) affected.push({ attemptId: e.attemptId, why: 'inconsistent-event' });
  const verdict: JournalVerdict = inUse === null ? 'unreadable' : damaged ? 'damaged' : (active?.log.tornTailBytes ?? 0) > 0 ? 'torn-tail' : 'healthy';
  if (verdict === 'torn-tail') recommendations.push('torn last line: harmless, cut off at the next append (or by the repair)');
  if (verdict === 'damaged' || verdict === 'unreadable') recommendations.push('repair: open attempts become uncertain, a fresh canvas read is required before any lease; the damaged generation is preserved');
  if (orphans.length > 0) recommendations.push('orphan files of an interrupted compaction: ignored, removed by the next compaction');
  return { verdict, pointer, generationInUse: inUse, files, generations, orphans, state, affectedAttempts: affected, pointsInDamagedLines: [...damagedPoints].sort(), problems, recommendations };
}

// ───────────────────────── Repair ─────────────────────────

export type RepairOperation =
  | { readonly kind: 'backup'; readonly files: number }
  | { readonly kind: 'cut-torn-tail'; readonly generation: number; readonly bytes: number }
  | { readonly kind: 'restore-pointer'; readonly generation: number }
  | {
      readonly kind: 'new-generation';
      readonly from: number;
      readonly preserve: readonly number[];
      readonly openToReconcile: number;
      readonly canvasReadRequired: true;
      /** False when the open attempts of the damaged state cannot all be known (no earlier generation kept). */
      readonly stateCertain: boolean;
    };

export interface RepairPlan {
  readonly planId: string;
  readonly verdict: JournalVerdict;
  readonly operations: readonly RepairOperation[];
  readonly diagnosis: JournalDiagnosis;
}

export async function planJournalRepair(root: string, options: ToolOptions = {}): Promise<RepairPlan> {
  const hasher = options.hasher ?? nodeSha256Hasher;
  const diagnosis = await diagnoseJournal(root, options);
  const operations: RepairOperation[] = [];
  const active = diagnosis.generations.find((g) => g.generation === diagnosis.generationInUse);
  if (diagnosis.verdict === 'torn-tail') {
    operations.push({ kind: 'backup', files: diagnosis.files.length });
    operations.push({ kind: 'cut-torn-tail', generation: diagnosis.generationInUse!, bytes: active!.log.tornTailBytes });
  } else if (diagnosis.verdict === 'damaged' || diagnosis.verdict === 'unreadable') {
    operations.push({ kind: 'backup', files: diagnosis.files.length });
    let from = diagnosis.generationInUse;
    if (from === null) {
      // No usable pointer: the highest generation with a valid checkpoint (or 0).
      const valid = diagnosis.generations.filter((g) => g.generation === 0 || g.checkpoint?.valid === true).map((g) => g.generation);
      from = valid.at(-1) ?? 0;
      operations.push({ kind: 'restore-pointer', generation: from });
    }
    const stateCertain = !diagnosis.problems.some((p) => p.startsWith('no earlier generation kept')) && diagnosis.generationInUse !== null;
    const preserve = [...new Set([from, ...(from > 0 ? [from - 1] : [])])].sort((a, b) => a - b);
    operations.push({ kind: 'new-generation', from, preserve, openToReconcile: diagnosis.state?.open.length ?? 0, canvasReadRequired: true, stateCertain });
  }
  const planId = (await hasher.sha256Hex(new TextEncoder().encode(JSON.stringify({ operations, files: diagnosis.files })))).slice(0, 16);
  return { planId, verdict: diagnosis.verdict, operations, diagnosis };
}

export class JournalRepairError extends Error {
  constructor(
    readonly code: 'PLAN_CHANGED' | 'NOTHING_TO_DO' | 'BACKUP_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'JournalRepairError';
  }
}

export interface RepairResult {
  readonly planId: string;
  readonly backupDir: string;
  readonly tracePath: string;
  readonly generation: number;
  readonly openToReconcile: number;
}

/** Applies the plan `planId` (shown by planJournalRepair) under the lock: backup, repair, trace. */
export async function applyJournalRepair(lock: DataDirectoryLock, planId: string, options: ToolOptions & { readonly now: Timestamp }): Promise<RepairResult> {
  lock.assertHeld();
  const fs = options.fs ?? nodeJournalFs;
  const hasher = options.hasher ?? nodeSha256Hasher;
  const root = lock.root;
  const plan = await planJournalRepair(root, { fs, hasher });
  if (plan.planId !== planId) throw new JournalRepairError('PLAN_CHANGED', 'the journal changed since the plan was shown: plan again');
  if (plan.operations.length === 0) throw new JournalRepairError('NOTHING_TO_DO', 'the journal is healthy');
  const stamp = `${new Date(options.now).toISOString().replace(/[:.]/g, '-')}-${planId.slice(0, 8)}`;

  // 1. Verified backup of every journal file.
  const backupRel = path.join('journal-backups', stamp);
  const backupDir = path.join(root, backupRel);
  await fs.mkdir(backupDir);
  const sums: string[] = [];
  for (const f of plan.diagnosis.files) {
    const bytes = await fs.readFile(at(root, f.name));
    if ((await hasher.sha256Hex(bytes)) !== f.sha256) throw new JournalRepairError('PLAN_CHANGED', `${f.name} changed during the repair`);
    await fs.writeNew(path.join(backupDir, f.name), bytes);
    const copy = await fs.readFile(path.join(backupDir, f.name));
    if ((await hasher.sha256Hex(copy)) !== f.sha256) throw new JournalRepairError('BACKUP_MISMATCH', `backup of ${f.name} differs`);
    sums.push(`${f.sha256}  ${f.name}`);
  }
  await fs.writeNew(path.join(backupDir, 'SHA256SUMS'), new TextEncoder().encode(sums.join('\n') + '\n'));

  // 2. The operations.
  let generation = plan.diagnosis.generationInUse ?? 0;
  let openToReconcile = 0;
  for (const op of plan.operations) {
    if (op.kind === 'cut-torn-tail') {
      const file = at(root, logName(op.generation));
      const size = (await fs.size(file))!;
      const torn = await fs.readRange(file, size - op.bytes, op.bytes);
      await fs.writeNew(`${file}.torn-${randomUUID()}`, torn);
      await fs.truncate(file, size - op.bytes);
    } else if (op.kind === 'restore-pointer') {
      const temp = at(root, `${POINTER_FILE}.tmp-${randomUUID()}`);
      await fs.writeNew(temp, encodePointer(op.generation));
      await fs.rename(temp, at(root, POINTER_FILE));
      await fs.syncDir(path.join(root, JOURNAL_DIR));
      generation = op.generation;
    } else if (op.kind === 'new-generation') {
      // Same load and publish path as a compaction.
      const journal = new FileAttemptJournal(lock, { fs, hasher, retainGenerations: Number.MAX_SAFE_INTEGER });
      let builder = new JournalStateBuilder();
      try {
        await journal.load({ checkpoint: (s) => (builder = JournalStateBuilder.from(s)), event: (e, seq) => void builder.apply(e, seq) });
      } catch (error) {
        // Only the case the plan announced (checkpoint unusable, no earlier
        // generation): any other failure (I/O...) stops the repair, nothing published.
        if (op.stateCertain || !(error instanceof JournalOpenError) || error.code !== 'CHECKPOINT_UNUSABLE') throw error;
        builder = new JournalStateBuilder();
        const logFile = at(root, logName(op.from));
        if ((await fs.size(logFile)) !== null) {
          const scanner = new JournalLineScanner((l) => {
            if (l.decoded !== null) builder.apply(l.decoded.event, l.decoded.seq);
          });
          await fs.readChunks(logFile, (chunk) => scanner.push(chunk));
        }
        journal.prepareRepair(op.from, builder.lastSeq);
      }
      const state = builder.toState();
      const agents = new Set<AgentId>([...state.lastSpendAt.map((x) => x.agent), ...state.open.map((a) => a.agent)]);
      const repaired: JournalState = {
        ...state,
        lastSeq: journal.status().lastSeq,
        open: state.open.map((a) => (a.state === 'needs-reconciliation' ? a : { ...a, state: 'needs-reconciliation' as const, needsReconciliationAt: options.now, reason: 'repair: journal damaged' })),
        lastSpendAt: [...agents].sort().map((agent) => ({ agent, at: Math.max(options.now, state.lastSpendAt.find((x) => x.agent === agent)?.at ?? 0) })),
        canvasReadRequiredAfter: Math.max(options.now, state.canvasReadRequiredAfter ?? 0),
        preservedGenerations: [...new Set([...state.preservedGenerations, ...op.preserve])].sort((a, b) => a - b),
      };
      const report = await journal.compact(repaired);
      await journal.close();
      generation = report.generation;
      openToReconcile = repaired.open.length;
    }
  }

  // 3. Trace.
  const after = await digestFiles(root, fs, hasher);
  const traceRel = path.join(JOURNAL_DIR, 'repairs', `${stamp}.json`);
  await fs.mkdir(path.join(root, JOURNAL_DIR, 'repairs'));
  const trace = { planId, at: options.now, verdict: plan.verdict, operations: plan.operations, problems: plan.diagnosis.problems, affectedAttempts: plan.diagnosis.affectedAttempts, filesBefore: plan.diagnosis.files, filesAfter: after, backup: backupRel, generation };
  await fs.writeNew(path.join(root, traceRel), new TextEncoder().encode(JSON.stringify(trace, null, 2) + '\n'));
  return { planId, backupDir: backupRel, tracePath: traceRel, generation, openToReconcile };
}
