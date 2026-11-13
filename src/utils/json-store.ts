/**
 * Crash-safe JSON persistence (no logger dependency, unit-tested).
 *
 * Write: serialise -> write a temp file in the same directory -> fsync ->
 * copy the current file to "<file>.bak" if it is valid JSON -> rename the temp
 * file over the target. A crash at any step leaves either the old or the new
 * complete file, never a truncated one.
 *
 * Read: a file that cannot be parsed is never silently replaced. It is moved
 * aside to "<file>.corrupt-<timestamp>" and the last valid backup is restored
 * when available. Orphan temp files from an interrupted write are removed.
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

export const BACKUP_SUFFIX = '.bak';
const TEMP_SUFFIX = '.tmp';

/** Error codes worth retrying for a rename on Windows (antivirus, indexer). */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from: string, to: string, attempts = 10): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= attempts || !RETRYABLE_RENAME_CODES.has(code)) throw error;
      sleepSync(20 * attempt);
    }
  }
}

function isValidJsonFile(file: string): boolean {
  try {
    JSON.parse(readFileSync(file, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

function tempPrefix(file: string): string {
  return `${path.basename(file)}.`;
}

/** Remove temp files left by an interrupted write of `file`. Returns their names. */
export function removeOrphanTempFiles(file: string): string[] {
  const dir = path.dirname(file);
  if (!existsSync(dir)) return [];
  const prefix = tempPrefix(file);
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(prefix) && name.endsWith(TEMP_SUFFIX)) {
      try {
        unlinkSync(path.join(dir, name));
        removed.push(name);
      } catch {
        // Best effort: a locked temp file is harmless and retried next time.
      }
    }
  }
  return removed;
}

export interface WriteJsonOptions {
  /** Keep the previous valid version as "<file>.bak" (default: true). */
  backup?: boolean;
}

/** Atomically replace `file` with the JSON serialisation of `data`. */
export function writeJsonAtomic(file: string, data: unknown, options: WriteJsonOptions = {}): void {
  const json = JSON.stringify(data, null, 2);
  if (json === undefined) throw new TypeError(`Refusing to write a non-serialisable value to ${file}`);

  const temp = path.join(
    path.dirname(file),
    `${tempPrefix(file)}${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}${TEMP_SUFFIX}`
  );

  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, json);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    // Only a valid file becomes the backup, so a corrupt file can never
    // overwrite the last good copy.
    if ((options.backup ?? true) && existsSync(file) && isValidJsonFile(file)) {
      copyFileSync(file, file + BACKUP_SUFFIX);
    }
    renameWithRetry(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // ignore: the orphan is removed on the next read
    }
    throw error;
  }
}

export type JsonLoadStatus = 'missing' | 'ok' | 'recovered-from-backup' | 'corrupt-no-backup';

export interface JsonLoadResult<T> {
  status: JsonLoadStatus;
  data: T;
  /** Where an unreadable file was moved, if any. */
  quarantinedTo?: string;
  /** Parse error of the primary file, if any. */
  error?: string;
  /** Orphan temp files removed before reading. */
  removedTempFiles: string[];
}

function timestampForFileName(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Read `file` as JSON with crash recovery. `fallback` provides the value
 * used when no valid data exists (missing file, or corrupt without backup).
 */
export function readJsonWithRecovery<T>(file: string, fallback: () => T): JsonLoadResult<T> {
  const removedTempFiles = removeOrphanTempFiles(file);
  const backup = file + BACKUP_SUFFIX;

  const readBackup = (): T | undefined => {
    if (!existsSync(backup)) return undefined;
    try {
      return JSON.parse(readFileSync(backup, 'utf8')) as T;
    } catch {
      return undefined;
    }
  };

  if (!existsSync(file)) {
    // The main file can only be missing after a crash if a backup exists
    // without it (rename failed after the backup copy): restore it.
    const fromBackup = readBackup();
    if (fromBackup !== undefined) {
      copyFileSync(backup, file);
      return { status: 'recovered-from-backup', data: fromBackup, removedTempFiles };
    }
    return { status: 'missing', data: fallback(), removedTempFiles };
  }

  try {
    return { status: 'ok', data: JSON.parse(readFileSync(file, 'utf8')) as T, removedTempFiles };
  } catch (parseError) {
    const quarantinedTo = `${file}.corrupt-${timestampForFileName()}`;
    renameWithRetry(file, quarantinedTo);
    const error = (parseError as Error).message;

    const fromBackup = readBackup();
    if (fromBackup !== undefined) {
      copyFileSync(backup, file);
      return { status: 'recovered-from-backup', data: fromBackup, quarantinedTo, error, removedTempFiles };
    }
    return { status: 'corrupt-no-backup', data: fallback(), quarantinedTo, error, removedTempFiles };
  }
}
