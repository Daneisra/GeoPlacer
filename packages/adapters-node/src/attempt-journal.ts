/**
 * File attempt journal with checkpoints and generations (Phase 1B.7), and
 * the rotated history, under the locked data directory `<root>/journal/`:
 *
 *   CURRENT                         pointer to the generation in use
 *   attempts.log                    generation 0 (the journal of Phase 1B.6)
 *   attempts-<g>.log                events of generation g (after its checkpoint)
 *   checkpoint-<g>.ckpt             state at the start of generation g
 *   history-<n>.log                 history segments (history.log: Phase 1B.6)
 *
 * Load: the pointer gives the generation; its checkpoint is verified
 * (SHA-256, structure) before use, then the events of the generation are
 * streamed. No pointer while generation files exist is ambiguous: refused.
 * A generation above the pointer (interrupted compaction) is never read
 * for state. An unusable checkpoint falls back to the previous generation
 * when it is still kept, and is reported as damage; otherwise refused.
 *
 * Compaction: checkpoint and empty log of g+1 written (temp file, fsync,
 * rename, directory fsync where possible), read back and compared, then the
 * pointer is replaced the same way; only then are appends switched and the
 * retention applied. An interruption before the pointer leaves g in use and
 * orphan files of g+1, removed by the next compaction.
 *
 * Append: one complete line (short writes completed), fsync. A torn last
 * line is moved aside (`<log>.torn-<uuid>`) and cut off before the next
 * append; a damaged line before the end is kept and reported every time.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  AttemptJournal,
  CompactionReport,
  Hasher,
  HistoryEntry,
  HistoryQuery,
  HistoryStore,
  JournalEvent,
  JournalLoadReport,
  JournalState,
  JournalVisitor,
} from '@geoplacer/core';
import { JournalLineScanner, crc32, decodeCheckpoint, decodeChecksummedLines, encodeCheckpoint, encodeHistoryLine, encodeJournalLine, isHistoryEntry } from '@geoplacer/core';
import { nodeSha256Hasher } from './hasher.js';
import { nodeJournalFs, type AppendHandle, type JournalFs } from './journal-fs.js';
import type { DataDirectoryLock } from './lock.js';

const NEWLINE = 0x0a;
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export type JournalOpenErrorCode = 'NO_POINTER' | 'BAD_POINTER' | 'CHECKPOINT_UNUSABLE' | 'NOT_LOADED' | 'SEQUENCE_MISMATCH';

/** The journal cannot be opened without guessing: run the diagnostic. */
export class JournalOpenError extends Error {
  readonly code: JournalOpenErrorCode;

  constructor(code: JournalOpenErrorCode, message: string) {
    super(message);
    this.name = 'JournalOpenError';
    this.code = code;
  }
}

// ───────────────────────── Names ─────────────────────────

export const JOURNAL_DIR = 'journal';
export const POINTER_FILE = 'CURRENT';
const pad = (g: number): string => String(g).padStart(12, '0');
export const logName = (g: number): string => (g === 0 ? 'attempts.log' : `attempts-${pad(g)}.log`);
export const checkpointName = (g: number): string => `checkpoint-${pad(g)}.ckpt`;
const LOG_RE = /^attempts-(\d{12})\.log$/;
const CKPT_RE = /^checkpoint-(\d{12})\.ckpt$/;

/** Generations present on disk, by kind. */
export function generationsIn(names: readonly string[]): { readonly logs: number[]; readonly checkpoints: number[]; readonly legacyLog: boolean } {
  const logs: number[] = [];
  const checkpoints: number[] = [];
  for (const n of names) {
    const l = LOG_RE.exec(n);
    if (l) logs.push(Number(l[1]));
    const c = CKPT_RE.exec(n);
    if (c) checkpoints.push(Number(c[1]));
  }
  return { logs: logs.sort((a, b) => a - b), checkpoints: checkpoints.sort((a, b) => a - b), legacyLog: names.includes(logName(0)) };
}

// ───────────────────────── Pointer ─────────────────────────

const POINTER_HEAD = 'geoplacer-journal-pointer 1';

export function encodePointer(generation: number): Uint8Array {
  const body = `${POINTER_HEAD}\ngeneration ${generation}\n`;
  return enc(`${body}crc ${crc32(enc(body)).toString(16).padStart(8, '0')}\n`);
}

