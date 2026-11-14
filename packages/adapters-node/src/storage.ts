/**
 * Filesystem TemplateStorage.
 *
 *   <root>/projects/<projectId>/templates/<templateId>/manifest.json
 *   <root>/projects/<projectId>/templates/<templateId>/manifest.json.bak
 *   <root>/projects/<projectId>/blobs/<sha256>.png
 *
 * Every file is written to a unique temporary file in the same directory,
 * flushed (fsync), then renamed over its target: a reader sees the old or
 * the new content, never a mix. The manifest backup is written as a COPY
 * of the current manifest before the single rename that publishes the new
 * one; the current manifest is never moved away, so a crash at any point
 * leaves a readable manifest.json.
 *
 * Compare-and-swap on `generation` is serialized per template inside this
 * process. Across processes, the storage requires the data directory lock
 * (lock.ts): a second instance on the same directory is refused at startup,
 * and every write checks that the lock is still held.
 *
 * Repair (replaceManifest) copies the corrupt manifest's raw bytes to
 * `manifest.json.corrupt-<time>-<id>` before replacing it; the backup is
 * left untouched.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ManifestRead, ProjectId, ReservationMaxima, TemplateId, TemplateStorage } from '@geoplacer/core';
import { StorageConflictError, isValidId, manifestGeneration } from '@geoplacer/core';
import type { DataDirectoryLock } from './lock.js';

const MANIFEST = 'manifest.json';
const RESERVATIONS = 'reservations';
const RESERVATION = /^(generation|revision)-(\d{1,16})$/;
const BACKUP = 'manifest.json.bak';
const ADDRESS = /^[0-9a-f]{64}$/;
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface NodeTemplateStorageOptions {
  /** Rename attempts on transient Windows errors (antivirus, indexer). Default 8. */
  readonly renameAttempts?: number;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

