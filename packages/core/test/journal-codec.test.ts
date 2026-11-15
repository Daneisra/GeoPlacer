import { describe, expect, it } from 'vitest';
import type { HistoryEntry, JournalEvent, JournalState } from '../src/index.js';
import {
  CheckpointError,
  JournalLineScanner,
  crc32,
  decodeCheckpoint,
  decodeChecksummedLines,
  decodeJournal,
  decodeJournalLine,
  encodeCheckpoint,
  encodeHistoryLine,
  encodeJournalLine,
  isHistoryEntry,
  isJournalState,
} from '../src/index.js';
import { testHasher } from './helpers/ports.js';
import { testRandom } from './helpers/strategy.js';

const enc = new TextEncoder();

const leasedAttempt = {
  attemptId: 'a1' as never,
  agent: 'agent-1' as never,
  projectId: 'projet' as never,
  templateId: 'modèle' as never,
  revision: 2,
  writes: [{ taskId: 'projet/modèle@2:0,0:#ff0000' as never, point: { x: 0, y: -3 }, color: 0xff0000 as never }],
  energyCost: 1,
  state: 'leased' as const,
  leasedAt: 10,
  expiresAt: 20,
  startedAt: null,
  needsReconciliationAt: null,
  closedAt: null,
  results: [],
  reason: null,
};

function events(): JournalEvent[] {
  return [
    { type: 'leased', attempt: leasedAttempt },
    { type: 'started', attemptId: 'a1' as never, at: 11 },
    { type: 'failed', attemptId: 'a1' as never, at: 12, reason: 'réseau coupé ☂ 😀', outcomes: [{ taskId: 't' as never, status: 'rejected', reason: 'no-energy' }] },
    { type: 'needs-reconciliation', attemptId: 'a2' as never, at: 13, reason: 'r' },
    { type: 'reconciled', attemptId: 'a2' as never, at: 14, results: [{ taskId: 't' as never, result: 'observed-unknown' }] },
    { type: 'cancelled', attemptId: 'a3' as never, at: 15, reason: '' },
    { type: 'finished', attemptId: 'a4' as never, at: 16, outcomes: [{ taskId: 't' as never, status: 'unknown' }] },
    { type: 'canvas-read-required', at: 17, reason: 'damaged' },
    { type: 'canvas-verified', at: 18, observedAt: 18 },
  ];
}
const lines = (): string[] => events().map((e, i) => encodeJournalLine(e, i + 1));

/** A Phase 1B.6 line (format 1, no sequence number). */
function v1Line(event: JournalEvent): string {
  const json = JSON.stringify({ v: 1, event }).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `${crc32(enc.encode(json)).toString(16).padStart(8, '0')} ${json}\n`;
}

