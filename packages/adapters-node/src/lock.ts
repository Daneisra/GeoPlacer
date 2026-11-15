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
 * - 'pid-file' (default elsewhere): `<root>/.geoplacer.lock` holds the
 *   owner's pid, host and a random token. It is written to a temp file and
 *   published with link() (atomic, fails if it exists), so it is never seen
 *   empty. A lock whose owner process no longer exists on this host is taken over.
 *   Best effort: the takeover of a stale lock is not atomic against another
 *   instance taking it over at the same instant (see docs/fr/modeles.md).
 *
 * The owner (pid, start time) is also written to `<root>/.geoplacer.lock.owner`
 * so that a refused instance can say who holds the directory.
 *
 * Added guard (Phase 1B.9, Windows): before the lock, the instance listens
 * on a named pipe whose name derives from the canonical path of the
 * directory (Node `net` IPC server, a documented interface). Windows refuses
 * a second listener on the same pipe name (EADDRINUSE) and frees the name
 * when the process exits or is killed. The guard does not replace the lock
 * inside the directory: two spellings of one directory (junction, subst,
 * UNC path) can give two names. Where a pipe cannot be created (a sandbox,
 * other platforms), the guard is reported unavailable and the lock alone
 * applies.
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { link, mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
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

/** State of the added guard: held, or unavailable with the reason (the lock alone then applies). */
export interface InstanceGuardStatus {
  readonly status: 'held' | 'unavailable';
  readonly detail: string | null;
}

export interface DataDirectoryLock {
  /** Absolute data directory. */
  readonly root: string;
  readonly mechanism: LockMechanism;
  readonly guard: InstanceGuardStatus;
  readonly held: boolean;
  /** Throws when the lock has been released: no write may happen without it. */
  assertHeld(): void;
  release(): Promise<void>;
}

export interface LockOptions {
  /** Default: 'windows-share-lock' on Windows, 'pid-file' elsewhere. */
  readonly mechanism?: LockMechanism;
  /** Named pipe guard (Windows only; default true). */
  readonly guard?: boolean;
}

/** Pipe name of a directory: canonical path, lower-cased (Windows paths ignore case). */
export function guardPipeName(root: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(root);
  } catch {
    canonical = path.resolve(root);
  }
  const digest = createHash('sha256').update(canonical.toLowerCase().replace(/[\\/]+$/, '')).digest('hex').slice(0, 40);
  return `\\\\.\\pipe\\geoplacer-${digest}`;
}

/**
 * Listens on the guard pipe of `root`. EADDRINUSE: another instance holds
 * it (DataDirectoryLockedError). Any other error: unavailable.
 */
export async function acquireInstanceGuard(root: string): Promise<{ readonly status: InstanceGuardStatus; release(): Promise<void> }> {
  if (process.platform !== 'win32') return { status: { status: 'unavailable', detail: 'no pipe guard on this platform: the lock inside the directory applies' }, release: async () => undefined };
  const server: Server = createServer((socket) => socket.destroy());
  const outcome = await new Promise<'held' | { code: string }>((resolve) => {
    server.once('error', (error) => resolve({ code: errorCode(error) ?? 'UNKNOWN' }));
    server.listen(guardPipeName(root), () => resolve('held'));
  });
  if (outcome !== 'held') {
    if (outcome.code === 'EADDRINUSE') throw new DataDirectoryLockedError(await readOwner(path.join(root, OWNER)));
    return { status: { status: 'unavailable', detail: `the pipe guard could not be created (${outcome.code}): the lock inside the directory applies` }, release: async () => undefined };
  }
  server.unref();
  return { status: { status: 'held', detail: null }, release: () => new Promise<void>((resolve) => server.close(() => resolve())) };
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
    guard: { status: 'unavailable', detail: 'not requested' },
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
  // The owner is written to a private temp file first, then published with
  // link(), which fails if the lock exists: the lock file is never visible
  // empty or half-written, so an unreadable lock is a damaged one.
  const temp = `${file}.${owner.token}.tmp`;
  const handle = await open(temp, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await link(temp, file);
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
      // Stale (dead owner on this host) or damaged: move it aside, then check
      // that the moved file is the one judged stale (same token, or still
      // unreadable); otherwise another instance took it meanwhile.
      const aside = `${file}.stale-${randomUUID()}`;
      try {
        await rename(file, aside);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
      const moved = await readOwner(aside);
      if (moved?.token !== existing?.token) {
        await rename(aside, file).catch(() => undefined);
        throw new DataDirectoryLockedError(moved === null ? null : { pid: moved.pid, startedAt: moved.startedAt });
      }
      await rm(aside, { force: true });
    }
    throw new DataDirectoryLockedError(null);
  } finally {
    await rm(temp, { force: true });
  }
}

/** Acquires the data directory (created if needed) or throws DataDirectoryLockedError. */
export async function acquireDataDirectoryLock(root: string, options: LockOptions = {}): Promise<DataDirectoryLock> {
  const absolute = path.resolve(root);
  await mkdir(absolute, { recursive: true });
  const mechanism = options.mechanism ?? (process.platform === 'win32' ? 'windows-share-lock' : 'pid-file');
  if (mechanism === 'windows-share-lock' && process.platform !== 'win32') throw new Error('the windows-share-lock mechanism requires Windows');
  const owner: LockOwner = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), token: randomUUID() };
  const guard = options.guard === false ? null : await acquireInstanceGuard(absolute);
  let lock: DataDirectoryLock;
  try {
    lock = mechanism === 'windows-share-lock' ? await acquireShareLock(absolute, owner) : await acquirePidFile(absolute, owner);
  } catch (error) {
    await guard?.release();
    throw error;
  }
  if (guard === null) return lock;
  return {
    root: lock.root,
    mechanism: lock.mechanism,
    guard: guard.status,
    get held() {
      return lock.held;
    },
    assertHeld: () => lock.assertHeld(),
    release: async () => {
      await lock.release();
      await guard.release();
    },
  };
}
