/**
 * Durable simulated world (Phase 1B.9).
 *
 * The simulated canvas stands for a remote service: its state (pixels and
 * agent resources) must survive a restart of GeoPlacer, independently of
 * the attempt journal, exactly as a real canvas would. This store keeps it
 * under one directory:
 *
 * - `CURRENT`: `<crc32> <json>\n`, the current generation;
 * - `world-<n>.ckpt`: a checkpoint: `<crc32> <json header>\n`, then the
 *   pixels of the bounds raster as little-endian int32 (their CRC-32 is in
 *   the header);
 * - `world-<n>.log`: one line per change since the checkpoint,
 *   `<crc32> <json>\n`, numbered from 1.
 *
 * Order of a change (the `commit` hook of SimulatedCanvasProvider): the line
 * is appended and fsynced, THEN the change becomes visible and a write
 * answers. A process killed before the fsync completes leaves at most a
 * torn last line: that change was never visible nor answered, and it is cut
 * off at the next opening. A damaged line followed by others is real damage:
 * opening is refused until an explicit reset.
 *
 * A checkpoint (new generation) is written to new files, the pointer is
 * replaced by a rename, then the old generation is removed; files of any
 * other generation found at opening are leftovers of an interrupted
 * checkpoint and are removed.
 *
 * Limits: process kills are tested; a power loss is not. On Windows, a
 * directory cannot be fsynced: a rename relies on NTFS metadata journaling.
 */

import path from 'node:path';
import type { AgentResourceState, CanvasRect, CoordinateSystem } from '@geoplacer/core';
import { crc32 } from '@geoplacer/core';
import { nodeJournalFs, type AppendHandle, type JournalFs } from '@geoplacer/adapters-node';
import type { WorldCommit, WorldView } from '@geoplacer/simulator';

export const WORLD_FORMAT_VERSION = 1;
const POINTER = 'CURRENT';
const CKPT = /^world-(\d+)\.ckpt$/;
const LOG = /^world-(\d+)\.log$/;

/** What the world belongs to: a saved world is never loaded into another canvas or other rules. */
export interface WorldIdentity {
  readonly bounds: CanvasRect;
  readonly coordinateSystem: CoordinateSystem;
  readonly rules: { readonly id: string; readonly version: number };
}

export type WorldStoreErrorCode = 'WORLD_DAMAGED' | 'WORLD_IDENTITY_MISMATCH' | 'WORLD_CLOSED';

export class WorldStoreError extends Error {
  readonly code: WorldStoreErrorCode;
  constructor(code: WorldStoreErrorCode, message: string) {
    super(message);
    this.name = 'WorldStoreError';
    this.code = code;
  }
}

/** Named steps of the file operations (crash tests stop a process at each). */
export type WorldStoreStep = 'appended' | 'checkpoint-written' | 'log-created' | 'pointer-written' | 'pointer-renamed' | 'old-removed';

export interface FileWorldStoreOptions {
  readonly fs?: JournalFs;
  /** Test hook, called after each named step with the file concerned. */
  readonly onStep?: (step: WorldStoreStep, file: string) => void;
}

export interface WorldOpenReport {
  readonly generation: number;
  /** Changes replayed after the checkpoint. */
  readonly replayed: number;
  /** A torn last line was cut off (a change never made visible). */
  readonly tornTailCut: boolean;
  /** Files of other generations removed (interrupted checkpoint, leftovers). */
  readonly removed: readonly string[];
}

export interface LoadedWorld {
  readonly pixels: Int32Array;
  readonly agents: readonly AgentResourceState[];
}

