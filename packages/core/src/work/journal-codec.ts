/**
 * Formats of the attempt journal, its checkpoints and the history (pure;
 * the file adapter only reads and writes bytes).
 *
 * Lines: `<crc32, 8 hex digits> <json>\n`, json in pure ASCII (non-ASCII
 * characters escaped), the CRC-32 covering the json bytes.
 * - journal, Phase 1B.7: `{"v":2,"seq":n,"event":{...}}` (sequence number
 *   global across generations: a missing event is visible);
 * - journal, Phase 1B.6 (still read): `{"v":1,"event":{...}}`, no sequence;
 * - history: `{"v":1,"event":{...}}`.
 *
 * Reading: a last segment without its newline is a torn append: ignored and
 * measured. Any other damaged line (CRC, format, unknown version, invalid
 * content) is reported by line number, never silently skipped.
 *
 * Checkpoints: `GPCKPT1\n` + header json line + body json (the state). The
 * header carries the generation, the last sequence number, the body length
 * and its SHA-256; the state is validated structurally before use.
 */

import type { Attempt, ClosedAttempt, HistoryEntry, Hasher, JournalEvent, JournalState, PixelWriteOutcome } from '../contracts/index.js';
import { crc32 } from '../template/png-header.js';

/** Journal line format written since Phase 1B.7. */
export const JOURNAL_FORMAT_VERSION = 2;
const HISTORY_FORMAT_VERSION = 1;

const NEWLINE = 0x0a;

function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** ASCII bytes to text, by chunks (no per-character concatenation). */
function asciiText(bytes: Uint8Array, start: number, end: number): string {
  const parts: string[] = [];
  for (let i = start; i < end; i += 8192) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + 8192)) as unknown as number[]));
  return parts.join('');
}

function checksummed(payload: unknown): string {
  const json = asciiJson(payload);
  return `${crc32(asciiBytes(json)).toString(16).padStart(8, '0')} ${json}\n`;
}

/** One complete journal line, newline included (ASCII). */
export function encodeJournalLine(event: JournalEvent, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('a journal sequence number is a positive integer');
  return checksummed({ v: JOURNAL_FORMAT_VERSION, seq, event });
}

/** One complete history line. */
export function encodeHistoryLine(entry: HistoryEntry): string {
  return checksummed({ v: HISTORY_FORMAT_VERSION, event: entry });
}

// ───────────────────────── Validation ─────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
const isTimeOrNull = (v: unknown): boolean => v === null || isTime(v);
const isText = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
const isCount = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
const OUTCOMES: ReadonlySet<unknown> = new Set<PixelWriteOutcome['status']>(['applied', 'already-correct', 'rejected', 'unknown']);
const OBSERVED: ReadonlySet<unknown> = new Set(['observed-correct', 'observed-incorrect', 'observed-unknown']);
const OPEN: ReadonlySet<unknown> = new Set<Attempt['state']>(['leased', 'started', 'needs-reconciliation']);
const CLOSED: ReadonlySet<unknown> = new Set<ClosedAttempt['state']>(['finished', 'failed', 'cancelled']);
const HISTORY_STATES: ReadonlySet<unknown> = new Set<HistoryEntry['state']>(['finished', 'failed', 'cancelled', 'reconciled']);

function validOutcomes(v: unknown): boolean {
  return Array.isArray(v) && v.every((o) => isObject(o) && isText(o['taskId']) && OUTCOMES.has(o['status']));
}

/** An attempt as leased (strict) or, with `open`, in any open state (checkpoint). */
function validAttempt(a: unknown, open: boolean): boolean {
  if (!isObject(a)) return false;
  const writes = a['writes'];
  const base =
    isText(a['attemptId']) &&
    isText(a['agent']) &&
    isText(a['projectId']) &&
    isText(a['templateId']) &&
    Number.isSafeInteger(a['revision']) &&
    Array.isArray(writes) &&
    writes.length > 0 &&
    writes.every((w) => isObject(w) && isText(w['taskId']) && isObject(w['point']) && Number.isSafeInteger(w['point']['x']) && Number.isSafeInteger(w['point']['y']) && Number.isSafeInteger(w['color'])) &&
    isCount(a['energyCost']) &&
    isTime(a['leasedAt']) &&
    isTime(a['expiresAt']) &&
    a['closedAt'] === null &&
    Array.isArray(a['results']) &&
    a['results'].length === 0;
  if (!base) return false;
  if (!open) return a['state'] === 'leased' && a['startedAt'] === null && a['needsReconciliationAt'] === null && a['reason'] === null;
  const state = a['state'];
  return (
    OPEN.has(state) &&
    isTimeOrNull(a['startedAt']) &&
    isTimeOrNull(a['needsReconciliationAt']) &&
    (a['reason'] === null || typeof a['reason'] === 'string') &&
    (state !== 'started' || a['startedAt'] !== null) &&
    (state !== 'needs-reconciliation' || a['needsReconciliationAt'] !== null)
  );
}