/** The generation of a pointer file, or null when it is not a valid pointer. */
export function decodePointer(bytes: Uint8Array): number | null {
  const text = dec(bytes);
  const m = /^geoplacer-journal-pointer 1\ngeneration (\d{1,15})\ncrc ([0-9a-f]{8})\n$/.exec(text);
  if (m === null) return null;
  const body = `${POINTER_HEAD}\ngeneration ${m[1]}\n`;
  return crc32(enc(body)) === Number.parseInt(m[2]!, 16) ? Number(m[1]) : null;
}

// ───────────────────────── Journal ─────────────────────────

export interface FileAttemptJournalOptions {
  readonly fs?: JournalFs;
  readonly hasher?: Hasher;
  /** Generations kept, the current one included (default 2: current + previous). */
  readonly retainGenerations?: number;
  /** Chunk size of the streaming reads (default 4 MiB). */
  readonly readChunkBytes?: number;
}

/** Where the last load and compaction stand (tests, diagnostic). */
export interface FileJournalStatus {
  readonly generation: number;
  readonly lastSeq: number;
  /** Files of generations above the pointer (interrupted compaction): ignored. */
  readonly orphans: readonly string[];
  readonly dirSync: 'synced' | 'unsupported' | 'not-attempted';
}

export class FileAttemptJournal implements AttemptJournal {
  private readonly lock: DataDirectoryLock;
  private readonly fs: JournalFs;
  private readonly hasher: Hasher;
  private readonly retain: number;
  private readonly chunkBytes: number;
  readonly dir: string;
  private loaded = false;
  private generation = 0;
  private lastSeq = 0;
  private orphans: string[] = [];
  private dirSync: FileJournalStatus['dirSync'] = 'not-attempted';
  private handle: AppendHandle | null = null;

  constructor(lock: DataDirectoryLock, options: FileAttemptJournalOptions = {}) {
    lock.assertHeld();
    this.lock = lock;
    this.fs = options.fs ?? nodeJournalFs;
    this.hasher = options.hasher ?? nodeSha256Hasher;
    this.retain = options.retainGenerations ?? 2;
    if (!Number.isSafeInteger(this.retain) || this.retain < 1) throw new Error('retainGenerations must be at least 1');
    this.chunkBytes = options.readChunkBytes ?? 4 * 1024 * 1024;
    this.dir = path.join(lock.root, JOURNAL_DIR);
  }

  /** Active log file (generation in use). */
  get file(): string {
    return path.join(this.dir, logName(this.generation));
  }

  status(): FileJournalStatus {
    return { generation: this.generation, lastSeq: this.lastSeq, orphans: [...this.orphans], dirSync: this.dirSync };
  }

  private at(name: string): string {
    return path.join(this.dir, name);
  }

  /** The generation in use according to the pointer (refuses the ambiguous cases). */
  private async pointedGeneration(names: readonly string[]): Promise<number> {
    if (!names.includes(POINTER_FILE)) {
      const { logs, checkpoints } = generationsIn(names);
      if (logs.length > 0 || checkpoints.length > 0) {
        throw new JournalOpenError('NO_POINTER', 'journal generation files exist without a CURRENT pointer: ambiguous, run the journal diagnostic');
      }
      return 0;
    }
    const g = decodePointer(await this.fs.readFile(this.at(POINTER_FILE)));
    if (g === null) throw new JournalOpenError('BAD_POINTER', 'the CURRENT pointer is unreadable: run the journal diagnostic');
    return g;
  }