describe('journal line format', () => {
  it('round-trips every event kind with its sequence number, in pure ASCII, one line each', () => {
    const text = lines().join('');
    expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
    expect(text.split('\n')).toHaveLength(events().length + 1);
    expect(decodeJournal(enc.encode(text))).toEqual({ entries: events().map((event, i) => ({ event, seq: i + 1 })), discardedTailBytes: 0, corruptLines: [] });
    expect(decodeJournal(new Uint8Array(0))).toEqual({ entries: [], discardedTailBytes: 0, corruptLines: [] });
    expect(() => encodeJournalLine(events()[1]!, 0)).toThrow();
  });

  it('still reads the lines of Phase 1B.6 (format 1, no sequence number)', () => {
    const decoded = decodeJournal(enc.encode(v1Line(events()[0]!) + v1Line(events()[1]!)));
    expect(decoded.entries).toEqual([
      { event: events()[0], seq: null },
      { event: events()[1], seq: null },
    ]);
  });

  it('rejects a valid checksum over an invalid content, an unknown version, a bad sequence number, an empty line', () => {
    const line = encodeJournalLine({ type: 'started', attemptId: 'a' as never, at: 1 }, 1);
    const history = encodeHistoryLine({ at: 1, agent: 'a', templateId: 't', revision: 1, attemptId: 'x', state: 'finished', applied: 0, alreadyCorrect: 0, rejected: 0, unknown: 0, observedCorrect: 0, observedIncorrect: 0 } as HistoryEntry);
    expect(decodeJournal(enc.encode(line + history + '\n')).corruptLines).toEqual([2, 3]);
    const forge = (payload: unknown): string => {
      const json = JSON.stringify(payload);
      return `${crc32(enc.encode(json)).toString(16).padStart(8, '0')} ${json}\n`;
    };
    for (const payload of [
      { v: 3, seq: 1, event: { type: 'started', attemptId: 'a', at: 1 } },
      { v: 2, seq: 0, event: { type: 'started', attemptId: 'a', at: 1 } },
      { v: 2, event: { type: 'started', attemptId: 'a', at: 1 } },
      { v: 2, seq: 1, event: { type: 'canvas-verified', at: 1 } },
      { v: 2, seq: 1, event: { type: 'leased', attempt: { ...leasedAttempt, state: 'started' } } },
    ]) {
      expect(decodeJournal(enc.encode(forge(payload))).corruptLines).toEqual([1]);
    }
  });

  it('property: a cut at any byte keeps exactly the complete lines before it, never reports damage', () => {
    const all = lines();
    const bytes = enc.encode(all.join(''));
    for (let cut = 0; cut <= bytes.length; cut++) {
      const decoded = decodeJournal(bytes.subarray(0, cut));
      let complete = 0;
      let length = 0;
      while (complete < all.length && length + all[complete]!.length <= cut) length += all[complete++]!.length;
      expect({ cut, n: decoded.entries.length, tail: decoded.discardedTailBytes, damage: decoded.corruptLines.length }).toEqual({ cut, n: complete, tail: cut - length, damage: 0 });
    }
  });

  it('property: one damaged byte never yields a forged event and is always visible', () => {
    const bytes = enc.encode(lines().join(''));
    const random = testRandom(0xc0ffee);
    const serialized = new Set(events().map((e, i) => JSON.stringify({ event: e, seq: i + 1 })));
    for (let i = 0; i < 3000; i++) {
      const copy = bytes.slice();
      const at = random(copy.length);
      const value = random(256);
      if (copy[at] === value) continue;
      copy[at] = value;
      const decoded = decodeJournal(copy);
      for (const e of decoded.entries) expect(serialized.has(JSON.stringify({ event: e.event, seq: e.seq }))).toBe(true);
      expect(decoded.corruptLines.length > 0 || decoded.discardedTailBytes > 0).toBe(true);
    }
  });

  it('property: the streaming scanner gives the same lines whatever the chunk sizes', () => {
    const text = lines().join('') + lines()[0]!.slice(0, 15);
    const bytes = enc.encode(text);
    const reference = decodeJournal(bytes);
    const random = testRandom(7);
    for (let run = 0; run < 200; run++) {
      const seen: { line: number; offset: number; ok: boolean }[] = [];
      const scanner = new JournalLineScanner((l) => seen.push({ line: l.line, offset: l.offset, ok: l.decoded !== null }));
      for (let at = 0; at < bytes.length; ) {
        const size = 1 + random(97);
        scanner.push(bytes.subarray(at, at + size));
        at += size;
      }
      expect(scanner.end()).toBe(15);
      expect(seen.filter((s) => s.ok)).toHaveLength(reference.entries.length);
      let offset = 0;
      for (const [i, s] of seen.entries()) {
        expect(s).toEqual({ line: i + 1, offset, ok: true });
        offset += lines()[i]!.length;
      }
    }
    expect(decodeJournalLine(enc.encode(lines()[1]!.trimEnd()))).toEqual({ event: events()[1], seq: 2 });
  });

  it('history entries use their own format and validation', () => {
    const entry: HistoryEntry = { at: 5, agent: 'a' as never, templateId: 't' as never, revision: 1, attemptId: 'x' as never, state: 'reconciled', applied: 0, alreadyCorrect: 0, rejected: 0, unknown: 1, observedCorrect: 2, observedIncorrect: 0 };
    const text = encodeHistoryLine(entry) + lines()[1]!;
    expect(decodeChecksummedLines(enc.encode(text), isHistoryEntry)).toEqual({ values: [entry], discardedTailBytes: 0, corruptLines: [2] });
    expect(isHistoryEntry({ ...entry, applied: -1 })).toBe(false);
  });
});