interface Header {
  readonly format: number;
  readonly generation: number;
  readonly identity: WorldIdentity;
  readonly agents: readonly AgentResourceState[];
  readonly pixelCount: number;
  readonly pixelsCrc: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function line(json: string): Uint8Array {
  const body = encoder.encode(json);
  return encoder.encode(`${crc32(body).toString(16).padStart(8, '0')} ${json}\n`);
}

/** Parses `<crc> <json>` (without the newline); null when damaged. */
function parseLine(bytes: Uint8Array): unknown {
  if (bytes.length < 10 || bytes[8] !== 0x20) return null;
  const crcText = decoder.decode(bytes.subarray(0, 8));
  if (!/^[0-9a-f]{8}$/.test(crcText)) return null;
  const body = bytes.subarray(9);
  if (crc32(body) !== Number.parseInt(crcText, 16)) return null;
  try {
    return JSON.parse(decoder.decode(body)) as unknown;
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

function sameIdentity(a: WorldIdentity, b: WorldIdentity): boolean {
  return (
    a.bounds.minX === b.bounds.minX &&
    a.bounds.minY === b.bounds.minY &&
    a.bounds.width === b.bounds.width &&
    a.bounds.height === b.bounds.height &&
    a.coordinateSystem.yAxis === b.coordinateSystem.yAxis &&
    a.rules.id === b.rules.id &&
    a.rules.version === b.rules.version
  );
}

function describe(identity: WorldIdentity): string {
  const { minX, minY, width, height } = identity.bounds;
  return `${width}x${height} at (${minX}, ${minY}), y ${identity.coordinateSystem.yAxis}, rules ${identity.rules.id} v${identity.rules.version}`;
}

/** Minimal structural check of an agent state read from disk. */
function validState(s: unknown, identity: WorldIdentity): s is AgentResourceState {
  return (
    isObject(s) &&
    typeof s.agent === 'string' &&
    isObject(s.rules) &&
    s.rules.id === identity.rules.id &&
    s.rules.version === identity.rules.version &&
    typeof s.energy === 'number' &&
    typeof s.currency === 'number' &&
    Array.isArray(s.unlockedColors) &&
    isObject(s.upgrades) &&
    isObject(s.availability) &&
    isInt(s.at)
  );
}

interface LogRecord {
  readonly seq: number;
  readonly kind: WorldCommit['kind'];
  readonly at: number;
  /** Flat [index, color, index, color, ...]. */
  readonly p?: readonly number[];
  readonly state?: AgentResourceState;
  readonly attemptId?: string;
  readonly reason?: string;
}

function encodeRecord(seq: number, change: WorldCommit): string {
  const p: number[] = [];
  if (change.kind !== 'agent') for (const px of change.pixels) p.push(px.index, px.color);
  const rec: LogRecord =
    change.kind === 'write'
      ? { seq, kind: 'write', at: change.at, attemptId: change.attemptId, p, state: change.state }
      : change.kind === 'external'
        ? { seq, kind: 'external', at: change.at, p }
        : { seq, kind: 'agent', at: change.at, reason: change.reason, state: change.state };
  return JSON.stringify(rec);
}

function validRecord(r: unknown, seq: number, size: number, identity: WorldIdentity): r is LogRecord {
  if (!isObject(r) || r.seq !== seq || !isInt(r.at)) return false;
  if (r.kind === 'write' || r.kind === 'external') {
    const p = r.p;
    if (!Array.isArray(p) || p.length % 2 !== 0) return false;
    for (let k = 0; k < p.length; k += 2) if (!isInt(p[k]) || (p[k] as number) < 0 || (p[k] as number) >= size || !isInt(p[k + 1])) return false;
    return r.kind === 'external' || (typeof r.attemptId === 'string' && validState(r.state, identity));
  }
  return r.kind === 'agent' && validState(r.state, identity);
}

function pixelsBytes(pixels: Int32Array): Uint8Array {
  const out = new Uint8Array(pixels.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pixels.length; i++) view.setInt32(i * 4, pixels[i]!, true);
  return out;
}

function pixelsFrom(bytes: Uint8Array, count: number): Int32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt32(i * 4, true);
  return out;
}

const ckptName = (g: number): string => `world-${g}.ckpt`;
const logName = (g: number): string => `world-${g}.log`;

export class FileWorldStore {
  readonly dir: string;
  readonly identity: WorldIdentity;
  private readonly fs: JournalFs;
  private readonly onStep: ((step: WorldStoreStep, file: string) => void) | undefined;
  private gen: number;
  private seq: number;
  private handle: AppendHandle | null;
  private closed = false;

  private constructor(dir: string, identity: WorldIdentity, fs: JournalFs, onStep: FileWorldStoreOptions['onStep'], gen: number, seq: number, handle: AppendHandle | null) {
    this.dir = dir;
    this.identity = identity;
    this.fs = fs;
    this.onStep = onStep;
    this.gen = gen;
    this.seq = seq;
    this.handle = handle;
  }

  /** Current generation. */
  get generation(): number {
    return this.gen;
  }

  /** Changes logged since the checkpoint (a checkpoint is due when large). */
  get recordsSinceCheckpoint(): number {
    return this.seq;
  }

  /**
   * Opens the world under `dir`: `fresh` when nothing was ever saved there
   * (call `create`), otherwise the restored world. Refuses a damaged world
   * (WORLD_DAMAGED) or a world of another canvas or other rules
   * (WORLD_IDENTITY_MISMATCH): both need an explicit reset.
   */
  static async open(
    dir: string,
    identity: WorldIdentity,
    options: FileWorldStoreOptions = {}
  ): Promise<{ readonly kind: 'fresh' } | { readonly kind: 'restored'; readonly store: FileWorldStore; readonly world: LoadedWorld; readonly report: WorldOpenReport }> {
    const fs = options.fs ?? nodeJournalFs;
    const names = await fs.list(dir);
    const generations = names.filter((n) => CKPT.test(n) || LOG.test(n));
    if (!names.includes(POINTER)) {
      if (generations.length === 0) return { kind: 'fresh' };
      throw new WorldStoreError('WORLD_DAMAGED', 'world files without a CURRENT pointer: refusing to guess (explicit reset needed)');
    }
    const pointer = parseLine(stripNewline(await fs.readFile(path.join(dir, POINTER))));
    if (!isObject(pointer) || pointer.format !== WORLD_FORMAT_VERSION || !isInt(pointer.generation) || pointer.generation < 1) {
      throw new WorldStoreError('WORLD_DAMAGED', 'the CURRENT pointer of the world is damaged or of another format');
    }
    const gen = pointer.generation;
    // Header and pixels.
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(path.join(dir, ckptName(gen)));
    } catch {
      throw new WorldStoreError('WORLD_DAMAGED', `checkpoint ${ckptName(gen)} is missing or unreadable`);
    }
    const nl = bytes.indexOf(0x0a);
    const header = nl < 0 ? null : parseLine(bytes.subarray(0, nl));
    if (!isHeader(header) || header.generation !== gen) throw new WorldStoreError('WORLD_DAMAGED', `checkpoint ${ckptName(gen)} has a damaged header`);
    if (!sameIdentity(header.identity, identity)) {
      throw new WorldStoreError('WORLD_IDENTITY_MISMATCH', `the saved world is ${describe(header.identity)}, the configuration asks for ${describe(identity)}: explicit reset needed`);
    }
    const size = identity.bounds.width * identity.bounds.height;
    const body = bytes.subarray(nl + 1);
    if (header.pixelCount !== size || body.length !== size * 4 || crc32(body) !== header.pixelsCrc) {
      throw new WorldStoreError('WORLD_DAMAGED', `checkpoint ${ckptName(gen)}: pixels damaged or truncated`);
    }
    for (const a of header.agents) if (!validState(a, identity)) throw new WorldStoreError('WORLD_DAMAGED', `checkpoint ${ckptName(gen)}: invalid agent state`);
    const pixels = pixelsFrom(body, size);
    const agents = new Map<string, AgentResourceState>(header.agents.map((a) => [a.agent, a]));
    // Changes since the checkpoint.
    const logFile = path.join(dir, logName(gen));
    let log: Uint8Array;
    try {
      log = await fs.readFile(logFile);
    } catch {
      throw new WorldStoreError('WORLD_DAMAGED', `log ${logName(gen)} is missing`);
    }
    let offset = 0;
    let seq = 0;
    let tornTailCut = false;
    while (offset < log.length) {
      const end = log.indexOf(0x0a, offset);
      const lineEnd = end < 0 ? log.length : end;
      const rec = parseLine(log.subarray(offset, lineEnd));
      if (!validRecord(rec, seq + 1, size, identity)) {
        // Only the last line may be torn (a change never made visible).
        const rest = end < 0 ? log.length : end + 1;
        if (rest < log.length) throw new WorldStoreError('WORLD_DAMAGED', `log ${logName(gen)}: damaged line ${seq + 1} followed by other lines`);
        await fs.truncate(logFile, offset);
        tornTailCut = true;
        break;
      }
      const p = rec.p ?? [];
      for (let k = 0; k < p.length; k += 2) pixels[p[k]!] = p[k + 1]!;
      if (rec.state !== undefined) agents.set(rec.state.agent, rec.state);
      seq++;
      offset = lineEnd + 1;
    }
    const removed: string[] = [];
    for (const n of generations) {
      const g = Number((CKPT.exec(n) ?? LOG.exec(n))![1]);
      if (g !== gen) {
        await fs.remove(path.join(dir, n));
        removed.push(n);
      }
    }
    for (const n of names) if (n.startsWith(`${POINTER}.`)) await fs.remove(path.join(dir, n));
    const handle = await fs.openAppend(logFile);
    const store = new FileWorldStore(dir, identity, fs, options.onStep, gen, seq, handle);
    return { kind: 'restored', store, world: { pixels, agents: [...agents.values()] }, report: { generation: gen, replayed: seq, tornTailCut, removed } };
  }

  /** Creates a new world under `dir` (nothing may be saved there yet), as generation 1. */
  static async create(dir: string, identity: WorldIdentity, initial: LoadedWorld, options: FileWorldStoreOptions = {}): Promise<FileWorldStore> {
    const fs = options.fs ?? nodeJournalFs;
    await fs.mkdir(dir);
    const names = await fs.list(dir);
    if (names.includes(POINTER) || names.some((n) => CKPT.test(n) || LOG.test(n))) throw new Error('a world already exists in this directory');
    const store = new FileWorldStore(dir, identity, fs, options.onStep, 0, 0, null);
    await store.writeGeneration(1, initial.pixels, initial.agents);
    return store;
  }

  private step(step: WorldStoreStep, file: string): void {
    this.onStep?.(step, file);
  }

  private async writeGeneration(gen: number, pixels: Int32Array, agents: readonly AgentResourceState[]): Promise<void> {
    const body = pixelsBytes(pixels);
    const header: Header = { format: WORLD_FORMAT_VERSION, generation: gen, identity: this.identity, agents, pixelCount: pixels.length, pixelsCrc: crc32(body) };
    const head = line(JSON.stringify(header));
    const ckpt = new Uint8Array(head.length + body.length);
    ckpt.set(head, 0);
    ckpt.set(body, head.length);
    const ckptFile = path.join(this.dir, ckptName(gen));
    const logFile = path.join(this.dir, logName(gen));
    // Leftovers of an interrupted attempt at this same generation.
    await this.fs.remove(ckptFile);
    await this.fs.remove(logFile);
    await this.fs.writeNew(ckptFile, ckpt);
    this.step('checkpoint-written', ckptName(gen));
    await this.fs.writeNew(logFile, new Uint8Array(0));
    this.step('log-created', logName(gen));
    const tmp = path.join(this.dir, `${POINTER}.tmp`);
    await this.fs.remove(tmp);
    await this.fs.writeNew(tmp, line(JSON.stringify({ format: WORLD_FORMAT_VERSION, generation: gen })));
    this.step('pointer-written', POINTER);
    await this.fs.rename(tmp, path.join(this.dir, POINTER));
    await this.fs.syncDir(this.dir);
    this.step('pointer-renamed', POINTER);
    const previous = this.gen;
    const old = this.handle;
    this.handle = await this.fs.openAppend(logFile);
    this.gen = gen;
    this.seq = 0;
    await old?.close();
    if (previous > 0) {
      await this.fs.remove(path.join(this.dir, ckptName(previous)));
      await this.fs.remove(path.join(this.dir, logName(previous)));
      this.step('old-removed', ckptName(previous));
    }
  }

  /** Appends one change and fsyncs it (the `commit` hook of the simulated canvas). */
  async append(change: WorldCommit): Promise<void> {
    if (this.closed || this.handle === null) throw new WorldStoreError('WORLD_CLOSED', 'the world store is closed');
    const bytes = line(encodeRecord(this.seq + 1, change));
    await this.handle.write(bytes);
    await this.handle.sync();
    this.seq++;
    this.step('appended', logName(this.gen));
  }

  /**
   * Writes a new generation from a consistent view (inside
   * `SimulatedCanvasProvider.withWorld`, so that no change runs meanwhile).
   */
  async checkpoint(view: WorldView): Promise<void> {
    if (this.closed) throw new WorldStoreError('WORLD_CLOSED', 'the world store is closed');
    await this.writeGeneration(this.gen + 1, view.pixels, view.agents);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle?.close();
    this.handle = null;
  }
}

function stripNewline(bytes: Uint8Array): Uint8Array {
  return bytes.length > 0 && bytes[bytes.length - 1] === 0x0a ? bytes.subarray(0, bytes.length - 1) : bytes;
}

function isHeader(h: unknown): h is Header {
  return (
    isObject(h) &&
    h.format === WORLD_FORMAT_VERSION &&
    isInt(h.generation) &&
    isObject(h.identity) &&
    isObject(h.identity.bounds) &&
    isObject(h.identity.coordinateSystem) &&
    isObject(h.identity.rules) &&
    Array.isArray(h.agents) &&
    isInt(h.pixelCount) &&
    isInt(h.pixelsCrc)
  );
}