/** Structural check of a decoded event (a valid CRC does not make a valid event). */
export function isJournalEvent(e: unknown): e is JournalEvent {
  if (!isObject(e)) return false;
  if (e['type'] === 'leased') return validAttempt(e['attempt'], false);
  if (e['type'] === 'canvas-read-required') return isTime(e['at']) && typeof e['reason'] === 'string';
  if (e['type'] === 'canvas-verified') return isTime(e['at']) && isTime(e['observedAt']);
  if (!isText(e['attemptId']) || !isTime(e['at'])) return false;
  switch (e['type']) {
    case 'started':
      return true;
    case 'finished':
      return validOutcomes(e['outcomes']);
    case 'failed':
      return typeof e['reason'] === 'string' && validOutcomes(e['outcomes']);
    case 'cancelled':
    case 'needs-reconciliation':
      return typeof e['reason'] === 'string';
    case 'reconciled':
      return Array.isArray(e['results']) && e['results'].every((r) => isObject(r) && isText(r['taskId']) && OBSERVED.has(r['result']));
    default:
      return false;
  }
}

export function isClosedAttempt(c: unknown): c is ClosedAttempt {
  return (
    isObject(c) &&
    isText(c['attemptId']) &&
    isText(c['agent']) &&
    isText(c['projectId']) &&
    isText(c['templateId']) &&
    Number.isSafeInteger(c['revision']) &&
    CLOSED.has(c['state']) &&
    isTime(c['leasedAt']) &&
    isTimeOrNull(c['startedAt']) &&
    isTime(c['closedAt']) &&
    isCount(c['pixels']) &&
    isCount(c['applied']) &&
    (c['applied'] as number) <= (c['pixels'] as number) &&
    typeof c['reconciled'] === 'boolean'
  );
}

function validStateBody(s: Record<string, unknown>): boolean {
  if (!isCount(s['lastSeq']) || !isCount(s['purgedClosed'])) return false;
  const open = s['open'];
  const closed = s['closed'];
  const spend = s['lastSpendAt'];
  const preserved = s['preservedGenerations'];
  if (!Array.isArray(open) || !open.every((a) => validAttempt(a, true))) return false;
  if (!Array.isArray(closed) || !closed.every(isClosedAttempt)) return false;
  if (!Array.isArray(spend) || !spend.every((x) => isObject(x) && isText(x['agent']) && isTime(x['at']))) return false;
  if (!Array.isArray(preserved) || !preserved.every(isCount)) return false;
  const ids = [...open, ...closed].map((a) => (a as { attemptId: string }).attemptId);
  return new Set(ids).size === ids.length && new Set(spend.map((x) => (x as { agent: string }).agent)).size === spend.length;
}

/** Structural check of a logical state (checkpoint body, schema 2). */
export function isJournalState(s: unknown): s is JournalState {
  if (!isObject(s) || s['schemaVersion'] !== 2 || !validStateBody(s)) return false;
  const damage = s['damage'];
  return damage === null || (isObject(damage) && isTime(damage['at']) && typeof damage['reason'] === 'string');
}

/**
 * Reads a state of schema 2, or converts one of schema 1 (Phase 1B.7):
 * its canvas read requirement becomes a damage at the same time, as
 * conservative as the 1B.8 rule (a timestamp never lifts it). Null when
 * invalid.
 */
export function upgradeJournalState(s: unknown): JournalState | null {
  if (isJournalState(s)) return s;
  if (!isObject(s) || s['schemaVersion'] !== 1 || !validStateBody(s) || !isTimeOrNull(s['canvasReadRequiredAfter'])) return null;
  const { canvasReadRequiredAfter, ...rest } = s;
  const upgraded = {
    ...rest,
    schemaVersion: 2,
    damage: canvasReadRequiredAfter === null ? null : { at: canvasReadRequiredAfter as number, reason: 'canvas read required (checkpoint of Phase 1B.7)' },
  };
  return isJournalState(upgraded) ? upgraded : null;
}