  async load(visitor: JournalVisitor): Promise<JournalLoadReport> {
    this.lock.assertHeld();
    await this.closeHandle();
    const names = await this.fs.list(this.dir);
    const g = await this.pointedGeneration(names);
    const problems: string[] = [];
    const { logs, checkpoints } = generationsIn(names);
    this.orphans = [...logs.filter((x) => x > g).map(logName), ...checkpoints.filter((x) => x > g).map(checkpointName)];

    // Which checkpoint and logs give the state.
    let sources: number[] = [g];
    let checkpoint: JournalState | null = null;
    if (g > 0) {
      try {
        checkpoint = (await decodeCheckpoint(await this.fs.readFile(this.at(checkpointName(g))), this.hasher, g)).state;
      } catch (error) {
        const prev = g - 1;
        const prevUsable = names.includes(logName(prev)) && (prev === 0 || names.includes(checkpointName(prev)));
        if (!prevUsable) throw new JournalOpenError('CHECKPOINT_UNUSABLE', `checkpoint of generation ${g} unusable (${(error as Error).message}) and generation ${prev} not kept`);
        problems.push(`checkpoint of generation ${g} unusable: rebuilt from generation ${prev}`);
        sources = [prev, g];
        if (prev > 0) {
          try {
            checkpoint = (await decodeCheckpoint(await this.fs.readFile(this.at(checkpointName(prev))), this.hasher, prev)).state;
          } catch (inner) {
            throw new JournalOpenError('CHECKPOINT_UNUSABLE', `checkpoints of generations ${g} and ${prev} unusable (${(inner as Error).message})`);
          }
        }
      }
    }
    if (checkpoint !== null) visitor.checkpoint(checkpoint);
    let lastSeq = checkpoint?.lastSeq ?? 0;
    let sequenceGaps = 0;
    const corruptLines: number[] = [];
    let discardedTailBytes = 0;
    for (const source of sources) {
      const file = this.at(logName(source));
      const active = source === g;
      if ((await this.fs.size(file)) === null) {
        if (source > 0) problems.push(`log of generation ${source} missing`);
        continue;
      }
      const scanner = new JournalLineScanner((l) => {
        if (l.decoded === null) {
          if (active) corruptLines.push(l.line);
          else problems.push(`generation ${source}: damaged line ${l.line}`);
          return;
        }
        const { event, seq } = l.decoded;
        if (seq === null) {
          if (source !== 0) sequenceGaps++;
          lastSeq++;
        } else {
          if (seq !== lastSeq + 1) sequenceGaps++;
          lastSeq = Math.max(lastSeq, seq);
        }
        visitor.event(event, seq ?? lastSeq);
      });
      await this.fs.readChunks(file, (chunk) => scanner.push(chunk), this.chunkBytes);
      const tail = scanner.end();
      if (active) discardedTailBytes = tail;
      else if (tail > 0) problems.push(`generation ${source}: torn last line`);
    }
    this.generation = g;
    this.lastSeq = lastSeq;
    this.loaded = true;
    return { generation: g, fromCheckpoint: checkpoint !== null, lastSeq, discardedTailBytes, corruptLines, sequenceGaps, problems };
  }

  /** Moves a torn last line aside and cuts it off, so that no line ever follows it. */
  private async cutTornTail(file: string): Promise<void> {
    const size = await this.fs.size(file);
    if (size === null || size === 0) return;
    let end = size;
    let scanned = 0;
    for (;;) {
      const length = Math.min(64 * 1024, end);
      const start = end - length;
      const bytes = await this.fs.readRange(file, start, length);
      const nl = bytes.lastIndexOf(NEWLINE);
      if (nl !== -1) {
        end = start + nl + 1;
        break;
      }
      scanned += length;
      end = start;
      if (end === 0) break;
    }
    void scanned;
    if (end === size) return;
    const torn = await this.fs.readRange(file, end, size - end);
    await this.fs.writeNew(`${file}.torn-${randomUUID()}`, torn);
    await this.fs.truncate(file, end);
  }

  private async handleForAppend(): Promise<AppendHandle> {
    if (this.handle !== null) return this.handle;
    await this.fs.mkdir(this.dir);
    const file = this.file;
    await this.cutTornTail(file);
    this.handle = await this.fs.openAppend(file);
    return this.handle;
  }

  private async closeHandle(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    await handle?.close();
  }

  async append(event: JournalEvent): Promise<number> {
    this.lock.assertHeld();
    if (!this.loaded) throw new JournalOpenError('NOT_LOADED', 'load the journal before appending');
    const seq = this.lastSeq + 1;
    const handle = await this.handleForAppend();
    try {
      await handle.write(enc(encodeJournalLine(event, seq)));
      await handle.sync();
    } catch (error) {
      // The file may end with a partial line: reopen before the next append
      // so that it is moved aside and cut off, never followed by a new line.
      await this.closeHandle().catch(() => undefined);
      throw error;
    }
    this.lastSeq = seq;
    return seq;
  }

  private async syncDir(): Promise<void> {
    this.dirSync = await this.fs.syncDir(this.dir);
  }

  /** Durable replacement of `name` by `bytes`: temp file, fsync, rename, directory fsync. */
  private async replace(name: string, bytes: Uint8Array): Promise<void> {
    const temp = this.at(`${name}.tmp-${randomUUID()}`);
    try {
      await this.fs.writeNew(temp, bytes);
      await this.fs.rename(temp, this.at(name));
    } catch (error) {
      await this.fs.remove(temp).catch(() => undefined);
      throw error;
    }
    await this.syncDir();
  }

