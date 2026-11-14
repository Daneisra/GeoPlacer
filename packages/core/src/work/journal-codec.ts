/**
 * Line format of the attempt journal (pure; the file adapter only appends
 * and reads bytes).
 *
 * One event per line: `<crc32, 8 hex digits> <json>\n`, where json is
 * `{"v":1,"event":{...}}` written in pure ASCII (non-ASCII characters are
 * escaped) and the CRC-32 covers the json bytes.
 *
 * Reading: a last segment without its newline is a torn append (crash
 * during the write): ignored and measured. Any other damaged line (CRC,
 * format, unknown version, invalid event) is reported by line number, never
 * silently skipped; the caller then treats every open attempt as uncertain.
 */

import type { Attempt, HistoryEntry, JournalEvent, JournalLoad, PixelWriteOutcome } from '../contracts/index.js';
import { crc32 } from '../template/png-header.js';

export const JOURNAL_FORMAT_VERSION = 1;

const NEWLINE = 0x0a;

function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** One complete checksummed line `<crc> {"v":1,"event":value}\n` (ASCII). */
export function encodeChecksummedLine(value: unknown): string {
  const json = asciiJson({ v: JOURNAL_FORMAT_VERSION, event: value });
  return `${crc32(asciiBytes(json)).toString(16).padStart(8, '0')} ${json}\n`;
}

/** One complete journal line, newline included (ASCII). */
export function encodeJournalLine(event: JournalEvent): string {
  return encodeChecksummedLine(event);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
const isText = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
const OUTCOMES: ReadonlySet<unknown> = new Set<PixelWriteOutcome['status']>(['applied', 'already-correct', 'rejected', 'unknown']);
const OBSERVED: ReadonlySet<unknown> = new Set(['observed-correct', 'observed-incorrect', 'observed-unknown']);
const STATES: ReadonlySet<unknown> = new Set<Attempt['state']>(['leased']);
const HISTORY_STATES: ReadonlySet<unknown> = new Set<HistoryEntry['state']>(['finished', 'failed', 'cancelled', 'reconciled']);

function validOutcomes(v: unknown): boolean {
  return Array.isArray(v) && v.every((o) => isObject(o) && isText(o['taskId']) && OUTCOMES.has(o['status']));
}

function validAttempt(a: unknown): boolean {
  if (!isObject(a)) return false;
  const writes = a['writes'];
  return (
    isText(a['attemptId']) &&
    isText(a['agent']) &&
    isText(a['projectId']) &&
    isText(a['templateId']) &&
    Number.isSafeInteger(a['revision']) &&
    Array.isArray(writes) &&
    writes.length > 0 &&
    writes.every((w) => isObject(w) && isText(w['taskId']) && isObject(w['point']) && Number.isSafeInteger(w['point']['x']) && Number.isSafeInteger(w['point']['y']) && Number.isSafeInteger(w['color'])) &&
    Number.isSafeInteger(a['energyCost']) &&
    STATES.has(a['state']) &&
    isTime(a['leasedAt']) &&
    isTime(a['expiresAt']) &&
    a['startedAt'] === null &&
    a['needsReconciliationAt'] === null &&
    a['closedAt'] === null &&
    Array.isArray(a['results']) &&
    a['results'].length === 0 &&
    a['reason'] === null
  );
}

/** Structural check of a decoded event (a valid CRC does not make a valid event). */
export function isJournalEvent(e: unknown): e is JournalEvent {
  if (!isObject(e)) return false;
  if (e['type'] === 'leased') return validAttempt(e['attempt']);
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

/** ASCII bytes to text, by chunks (no per-character concatenation). */
function asciiText(bytes: Uint8Array, start: number, end: number): string {
  const parts: string[] = [];
  for (let i = start; i < end; i += 8192) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + 8192)) as unknown as number[]));
  return parts.join('');
}

function decodeLine<T>(bytes: Uint8Array, start: number, end: number, valid: (value: unknown) => value is T): T | null {
  // "xxxxxxxx " + at least "{}"
  if (end - start < 11 || bytes[start + 8] !== 0x20) return null;
  for (let i = start; i < end; i++) {
    const b = bytes[i]!;
    if (b < 0x20 || b > 0x7e) return null;
  }
  const crcText = asciiText(bytes, start, start + 8);
  if (!/^[0-9a-f]{8}$/.test(crcText)) return null;
  if (crc32(bytes, start + 9, end) !== Number.parseInt(crcText, 16)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(asciiText(bytes, start + 9, end));
  } catch {
    return null;
  }
  if (!isObject(parsed) || parsed['v'] !== JOURNAL_FORMAT_VERSION || !valid(parsed['event'])) return null;
  return parsed['event'];
}

export interface ChecksummedLines<T> {
  readonly values: readonly T[];
  /** Bytes after the last newline (torn append). */
  readonly discardedTailBytes: number;
  /** 1-based numbers of the damaged complete lines. */
  readonly corruptLines: readonly number[];
}

/** Decodes a file of checksummed lines, keeping the values `valid` accepts. */
export function decodeChecksummedLines<T>(bytes: Uint8Array, valid: (value: unknown) => value is T): ChecksummedLines<T> {
  const values: T[] = [];
  const corruptLines: number[] = [];
  let start = 0;
  let line = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== NEWLINE) continue;
    line++;
    const value = decodeLine(bytes, start, i, valid);
    if (value === null) corruptLines.push(line);
    else values.push(value);
    start = i + 1;
  }
  return { values, discardedTailBytes: bytes.length - start, corruptLines };
}

/** Decodes a whole journal file. */
export function decodeJournal(bytes: Uint8Array): JournalLoad {
  const { values, discardedTailBytes, corruptLines } = decodeChecksummedLines(bytes, isJournalEvent);
  return { events: values, discardedTailBytes, corruptLines };
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
    counts.every((k) => Number.isSafeInteger(e[k]) && (e[k] as number) >= 0)
  );
}

/** The journal line format, reused for the history file. */
export function encodeHistoryLine(entry: HistoryEntry): string {
  return encodeChecksummedLine(entry);
}