/** Structural check of a history entry. */
export function isHistoryEntry(e: unknown): e is HistoryEntry {
  if (!isObject(e)) return false;
  const counts = ['applied', 'alreadyCorrect', 'rejected', 'unknown', 'observedCorrect', 'observedIncorrect'];
  return (
    isTime(e['at']) &&
    isText(e['agent']) &&
    isText(e['templateId']) &&
    isText(e['attemptId']) &&
    Number.isSafeInteger(e['revision']) &&
    HISTORY_STATES.has(e['state']) &&
    counts.every((k) => isCount(e[k]))
  );
}

// ───────────────────────── Lines ─────────────────────────

/** The json payload of a line, or null when its CRC or format is wrong. */
function checkedPayload(bytes: Uint8Array, start: number, end: number): Record<string, unknown> | null {
  // "xxxxxxxx " + at least "{}"
  if (end - start < 11 || bytes[start + 8] !== 0x20) return null;
  for (let i = start; i < end; i++) {
    const b = bytes[i]!;
    if (b < 0x20 || b > 0x7e) return null;
  }
  const crcText = asciiText(bytes, start, start + 8);
  if (!/^[0-9a-f]{8}$/.test(crcText)) return null;
  if (crc32(bytes, start + 9, end) !== Number.parseInt(crcText, 16)) return null;
  try {
    const parsed: unknown = JSON.parse(asciiText(bytes, start + 9, end));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface DecodedJournalLine {
  readonly event: JournalEvent;
  /** null: line of Phase 1B.6 (no sequence number). */
  readonly seq: number | null;
}

/** Decodes one journal line (without its newline), or null when damaged. */
export function decodeJournalLine(bytes: Uint8Array, start = 0, end = bytes.length): DecodedJournalLine | null {
  const payload = checkedPayload(bytes, start, end);
  if (payload === null || !isJournalEvent(payload['event'])) return null;
  if (payload['v'] === 2) return Number.isSafeInteger(payload['seq']) && (payload['seq'] as number) >= 1 ? { event: payload['event'], seq: payload['seq'] as number } : null;
  return payload['v'] === 1 ? { event: payload['event'], seq: null } : null;
}

export interface ChecksummedLines<T> {
  readonly values: readonly T[];
  /** Bytes after the last newline (torn append). */
  readonly discardedTailBytes: number;
  /** 1-based numbers of the damaged complete lines. */
  readonly corruptLines: readonly number[];
}

/** Decodes a file of history lines (`{"v":1,"event":...}`), keeping the values `valid` accepts. */
export function decodeChecksummedLines<T>(bytes: Uint8Array, valid: (value: unknown) => value is T): ChecksummedLines<T> {
  const values: T[] = [];
  const corruptLines: number[] = [];
  let start = 0;
  let line = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== NEWLINE) continue;
    line++;
    const payload = checkedPayload(bytes, start, i);
    if (payload === null || payload['v'] !== HISTORY_FORMAT_VERSION || !valid(payload['event'])) corruptLines.push(line);
    else values.push(payload['event']);
    start = i + 1;
  }
  return { values, discardedTailBytes: bytes.length - start, corruptLines };
}

/** One complete line found by a scanner. */
export interface ScannedLine {
  /** 1-based line number. */
  readonly line: number;
  /** Byte offset of the line start in the file. */
  readonly offset: number;
  readonly length: number;
  /** null when the line is damaged. */
  readonly decoded: DecodedJournalLine | null;
}

/**
 * Streaming journal reader: feed the file by chunks (bounded memory), get
 * every complete line decoded in order; `end()` gives the torn tail.
 */
export class JournalLineScanner {
  private pending: Uint8Array = new Uint8Array(0);
  private offset = 0;
  private line = 0;

  constructor(private readonly onLine: (line: ScannedLine) => void) {}

  push(chunk: Uint8Array): void {
    let data = chunk;
    if (this.pending.length > 0) {
      data = new Uint8Array(this.pending.length + chunk.length);
      data.set(this.pending);
      data.set(chunk, this.pending.length);
    }
    let start = 0;
    for (let i = data.indexOf(NEWLINE); i !== -1; i = data.indexOf(NEWLINE, start)) {
      this.line++;
      this.onLine({ line: this.line, offset: this.offset, length: i - start + 1, decoded: decodeJournalLine(data, start, i) });
      this.offset += i - start + 1;
      start = i + 1;
    }
    this.pending = data.slice(start);
  }

  /** Bytes after the last newline (torn append). */
  end(): number {
    return this.pending.length;
  }
}

export interface DecodedJournal {
  readonly entries: readonly DecodedJournalLine[];
  readonly discardedTailBytes: number;
  readonly corruptLines: readonly number[];
}