describe('checkpoint format', () => {
  const state: JournalState = {
    schemaVersion: 1,
    lastSeq: 42,
    open: [
      leasedAttempt,
      { ...leasedAttempt, attemptId: 'a2' as never, state: 'started', startedAt: 11 },
      { ...leasedAttempt, attemptId: 'a3' as never, state: 'needs-reconciliation', startedAt: 11, needsReconciliationAt: 12, reason: 'recovered: result unknown' },
    ],
    closed: [{ attemptId: 'c1' as never, agent: 'agent-1' as never, projectId: 'projet' as never, templateId: 'modèle' as never, revision: 1, state: 'finished', leasedAt: 1, startedAt: 2, closedAt: 3, pixels: 4, applied: 3, reconciled: false }],
    purgedClosed: 7,
    lastSpendAt: [{ agent: 'agent-1' as never, at: 3 }],
    canvasReadRequiredAfter: 40,
    preservedGenerations: [2],
  };

  it('round-trips, verified by SHA-256 and structure', async () => {
    const bytes = await encodeCheckpoint(3, state, testHasher);
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('GPCKPT1\n');
    const decoded = await decodeCheckpoint(bytes, testHasher, 3);
    expect(decoded.state).toEqual(state);
    expect(decoded.header).toMatchObject({ format: 1, generation: 3, lastSeq: 42 });
  });

  it('refuses a damaged, truncated, foreign or invalid checkpoint, with a reason code', async () => {
    const bytes = await encodeCheckpoint(3, state, testHasher);
    const reason = async (b: Uint8Array, generation?: number): Promise<string> => {
      try {
        await decodeCheckpoint(b, testHasher, generation);
        return 'ok';
      } catch (error) {
        return error instanceof CheckpointError ? error.code : String(error);
      }
    };
    expect(await reason(bytes, 4)).toBe('WRONG_GENERATION');
    expect(await reason(bytes.subarray(0, bytes.length - 1))).toBe('BAD_LENGTH');
    const flipped = bytes.slice();
    flipped[flipped.length - 5]! ^= 0x01;
    expect(await reason(flipped)).toBe('BAD_CHECKSUM');
    expect(await reason(enc.encode('not a checkpoint'))).toBe('BAD_MAGIC');
    expect(await reason(enc.encode('GPCKPT1\n{"format":1'))).toBe('BAD_HEADER');
    expect(await reason(enc.encode('GPCKPT1\n{"format":9,"generation":1,"lastSeq":0,"bodyBytes":0,"bodySha256":""}\n'))).toBe('UNSUPPORTED_VERSION');
    await expect(encodeCheckpoint(1, { ...state, lastSeq: -1 }, testHasher)).rejects.toThrow();
    await expect(encodeCheckpoint(0, state, testHasher)).rejects.toThrow();
  });

  it('validates the state: open attempts consistent with their state, unique ids, closed summaries', () => {
    expect(isJournalState(state)).toBe(true);
    const bad: unknown[] = [
      { ...state, schemaVersion: 2 },
      { ...state, open: [{ ...leasedAttempt, state: 'started' }] },
      { ...state, open: [{ ...leasedAttempt, state: 'finished' }] },
      { ...state, open: [leasedAttempt, leasedAttempt] },
      { ...state, closed: [{ ...state.closed[0], applied: 9 }] },
      { ...state, closed: [{ ...state.closed[0], attemptId: 'a1' }] },
      { ...state, lastSpendAt: [{ agent: 'x', at: 1 }, { agent: 'x', at: 2 }] },
      { ...state, canvasReadRequiredAfter: -1 },
      { ...state, preservedGenerations: [-1] },
    ];
    for (const s of bad) expect(isJournalState(s)).toBe(false);
  });
});