async function readOrNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class NodeTemplateStorage implements TemplateStorage {
  readonly root: string;
  private readonly lock: DataDirectoryLock;
  private readonly renameAttempts: number;
  private readonly locks = new Map<string, Promise<unknown>>();

  /** The storage writes only under a held data directory lock (acquireDataDirectoryLock). */
  constructor(lock: DataDirectoryLock, options: NodeTemplateStorageOptions = {}) {
    lock.assertHeld();
    this.lock = lock;
    this.root = lock.root;
    this.renameAttempts = options.renameAttempts ?? 8;
  }

  // ───────────── paths (validated, always under root) ─────────────

  private under(...parts: string[]): string {
    const target = path.resolve(this.root, ...parts);
    const relative = path.relative(this.root, target);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`path escapes the storage root: ${parts.join('/')}`);
    }
    return target;
  }

  private projectDir(projectId: string): string {
    if (!isValidId(projectId)) throw new Error(`invalid project id: ${JSON.stringify(projectId)}`);
    return this.under('projects', projectId);
  }

  private templateDir(projectId: string, templateId: string): string {
    if (!isValidId(templateId)) throw new Error(`invalid template id: ${JSON.stringify(templateId)}`);
    return path.join(this.projectDir(projectId), 'templates', templateId);
  }

  private blobPath(projectId: string, address: string): string {
    if (!ADDRESS.test(address)) throw new Error(`invalid blob address: ${JSON.stringify(address)}`);
    return path.join(this.projectDir(projectId), 'blobs', `${address}.png`);
  }

  // ───────────── atomic write ─────────────

  private async renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(from, to);
        return;
      } catch (error) {
        if (attempt >= this.renameAttempts || !RETRYABLE.has(errorCode(error) ?? '')) throw error;
        await delay(10 * 2 ** (attempt - 1));
      }
    }
  }

  /** Unique temp file + fsync + rename over the target. */
  private async writeAtomic(target: string, data: Uint8Array | string): Promise<void> {
    this.lock.assertHeld();
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx');
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.renameWithRetry(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    await this.syncDirectory(path.dirname(target));
  }

  /** Persists the rename itself where the platform allows it (not on Windows). */
  private async syncDirectory(dir: string): Promise<void> {
    if (process.platform === 'win32') return;
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  // ───────────── TemplateStorage ─────────────

  async readManifest(projectId: ProjectId, templateId: TemplateId): Promise<ManifestRead> {
    const dir = this.templateDir(projectId, templateId);
    const [current, backup] = await Promise.all([
      readOrNull(() => readFile(path.join(dir, MANIFEST), 'utf8')),
      readOrNull(() => readFile(path.join(dir, BACKUP), 'utf8')),
    ]);
    return { current, backup };
  }

  writeManifest(projectId: ProjectId, templateId: TemplateId, json: string, expectedGeneration: number | null): Promise<void> {
    const dir = this.templateDir(projectId, templateId);
    return this.exclusive(dir, async () => {
      const target = path.join(dir, MANIFEST);
      const current = await readOrNull(() => readFile(target, 'utf8'));
      const actual = manifestGeneration(current);
      if (expectedGeneration === null ? current !== null : actual !== expectedGeneration) {
        throw new StorageConflictError(expectedGeneration, actual);
      }
      if (current !== null) await this.writeAtomic(path.join(dir, BACKUP), current);
      await this.writeAtomic(target, json);
    });
  }

  replaceManifest(projectId: ProjectId, templateId: TemplateId, json: string, expectedCurrent: string | null): Promise<string | null> {
    const dir = this.templateDir(projectId, templateId);
    return this.exclusive(dir, async () => {
      this.lock.assertHeld();
      const target = path.join(dir, MANIFEST);
      const raw = await readOrNull(() => readFile(target));
      const current = raw === null ? null : raw.toString('utf8');
      if (current !== expectedCurrent) throw new StorageConflictError(null, manifestGeneration(current));
      let preserved: string | null = null;
      if (raw !== null) {
        // Raw bytes, not the decoded text: the evidence is kept exactly as found.
        preserved = `${MANIFEST}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
        await this.writeAtomic(path.join(dir, preserved), raw);
      }
      await this.writeAtomic(target, json);
      return preserved;
    });
  }

  /**
   * Number reservation: `<template>/reservations/<kind>-<15 digits>`,
   * created exclusively ('wx', atomic create-if-absent on NTFS and POSIX
   * local filesystems), flushed (fsync), then the directory is flushed
   * where the platform allows it (not on Windows). The NAME carries the
   * number: an empty or unreadable content still counts.
   */
  async reserve(projectId: ProjectId, templateId: TemplateId, kind: 'generation' | 'revision', value: number): Promise<void> {
    if (kind !== 'generation' && kind !== 'revision') throw new Error(`invalid reservation kind: ${String(kind)}`);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${kind} number: ${String(value)}`);
    this.lock.assertHeld();
    const dir = path.join(this.templateDir(projectId, templateId), RESERVATIONS);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${kind}-${String(value).padStart(15, '0')}`);
    let handle;
    try {
      handle = await open(file, 'wx');
    } catch (error) {
      if (errorCode(error) === 'EEXIST') throw new StorageConflictError(null, null);
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({ kind, value, reservedAt: new Date().toISOString() }) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectory(dir);
  }

  /** Highest reserved numbers; no directory = none; names not matching the pattern are ignored; other errors throw. */
  async reservations(projectId: ProjectId, templateId: TemplateId): Promise<ReservationMaxima> {
    const dir = path.join(this.templateDir(projectId, templateId), RESERVATIONS);
    const names = (await readOrNull(() => readdir(dir))) ?? [];
    let generation: number | null = null;
    let revision: number | null = null;
    for (const name of names) {
      const match = RESERVATION.exec(name);
      if (match === null) continue;
      const value = Number(match[2]);
      if (match[1] === 'generation') generation = Math.max(generation ?? 0, value);
      else revision = Math.max(revision ?? 0, value);
    }
    return { generation, revision };
  }

  /** Valid template ids whose directory holds a manifest (or its backup); anything else is ignored. */
  async listTemplates(projectId: ProjectId): Promise<readonly TemplateId[]> {
    const dir = path.join(this.projectDir(projectId), 'templates');
    const entries = (await readOrNull(() => readdir(dir, { withFileTypes: true }))) ?? [];
    const ids: TemplateId[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidId(entry.name)) continue;
      const hasManifest = async (name: string): Promise<boolean> => (await readOrNull(() => stat(path.join(dir, entry.name, name)))) !== null;
      if ((await hasManifest(MANIFEST)) || (await hasManifest(BACKUP))) ids.push(entry.name as TemplateId);
    }
    return ids.sort();
  }

  async readBlob(projectId: ProjectId, address: string): Promise<Uint8Array | null> {
    const bytes = await readOrNull(() => readFile(this.blobPath(projectId, address)));
    return bytes === null ? null : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async writeBlob(projectId: ProjectId, address: string, bytes: Uint8Array): Promise<void> {
    await this.writeAtomic(this.blobPath(projectId, address), bytes);
  }
}
