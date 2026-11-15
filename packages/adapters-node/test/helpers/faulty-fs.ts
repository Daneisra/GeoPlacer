/**
 * Fault injection for the journal file operations: wraps a JournalFs and
 * makes the n-th call (counted while armed) fail, either before the
 * operation ('before'), after it ('after': done but reported failed), or,
 * for an append write, after writing half of the bytes ('partial').
 * Every call is recorded (operation and file name) for the step names of
 * the crash tests.
 */

import path from 'node:path';
import type { AppendHandle, JournalFs } from '../../src/index.js';

export type FaultMode = 'before' | 'after' | 'partial';

export interface FsCall {
  readonly op: string;
  readonly name: string;
}

export class FaultyFs implements JournalFs {
  armed = false;
  failAt = -1;
  mode: FaultMode = 'before';
  /** Calls made while armed. */
  count = 0;
  readonly calls: FsCall[] = [];
  /** Called before each operation (crash tests kill the process here). */
  onCall: ((call: FsCall, phase: 'before' | 'after') => void) | null = null;

  constructor(private readonly inner: JournalFs) {}

  private async run<T>(op: string, file: string, action: () => Promise<T>, partial?: () => Promise<void>): Promise<T> {
    const call = { op, name: path.basename(file) };
    this.calls.push(call);
    this.onCall?.(call, 'before');
    const fail = this.armed && this.count++ === this.failAt;
    if (fail && this.mode === 'before') throw new Error(`injected failure before ${op} ${call.name}`);
    if (fail && this.mode === 'partial' && partial !== undefined) {
      await partial();
      throw new Error(`injected partial ${op} ${call.name}`);
    }
    const result = await action();
    this.onCall?.(call, 'after');
    if (fail) throw new Error(`injected failure after ${op} ${call.name}`);
    return result;
  }

  size(p: string): Promise<number | null> {
    return this.run('size', p, () => this.inner.size(p));
  }
  readRange(p: string, start: number, length: number): Promise<Uint8Array> {
    return this.run('readRange', p, () => this.inner.readRange(p, start, length));
  }
  readChunks(p: string, onChunk: (chunk: Uint8Array) => void, chunkBytes?: number): Promise<void> {
    return this.run('readChunks', p, () => this.inner.readChunks(p, onChunk, chunkBytes));
  }
  readFile(p: string): Promise<Uint8Array> {
    return this.run('readFile', p, () => this.inner.readFile(p));
  }
  list(dir: string): Promise<string[]> {
    return this.run('list', dir, () => this.inner.list(dir));
  }
  mkdir(dir: string): Promise<void> {
    return this.run('mkdir', dir, () => this.inner.mkdir(dir));
  }
  writeNew(p: string, bytes: Uint8Array): Promise<void> {
    return this.run('writeNew', p, () => this.inner.writeNew(p, bytes));
  }
  rename(from: string, to: string): Promise<void> {
    return this.run('rename', to, () => this.inner.rename(from, to));
  }
  remove(p: string): Promise<void> {
    return this.run('remove', p, () => this.inner.remove(p));
  }
  syncDir(dir: string): Promise<'synced' | 'unsupported'> {
    return this.run('syncDir', dir, () => this.inner.syncDir(dir));
  }
  freeBytes(dir: string): Promise<number | null> {
    return this.run('freeBytes', dir, () => this.inner.freeBytes(dir));
  }
  truncate(p: string, length: number): Promise<void> {
    return this.run('truncate', p, () => this.inner.truncate(p, length));
  }
  async openAppend(p: string): Promise<AppendHandle> {
    const handle = await this.run('openAppend', p, () => this.inner.openAppend(p));
    return {
      write: (bytes) => this.run('write', p, () => handle.write(bytes), () => handle.write(bytes.subarray(0, Math.floor(bytes.length / 2)))),
      sync: () => this.run('sync', p, () => handle.sync()),
      close: () => handle.close(),
    };
  }
}