  async compact(state: JournalState): Promise<CompactionReport> {
    this.lock.assertHeld();
    if (!this.loaded) throw new JournalOpenError('NOT_LOADED', 'load the journal before compacting');
    if (state.lastSeq !== this.lastSeq) {
      throw new JournalOpenError('SEQUENCE_MISMATCH', `the state ends at event ${state.lastSeq}, the journal at ${this.lastSeq}: refused (events would be lost)`);
    }
    const previous = this.generation;
    const next = previous + 1;
    await this.fs.mkdir(this.dir);
    // A pointer always exists before any generation file: "no pointer but
    // generation files" then only comes from tampering, never from a crash.
    if ((await this.fs.size(this.at(POINTER_FILE))) === null) await this.replace(POINTER_FILE, encodePointer(previous));
    // Orphans of an interrupted compaction never win: removed first.
    for (const g of [next]) {
      await this.fs.remove(this.at(checkpointName(g)));
      await this.fs.remove(this.at(logName(g)));
    }
    const bytes = await encodeCheckpoint(next, state, this.hasher);
    await this.replace(checkpointName(next), bytes);
    await this.fs.writeNew(this.at(logName(next)), new Uint8Array(0));
    await this.syncDir();
    // Read back and compare before publishing.
    const readBack = await decodeCheckpoint(await this.fs.readFile(this.at(checkpointName(next))), this.hasher, next);
    if (JSON.stringify(readBack.state) !== JSON.stringify(JSON.parse(JSON.stringify(state)))) throw new Error('checkpoint read back differs from the state');
    // Publish. From the rename on, the pointer may already designate `next`:
    // on any failure, re-read it to know which generation is in use.
    await this.closeHandle();
    try {
      await this.replace(POINTER_FILE, encodePointer(next));
    } catch (error) {
      let inUse: number;
      try {
        inUse = await this.pointedGeneration(await this.fs.list(this.dir));
      } catch {
        // Unknown which generation is in use: no append until a new load.
        this.loaded = false;
        throw error;
      }
      if (inUse !== next) throw error;
    }
    this.generation = next;
    this.orphans = [];
    // Retention: only after the new generation is published.
    const removedGenerations: number[] = [];
    const retentionPending: number[] = [];
    const preserved = new Set(state.preservedGenerations);
    const { logs, checkpoints, legacyLog } = generationsIn(await this.fs.list(this.dir).catch(() => []));
    const old = new Set([...logs, ...checkpoints, ...(legacyLog ? [0] : [])].filter((g) => g <= next - this.retain && !preserved.has(g)));
    for (const g of [...old].sort((a, b) => a - b)) {
      try {
        const names = await this.fs.list(this.dir);
        for (const n of names) if (n === logName(g) || n === checkpointName(g) || n.startsWith(`${logName(g)}.torn-`)) await this.fs.remove(this.at(n));
        removedGenerations.push(g);
      } catch {
        retentionPending.push(g);
      }
    }
    return {
      previousGeneration: previous,
      generation: next,
      lastSeq: state.lastSeq,
      checkpointBytes: bytes.length,
      openAttempts: state.open.length,
      closedSummaries: state.closed.length,
      removedGenerations,
      retentionPending,
    };
  }

  close(): Promise<void> {
    return this.closeHandle();
  }
}

// ───────────────────────── History ─────────────────────────

export interface FileHistoryStoreOptions {
  readonly fs?: JournalFs;
  /** A new segment is started beyond this size (default 8 MiB). */
  readonly maxSegmentBytes?: number;
  /** Segments kept, oldest deleted first (default 8). */
  readonly maxSegments?: number;
}

const HISTORY_RE = /^history-(\d{12})\.log$/;
const historyName = (n: number): string => (n === 0 ? 'history.log' : `history-${pad(n)}.log`);

/**
 * History (statistics, interface): append-only segments, rotated by size,
 * the oldest deleted beyond `maxSegments`. Never the source of truth for
 * attempts (the journal is). Queries read the segments newest first and
 * stop once the limit is reached (no full load); damaged lines are
 * skipped and counted in `lastQueryCorruptLines`.
 */
