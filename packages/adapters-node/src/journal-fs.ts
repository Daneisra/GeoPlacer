/**
 * The file operations of the journal and the history (Phase 1B.7), behind a
 * small interface so that tests can make each call fail in turn.
 *
 * Durability: a file is written then fsynced before it is renamed into
 * place; the directory is fsynced after a rename or a creation where the
 * platform allows it (Linux). Windows does not allow fsync on a directory:
 * `syncDir` reports 'unsupported' and the rename relies on NTFS metadata
 * journaling. None of this is claimed to survive a power loss: only
 * process kills are tested.
 */

import { open, readdir, rename, stat, unlink, mkdir, type FileHandle } from 'node:fs/promises';

export interface AppendHandle {
  /** Writes all the bytes (short writes completed). */
  write(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface JournalFs {
  /** Size in bytes, or null when the file does not exist. */
  size(path: string): Promise<number | null>;
  /** Reads [start, start + length). */
  readRange(path: string, start: number, length: number): Promise<Uint8Array>;
  /** Reads the whole file by chunks (bounded memory). Throws ENOENT. */
  readChunks(path: string, onChunk: (chunk: Uint8Array) => void, chunkBytes?: number): Promise<void>;
  /** Whole file (small files: checkpoints, pointer). Throws ENOENT. */
  readFile(path: string): Promise<Uint8Array>;
  /** Names in a directory ([] when it does not exist). */
  list(dir: string): Promise<string[]>;
  mkdir(dir: string): Promise<void>;
  /** Creates `path` (must not exist), writes, fsyncs, closes. */
  writeNew(path: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a file; a missing file is not an error. */
  remove(path: string): Promise<void>;
  /** fsync of a directory, where the platform allows it. */
  syncDir(dir: string): Promise<'synced' | 'unsupported'>;
  openAppend(path: string): Promise<AppendHandle>;
  /** Cuts the file at `length` (separate read-write handle) and fsyncs it. */
  truncate(path: string, length: number): Promise<void>;
}

const code = (error: unknown): string | undefined => (error as { code?: string }).code;

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, null);
    if (bytesWritten <= 0) throw new Error('write made no progress');
    written += bytesWritten;
  }
}

export const nodeJournalFs: JournalFs = {
  async size(path) {
    try {
      return (await stat(path)).size;
    } catch (error) {
      if (code(error) === 'ENOENT') return null;
      throw error;
    }
  },
  async readRange(path, start, length) {
    const handle = await open(path, 'r');
    try {
      const out = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(out, read, length - read, start + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return out.subarray(0, read);
    } finally {
      await handle.close();
    }
  },
  async readChunks(path, onChunk, chunkBytes = 4 * 1024 * 1024) {
    const handle = await open(path, 'r');
    try {
      const buffer = new Uint8Array(chunkBytes);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, chunkBytes, null);
        if (bytesRead === 0) break;
        onChunk(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
  },
  async readFile(path) {
    const handle = await open(path, 'r');
    try {
      const bytes = await handle.readFile();
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } finally {
      await handle.close();
    }
  },
  async list(dir) {
    try {
      return await readdir(dir);
    } catch (error) {
      if (code(error) === 'ENOENT') return [];
      throw error;
    }
  },
  async mkdir(dir) {
    await mkdir(dir, { recursive: true });
  },
  async writeNew(path, bytes) {
    const handle = await open(path, 'wx');
    try {
      await writeAll(handle, bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async remove(path) {
    try {
      await unlink(path);
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
    }
  },
  async syncDir(dir) {
    if (process.platform === 'win32') return 'unsupported';
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
      return 'synced';
    } catch (error) {
      if (code(error) === 'EINVAL' || code(error) === 'EISDIR' || code(error) === 'EPERM') return 'unsupported';
      throw error;
    } finally {
      await handle.close();
    }
  },
  async openAppend(path) {
    const handle = await open(path, 'a');
    return {
      write: (bytes) => writeAll(handle, bytes),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  async truncate(path, length) {
    const handle = await open(path, 'r+');
    try {
      await handle.truncate(length);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};
