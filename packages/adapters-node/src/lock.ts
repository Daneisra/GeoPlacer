/**
 * Exclusive lock on a data directory: one GeoPlacer instance at a time.
 *
 * The manifest compare-and-swap is serialized inside ONE process only; two
 * processes writing the same data directory could both pass the check. The
 * lock therefore makes a second instance fail at startup, before any write.
 *
 * Mechanisms:
 * - 'windows-share-lock' (default on Windows): `<root>/.geoplacer.lock` is
 *   held open with an exclusive share mode (libuv UV_FS_O_EXLOCK). The kernel
 *   refuses any other open, from this process or another, and releases the
 *   lock when the process exits or is killed: no stale lock is possible.
 * - 'pid-file' (default elsewhere): `<root>/.geoplacer.lock` is created
 *   exclusively ('wx') and holds the owner's pid, host and a random token. A
 *   lock whose owner process no longer exists on this host is taken over.
 *   Best effort: the takeover of a stale lock is not atomic against another
 *   instance taking it over at the same instant (see docs/fr/modeles.md).
 *
 * The owner (pid, start time) is also written to `<root>/.geoplacer.lock.owner`
 * so that a refused instance can say who holds the directory.
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

/** libuv flag (not exported by node:fs): open with share mode 0 on Windows. */
const UV_FS_O_EXLOCK = 0x10000000;
const LOCK = '.geoplacer.lock';
const OWNER = '.geoplacer.lock.owner';

export type LockMechanism = 'windows-share-lock' | 'pid-file';

export interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
  readonly token: string;
}

export class DataDirectoryLockedError extends Error {
  readonly code = 'DATA_DIRECTORY_LOCKED';
  /** Owner as recorded by the holder (null when unknown). */
  readonly owner: { readonly pid: number; readonly startedAt: string } | null;

  constructor(owner: { pid: number; startedAt: string } | null) {
    super(
      owner === null
        ? 'the data directory is already used by another GeoPlacer instance'
        : `the data directory is already used by another GeoPlacer instance (pid ${owner.pid}, started ${owner.startedAt})`
    );
    this.name = 'DataDirectoryLockedError';
    this.owner = owner;
  }
}

export interface DataDirectoryLock {
  /** Absolute data directory. */
  readonly root: string;
  readonly mechanism: LockMechanism;
  readonly held: boolean;
  /** Throws when the lock has been released: no write may happen without it. */
  assertHeld(): void;
  release(): Promise<void>;
}

export interface LockOptions {
  /** Default: 'windows-share-lock' on Windows, 'pid-file' elsewhere. */
  readonly mechanism?: LockMechanism;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

async function readOwner(file: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Partial<LockOwner>;
    if (typeof value.pid !== 'number' || typeof value.host !== 'string' || typeof value.token !== 'string') return null;
    return { pid: value.pid, host: value.host, startedAt: String(value.startedAt), token: value.token };
  } catch {
    return null;
  }
}

/** True when `pid` is alive on this host (EPERM: alive but not ours). */
function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function makeLock(root: string, mechanism: LockMechanism, onRelease: () => Promise<void>): DataDirectoryLock {
  let held = true;
  let releasing: Promise<void> | null = null;
  return {
    root,
    mechanism,
    get held() {
      return held;
    },
    assertHeld() {
      if (!held) throw new Error('the data directory lock has been released: writes are refused');
    },
    release() {
      if (releasing === null) {
        held = false;
        releasing = onRelease();
      }
      return releasing;
    },
  };
}

async function acquireShareLock(root: string, owner: LockOwner): Promise<DataDirectoryLock> {
  let handle: FileHandle;
  try {
    handle = await open(path.join(root, LOCK), constants.O_RDWR | constants.O_CREAT | UV_FS_O_EXLOCK);
  } catch (error) {
    if (errorCode(error) === 'EBUSY') throw new DataDirectoryLockedError(await readOwner(path.join(root, OWNER)));
    throw error;
  }
  await writeFile(path.join(root, OWNER), `${JSON.stringify(owner)}\n`);
  return makeLock(root, 'windows-share-lock', async () => {
    await rm(path.join(root, OWNER), { force: true });
    await handle.close();
  });
}

async function acquirePidFile(root: string, owner: LockOwner): Promise<DataDirectoryLock> {
  const file = path.join(root, LOCK);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await writeFile(path.join(root, OWNER), `${JSON.stringify(owner)}\n`);
      return makeLock(root, 'pid-file', async () => {
        // Only remove the lock if it is still ours.
        if ((await readOwner(file))?.token === owner.token) await rm(file, { force: true });
        await rm(path.join(root, OWNER), { force: true });
      });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const existing = await readOwner(file);
    if (existing !== null && (existing.host !== owner.host || processAlive(existing.pid))) {
      throw new DataDirectoryLockedError({ pid: existing.pid, startedAt: existing.startedAt });
    }
    // Stale (dead owner on this host) or unreadable (crash while creating it):
    // move it aside, then check that we moved the file we judged stale.
    const aside = `${file}.stale-${randomUUID()}`;
    try {
      await rename(file, aside);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
    const moved = await readOwner(aside);
    if (existing !== null && moved?.token !== existing.token) {
      // Another instance replaced it in between: give it back and refuse.
      await rename(aside, file).catch(() => undefined);
      throw new DataDirectoryLockedError(moved === null ? null : { pid: moved.pid, startedAt: moved.startedAt });
    }
    await rm(aside, { force: true });
  }
  throw new DataDirectoryLockedError(null);
}

/** Acquires the data directory (created if needed) or throws DataDirectoryLockedError. */
export async function acquireDataDirectoryLock(root: string, options: LockOptions = {}): Promise<DataDirectoryLock> {
  const absolute = path.resolve(root);
  await mkdir(absolute, { recursive: true });
  const mechanism = options.mechanism ?? (process.platform === 'win32' ? 'windows-share-lock' : 'pid-file');
  if (mechanism === 'windows-share-lock' && process.platform !== 'win32') throw new Error('the windows-share-lock mechanism requires Windows');
  const owner: LockOwner = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), token: randomUUID() };
  return mechanism === 'windows-share-lock' ? acquireShareLock(absolute, owner) : acquirePidFile(absolute, owner);
}
