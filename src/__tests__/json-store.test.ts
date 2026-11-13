/**
 * Crash-safe JSON persistence tests (run in OS temp directories)
 */

import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeJsonAtomic, readJsonWithRecovery, removeOrphanTempFiles, BACKUP_SUFFIX } from '../utils/json-store.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'geoplacer-store-'));
  file = path.join(dir, 'users.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

describe('writeJsonAtomic', () => {
  it('writes valid JSON and leaves no temp file', () => {
    writeJsonAtomic(file, { a: 1 });
    expect(read(file)).toEqual({ a: 1 });
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the previous valid version as .bak', () => {
    writeJsonAtomic(file, { v: 1 });
    writeJsonAtomic(file, { v: 2 });
    expect(read(file)).toEqual({ v: 2 });
    expect(read(file + BACKUP_SUFFIX)).toEqual({ v: 1 });
  });

  it('never lets a corrupt file overwrite the last good backup', () => {
    writeJsonAtomic(file, { v: 1 });
    writeJsonAtomic(file, { v: 2 }); // .bak = v1
    writeFileSync(file, '{"v": 3, "trunc'); // corruption outside the store
    writeJsonAtomic(file, { v: 4 });
    expect(read(file)).toEqual({ v: 4 });
    expect(read(file + BACKUP_SUFFIX)).toEqual({ v: 1 });
  });

  it('can skip the backup', () => {
    writeJsonAtomic(file, { v: 1 });
    writeJsonAtomic(file, { v: 2 }, { backup: false });
    expect(existsSync(file + BACKUP_SUFFIX)).toBe(false);
  });

  it('refuses non-serialisable values without touching the file', () => {
    writeJsonAtomic(file, { v: 1 });
    expect(() => writeJsonAtomic(file, undefined)).toThrow(TypeError);
    expect(read(file)).toEqual({ v: 1 });
  });
});

describe('readJsonWithRecovery', () => {
  it('returns the fallback for a missing file', () => {
    const r = readJsonWithRecovery(file, () => ({ empty: true }));
    expect(r.status).toBe('missing');
    expect(r.data).toEqual({ empty: true });
  });

  it('reads a valid file', () => {
    writeJsonAtomic(file, { v: 1 });
    expect(readJsonWithRecovery(file, () => ({})).data).toEqual({ v: 1 });
  });

  it('quarantines a truncated file and restores the backup', () => {
    writeJsonAtomic(file, { v: 1 });
    writeJsonAtomic(file, { v: 2 }); // .bak = v1
    writeFileSync(file, '{"v": 2, "users": {"a"'); // simulated non-atomic crash
    const r = readJsonWithRecovery(file, () => ({}));
    expect(r.status).toBe('recovered-from-backup');
    expect(r.data).toEqual({ v: 1 });
    expect(read(file)).toEqual({ v: 1 }); // main file restored
    expect(readFileSync(r.quarantinedTo!, 'utf8')).toBe('{"v": 2, "users": {"a"'); // nothing lost
  });

  it('keeps a corrupt file aside when no backup exists', () => {
    writeFileSync(file, 'not json');
    const r = readJsonWithRecovery(file, () => ({ fresh: true }));
    expect(r.status).toBe('corrupt-no-backup');
    expect(r.data).toEqual({ fresh: true });
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(r.quarantinedTo!, 'utf8')).toBe('not json');
  });

  it('restores the backup when the main file is missing', () => {
    writeFileSync(file + BACKUP_SUFFIX, '{"v": 1}');
    const r = readJsonWithRecovery(file, () => ({}));
    expect(r.status).toBe('recovered-from-backup');
    expect(read(file)).toEqual({ v: 1 });
  });

  it('removes orphan temp files left by an interrupted write', () => {
    writeJsonAtomic(file, { v: 1 });
    const orphan = path.join(dir, 'users.json.1234.5678.abc.tmp');
    writeFileSync(orphan, '{"v": 2, "half');
    const r = readJsonWithRecovery(file, () => ({}));
    expect(r.data).toEqual({ v: 1 });
    expect(r.removedTempFiles).toEqual(['users.json.1234.5678.abc.tmp']);
    expect(existsSync(orphan)).toBe(false);
  });

  it('only removes temp files belonging to the target file', () => {
    writeFileSync(path.join(dir, 'templates.json.1.2.x.tmp'), '');
    expect(removeOrphanTempFiles(file)).toEqual([]);
  });
});

describe('crash during writes (real process kill)', () => {
  const fixture = path.join(__dirname, 'fixtures', 'crash-writer.ts');
  const runs = 8;

  function crashOnce(delayMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture, file], {
        cwd: path.resolve(__dirname, '..', '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      child.stdout.on('data', (d) => {
        if (String(d).includes('ready')) setTimeout(() => child.kill('SIGKILL'), delayMs);
      });
      child.on('exit', (_code, signal) => {
        if (signal === 'SIGKILL' || (process.platform === 'win32' && _code !== 0)) resolve();
        else reject(new Error(`writer exited unexpectedly (${_code}): ${stderr}`));
      });
    });
  }

  it(`always leaves a complete, valid file (${runs} random kills)`, async () => {
    for (let i = 0; i < runs; i++) {
      await crashOnce(20 + Math.floor(Math.random() * 200));
      const r = readJsonWithRecovery<{ version: string; rows: unknown[] } | null>(file, () => null);
      expect(r.status).toBe('ok');
      expect(['A', 'B']).toContain(r.data?.version);
      expect(r.data?.rows).toHaveLength(400);
      expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    }
  }, 120_000);
});
