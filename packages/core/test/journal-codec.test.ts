import { describe, expect, it } from 'vitest';
import type { HistoryEntry, JournalEvent } from '../src/index.js';
import { decodeChecksummedLines, decodeJournal, encodeHistoryLine, encodeJournalLine, isHistoryEntry } from '../src/index.js';
import { testRandom } from './helpers/strategy.js';

const enc = new TextEncoder();

function events(): JournalEvent[] {
  return [
    {
      type: 'leased',
      attempt: {
        attemptId: 'a1' as never,
        agent: 'agent-1' as never,
        projectId: 'projet' as never,
        templateId: 'modèle' as never,
        revision: 2,
        writes: [{ taskId: 'projet/modèle@2:0,0:#ff0000' as never, point: { x: 0, y: -3 }, color: 0xff0000 as never }],
        energyCost: 1,
        state: 'leased',
        leasedAt: 10,
        expiresAt: 20,
        startedAt: null,
        needsReconciliationAt: null,
        closedAt: null,
        results: [],
        reason: null,
      },
    },
    { type: 'started', attemptId: 'a1' as never, at: 11 },
    { type: 'failed', attemptId: 'a1' as never, at: 12, reason: 'réseau coupé ☂ 😀', outcomes: [{ taskId: 't' as never, status: 'rejected', reason: 'no-energy' }] },
    { type: 'needs-reconciliation', attemptId: 'a2' as never, at: 13, reason: 'r' },
    { type: 'reconciled', attemptId: 'a2' as never, at: 14, results: [{ taskId: 't' as never, result: 'observed-unknown' }] },
    { type: 'cancelled', attemptId: 'a3' as never, at: 15, reason: '' },
    { type: 'finished', attemptId: 'a4' as never, at: 16, outcomes: [{ taskId: 't' as never, status: 'unknown' }] },
  ];
}

describe('journal line format', () => {
  it('round-trips every event kind, in pure ASCII, one line each', () => {
    const text = events().map(encodeJournalLine).join('');
    expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
    expect(text.split('\n')).toHaveLength(events().length + 1);
    expect(decodeJournal(enc.encode(text))).toEqual({ events: events(), discardedTailBytes: 0, corruptLines: [] });
    expect(decodeJournal(new Uint8Array(0))).toEqual({ events: [], discardedTailBytes: 0, corruptLines: [] });
  });

  it('rejects a valid checksum over an invalid event, an unknown version, an empty line', () => {
    const line = encodeJournalLine({ type: 'started', attemptId: 'a' as never, at: 1 });
    // A line with a valid checksum but a payload of another type (a history entry); then an empty line.
    const history = encodeHistoryLine({ at: 1, agent: 'a', templateId: 't', revision: 1, attemptId: 'x', state: 'finished', applied: 0, alreadyCorrect: 0, rejected: 0, unknown: 0, observedCorrect: 0, observedIncorrect: 0 } as HistoryEntry);
    expect(decodeJournal(enc.encode(line + history + '\n')).corruptLines).toEqual([2, 3]);
    const v2 = line.replace('"v":1', '"v":2');
    expect(decodeJournal(enc.encode(v2)).corruptLines).toEqual([1]);
  });

  it('property: a cut at any byte keeps exactly the complete lines before it, never reports damage', () => {
    const lines = events().map(encodeJournalLine);
    const bytes = enc.encode(lines.join(''));
    for (let cut = 0; cut <= bytes.length; cut++) {
      const decoded = decodeJournal(bytes.subarray(0, cut));
      let complete = 0;
      let length = 0;
      while (complete < lines.length && length + lines[complete]!.length <= cut) length += lines[complete++]!.length;
      expect({ cut, n: decoded.events.length, tail: decoded.discardedTailBytes, damage: decoded.corruptLines.length }).toEqual({ cut, n: complete, tail: cut - length, damage: 0 });
    }
  });

  it('property: one damaged byte never yields a forged event and is always visible', () => {
    const original = events();
    const bytes = enc.encode(original.map(encodeJournalLine).join(''));
    const random = testRandom(0xc0ffee);
    const serialized = new Set(original.map((e) => JSON.stringify(e)));
    for (let i = 0; i < 3000; i++) {
      const copy = bytes.slice();
      const at = random(copy.length);
      const value = random(256);
      if (copy[at] === value) continue;
      copy[at] = value;
      const decoded = decodeJournal(copy);
      for (const e of decoded.events) expect(serialized.has(JSON.stringify(e))).toBe(true);
      expect(decoded.corruptLines.length > 0 || decoded.discardedTailBytes > 0).toBe(true);
    }
  });

  it('history entries use the same format and their own validation', () => {
    const entry: HistoryEntry = { at: 5, agent: 'a' as never, templateId: 't' as never, revision: 1, attemptId: 'x' as never, state: 'reconciled', applied: 0, alreadyCorrect: 0, rejected: 0, unknown: 1, observedCorrect: 2, observedIncorrect: 0 };
    const text = encodeHistoryLine(entry) + encodeJournalLine(events()[1]!);
    expect(decodeChecksummedLines(enc.encode(text), isHistoryEntry)).toEqual({ values: [entry], discardedTailBytes: 0, corruptLines: [2] });
    expect(isHistoryEntry({ ...entry, applied: -1 })).toBe(false);
  });
});