export class FileHistoryStore implements HistoryStore {
  private readonly lock: DataDirectoryLock;
  private readonly fs: JournalFs;
  private readonly maxBytes: number;
  private readonly maxSegments: number;
  readonly dir: string;
  private handle: AppendHandle | null = null;
  private segment = -1;
  private segmentBytes = 0;
  lastQueryCorruptLines = 0;
  /** Segments read by the last query (tests: no full load). */
  lastQuerySegments = 0;

  constructor(lock: DataDirectoryLock, options: FileHistoryStoreOptions = {}) {
    lock.assertHeld();
    this.lock = lock;
    this.fs = options.fs ?? nodeJournalFs;
    this.maxBytes = options.maxSegmentBytes ?? 8 * 1024 * 1024;
    this.maxSegments = options.maxSegments ?? 8;
    if (!(this.maxBytes > 0) || !Number.isSafeInteger(this.maxSegments) || this.maxSegments < 1) throw new Error('invalid history rotation settings');
    this.dir = path.join(lock.root, JOURNAL_DIR);
  }

  /** Active segment file. */
  get file(): string {
    return path.join(this.dir, historyName(Math.max(0, this.segment)));
  }

  private async segments(): Promise<number[]> {
    const names = await this.fs.list(this.dir);
    const found = names.flatMap((n) => {
      const m = HISTORY_RE.exec(n);
      return m ? [Number(m[1])] : n === 'history.log' ? [0] : [];
    });
    return found.sort((a, b) => a - b);
  }

  private async closeHandle(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    await handle?.close();
  }

  async append(entry: HistoryEntry): Promise<void> {
    this.lock.assertHeld();
    const line = enc(encodeHistoryLine(entry));
    if (this.segment < 0) {
      await this.fs.mkdir(this.dir);
      const all = await this.segments();
      this.segment = all.at(-1) ?? 1;
      this.segmentBytes = (await this.fs.size(path.join(this.dir, historyName(this.segment)))) ?? 0;
    }
    if (this.segmentBytes > 0 && this.segmentBytes + line.length > this.maxBytes) {
      await this.closeHandle();
      this.segment = Math.max(this.segment, 0) + 1;
      this.segmentBytes = 0;
      const all = await this.segments();
      for (const old of all.slice(0, Math.max(0, all.length + 1 - this.maxSegments))) await this.fs.remove(path.join(this.dir, historyName(old)));
    }
    if (this.handle === null) {
      const file = this.file;
      const size = (await this.fs.size(file)) ?? 0;
      if (size > 0) {
        const last = await this.fs.readRange(file, size - 1, 1);
        if (last[0] !== NEWLINE) {
          // Torn last line: never followed by a new one (cut off, kept aside).
          const bytes = await this.fs.readFile(file);
          const end = bytes.lastIndexOf(NEWLINE) + 1;
          await this.fs.writeNew(`${file}.torn-${randomUUID()}`, bytes.subarray(end));
          await this.fs.truncate(file, end);
          this.segmentBytes = end;
        }
      }
      this.handle = await this.fs.openAppend(file);
    }
    try {
      await this.handle.write(line);
      await this.handle.sync();
      this.segmentBytes += line.length;
    } catch (error) {
      await this.closeHandle().catch(() => undefined);
      throw error;
    }
  }

  async query(q: HistoryQuery): Promise<readonly HistoryEntry[]> {
    const matches = (e: HistoryEntry): boolean => (q.templateId === undefined || e.templateId === q.templateId) && (q.agent === undefined || e.agent === q.agent) && (q.since === undefined || e.at >= q.since);
    const found: HistoryEntry[][] = [];
    let count = 0;
    let corrupt = 0;
    let read = 0;
    for (const n of (await this.segments()).reverse()) {
      if (count >= q.limit) break;
      let bytes: Uint8Array;
      try {
        bytes = await this.fs.readFile(path.join(this.dir, historyName(n)));
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') continue;
        throw error;
      }
      read++;
      const { values, corruptLines } = decodeChecksummedLines(bytes, isHistoryEntry);
      corrupt += corruptLines.length;
      const kept = values.filter(matches);
      found.unshift(kept);
      count += kept.length;
      // Older segments are entirely before `since` once this one starts before it.
      if (q.since !== undefined && values.length > 0 && values[0]!.at < q.since) break;
    }
    this.lastQueryCorruptLines = corrupt;
    this.lastQuerySegments = read;
    return found.flat().slice(-q.limit);
  }

  close(): Promise<void> {
    return this.closeHandle();
  }
}
