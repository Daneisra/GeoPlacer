/**
 * File attempt journal and history (Phase 1B.6), under the locked data
 * directory:
 *   <root>/journal/attempts.log   one checksummed event per line (core codec)
 *   <root>/journal/history.log    one checksummed history entry per line
 *
 * append: one write of a complete line, then fsync, before returning. A
 * crash during an append leaves at most a torn last line: on the next
 * open it is moved aside (<file>.torn-<uuid>) and cut off, so that new
 * lines never follow it. A damaged line before the end is never removed:
 * it is reported on every load (the core then reconciles every open
 * attempt). Durability after a power loss depends on the disk honouring
 * fsync and is not claimed beyond what the tests exercise (process kills).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { AttemptJournal, HistoryEntry, HistoryQuery, HistoryStore, JournalEvent, JournalLoad } from '@geoplacer/core';
import { decodeChecksummedLines, decodeJournal, encodeHistoryLine, encodeJournalLine, isHistoryEntry } from '@geoplacer/core';
import type { DataDirectoryLock } from './lock.js';

const NEWLINE = 0x0a;

/** An append-only file of complete lines, its torn tail cut off once before the first append. */
class LineFile {
  private readonly lock: DataDirectoryLock;
  readonly file: string;
  private handle: FileHandle | null = null;
  private opening: Promise<FileHandle> | null = null;
  /** Bytes of the torn tail moved aside by the last open (0: none). */
  movedTailBytes = 0;

  constructor(lock: DataDirectoryLock, name: string) {
    lock.assertHeld();
    this.lock = lock;
    this.file = path.join(lock.root, 'journal', name);
  }

  async read(): Promise<Uint8Array> {
    try {
      const bytes = await readFile(this.file);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return new Uint8Array(0);
      throw error;
    }
  }

  private async openForAppend(): Promise<FileHandle> {
    this.lock.assertHeld();
    await mkdir(path.dirname(this.file), { recursive: true });
    const bytes = await this.read();
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] !== NEWLINE) end--;
    if (end < bytes.length) {
      // Keep the torn bytes for inspection, then cut them off (a separate
      // read-write handle: Windows refuses to truncate an append handle).
      await writeFile(`${this.file}.torn-${randomUUID()}`, bytes.subarray(end), { flag: 'wx' });
      const cut = await open(this.file, 'r+');
      try {
        await cut.truncate(end);
        await cut.sync();
      } finally {
        await cut.close();
      }
      this.movedTailBytes = bytes.length - end;
    }
    return open(this.file, 'a');
  }

  private async handleForAppend(): Promise<FileHandle> {
    if (this.handle !== null) return this.handle;
    this.opening ??= this.openForAppend().then(
      (h) => (this.handle = h),
      (error: unknown) => {
        this.opening = null;
        throw error;
      },
    );
    return this.opening;
  }

  /** Durable before returning (fsync). Callers serialize their appends. */
  async append(line: string): Promise<void> {
    this.lock.assertHeld();
    const handle = await this.handleForAppend();
    await handle.write(line, null, 'ascii');
    await handle.sync();
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    this.opening = null;
    await handle?.close();
  }
}

export class FileAttemptJournal implements AttemptJournal {
  private readonly lines: LineFile;

  constructor(lock: DataDirectoryLock) {
    this.lines = new LineFile(lock, 'attempts.log');
  }

  get file(): string {
    return this.lines.file;
  }

  async load(): Promise<JournalLoad> {
    // Read what is on disk (a torn tail is reported, then cut off at the next append).
    return decodeJournal(await this.lines.read());
  }

  append(event: JournalEvent): Promise<void> {
    return this.lines.append(encodeJournalLine(event));
  }

  close(): Promise<void> {
    return this.lines.close();
  }
}

/**
 * History: append-only, separate from the journal (never compacted with
 * it). V1 queries read the whole file (no index); damaged lines are
 * skipped and counted in `lastQueryCorruptLines`.
 */
export class FileHistoryStore implements HistoryStore {
  private readonly lines: LineFile;
  lastQueryCorruptLines = 0;

  constructor(lock: DataDirectoryLock) {
    this.lines = new LineFile(lock, 'history.log');
  }

  get file(): string {
    return this.lines.file;
  }

  append(entry: HistoryEntry): Promise<void> {
    return this.lines.append(encodeHistoryLine(entry));
  }

  async query(q: HistoryQuery): Promise<readonly HistoryEntry[]> {
    const { values, corruptLines } = decodeChecksummedLines(await this.lines.read(), isHistoryEntry);
    this.lastQueryCorruptLines = corruptLines.length;
    return values
      .filter((e) => (q.templateId === undefined || e.templateId === q.templateId) && (q.agent === undefined || e.agent === q.agent) && (q.since === undefined || e.at >= q.since))
      .slice(-q.limit);
  }

  close(): Promise<void> {
    return this.lines.close();
  }
}