/** Decodes a whole journal file held in memory (tests, small files). */
export function decodeJournal(bytes: Uint8Array): DecodedJournal {
  const entries: DecodedJournalLine[] = [];
  const corruptLines: number[] = [];
  const scanner = new JournalLineScanner((l) => {
    if (l.decoded === null) corruptLines.push(l.line);
    else entries.push(l.decoded);
  });
  scanner.push(bytes);
  return { entries, discardedTailBytes: scanner.end(), corruptLines };
}

// ───────────────────────── Checkpoints ─────────────────────────

const CHECKPOINT_MAGIC = 'GPCKPT1\n';
export const CHECKPOINT_FORMAT_VERSION = 1;

export type CheckpointErrorCode = 'BAD_MAGIC' | 'BAD_HEADER' | 'BAD_LENGTH' | 'BAD_CHECKSUM' | 'BAD_STATE' | 'WRONG_GENERATION' | 'UNSUPPORTED_VERSION';

export class CheckpointError extends Error {
  readonly code: CheckpointErrorCode;

  constructor(code: CheckpointErrorCode, message: string) {
    super(message);
    this.name = 'CheckpointError';
    this.code = code;
  }
}

export interface CheckpointHeader {
  readonly format: number;
  readonly generation: number;
  readonly lastSeq: number;
  readonly bodyBytes: number;
  readonly bodySha256: string;
}

/** Serializes a checkpoint of `generation` (ASCII bytes). */
export async function encodeCheckpoint(generation: number, state: JournalState, hasher: Hasher): Promise<Uint8Array> {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('a checkpoint generation is a positive integer');
  if (!isJournalState(state)) throw new CheckpointError('BAD_STATE', 'the state to checkpoint is not valid');
  const body = asciiBytes(asciiJson(state));
  const header: CheckpointHeader = { format: CHECKPOINT_FORMAT_VERSION, generation, lastSeq: state.lastSeq, bodyBytes: body.length, bodySha256: await hasher.sha256Hex(body) };
  const head = asciiBytes(CHECKPOINT_MAGIC + asciiJson(header) + '\n');
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

/** Reads the header only (diagnostic), or throws. */
export function readCheckpointHeader(bytes: Uint8Array): { readonly header: CheckpointHeader; readonly bodyOffset: number } {
  const magic = asciiBytes(CHECKPOINT_MAGIC);
  if (bytes.length < magic.length || magic.some((b, i) => bytes[i] !== b)) throw new CheckpointError('BAD_MAGIC', 'not a checkpoint');
  const end = bytes.indexOf(NEWLINE, magic.length);
  if (end === -1) throw new CheckpointError('BAD_HEADER', 'no header line');
  let header: unknown;
  try {
    header = JSON.parse(asciiText(bytes, magic.length, end));
  } catch {
    throw new CheckpointError('BAD_HEADER', 'unreadable header');
  }
  if (!isObject(header) || !isCount(header['generation']) || !isCount(header['lastSeq']) || !isCount(header['bodyBytes']) || typeof header['bodySha256'] !== 'string') {
    throw new CheckpointError('BAD_HEADER', 'incomplete header');
  }
  if (header['format'] !== CHECKPOINT_FORMAT_VERSION) throw new CheckpointError('UNSUPPORTED_VERSION', `checkpoint format ${String(header['format'])}`);
  return { header: header as unknown as CheckpointHeader, bodyOffset: end + 1 };
}

/** Verifies and decodes a checkpoint (length, SHA-256, state), or throws a CheckpointError. */
export async function decodeCheckpoint(bytes: Uint8Array, hasher: Hasher, expectedGeneration?: number): Promise<{ readonly header: CheckpointHeader; readonly state: JournalState }> {
  const { header, bodyOffset } = readCheckpointHeader(bytes);
  if (expectedGeneration !== undefined && header.generation !== expectedGeneration) {
    throw new CheckpointError('WRONG_GENERATION', `checkpoint of generation ${header.generation}, expected ${expectedGeneration}`);
  }
  const body = bytes.subarray(bodyOffset);
  if (body.length !== header.bodyBytes) throw new CheckpointError('BAD_LENGTH', `body of ${body.length} bytes, header says ${header.bodyBytes}`);
  if ((await hasher.sha256Hex(body)) !== header.bodySha256) throw new CheckpointError('BAD_CHECKSUM', 'checkpoint body checksum mismatch');
  let state: unknown;
  try {
    state = JSON.parse(asciiText(body, 0, body.length));
  } catch {
    throw new CheckpointError('BAD_STATE', 'unreadable state');
  }
  const upgraded = upgradeJournalState(state);
  if (upgraded === null || upgraded.lastSeq !== header.lastSeq) throw new CheckpointError('BAD_STATE', 'invalid state');
  return { header, state: upgraded };
}
