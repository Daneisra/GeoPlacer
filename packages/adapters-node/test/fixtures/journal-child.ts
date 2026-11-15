/**
 * Child process of the journal crash test: recovers the journal of the data
 * directory, then runs the deterministic attempt scenario with compactions,
 * and KILLS ITSELF when it reaches the named step (explicit
 * synchronisation: no timer). It prints "reached <step>" just before.
 *
 * step = `<operation>:<file name prefix>:<phase>#<occurrence>`, phase being
 * before / after the operation, or `partial` (half of a write, then killed).
 * Everything is local; the resource rules are synthetic.
 * argv: <data root> <round> <step>
 */

import { writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { acquireDataDirectoryLock, nodeJournalFs } from '../../src/index.js';
import { FaultyFs } from '../helpers/faulty-fs.js';
import { openHarness, runSteps } from '../helpers/journal-scenario.js';

const [root, roundArg, step] = process.argv.slice(2);
if (root === undefined || roundArg === undefined || step === undefined) throw new Error('usage: journal-child <root> <round> <step>');
const round = Number(roundArg);
const [spec, occurrenceText] = step.split('#');
const [op, prefix, phase] = spec!.split(':');
const occurrence = Number(occurrenceText);
let seen = 0;
let partialArmed = false;

function die(): never {
  writeSync(1, `reached ${step}\n`);
  process.kill(process.pid, 'SIGKILL');
  throw new Error('unreachable');
}

const fs = new FaultyFs(nodeJournalFs);
fs.onCall = (call, when) => {
  if (call.op !== op || !call.name.startsWith(prefix!)) return;
  if (phase === 'partial') {
    if (when === 'before' && ++seen === occurrence) {
      // The next check in FaultyFs fails this very call: half of it is written, then it throws.
      fs.armed = true;
      fs.mode = 'partial';
      fs.count = 0;
      fs.failAt = 0;
      partialArmed = true;
    }
    return;
  }
  if (when === phase && ++seen === occurrence) die();
};

const lock = await acquireDataDirectoryLock(root);
const retention = op === 'remove' ? 1 : 100;
const h = openHarness(lock, { fs, retainGenerations: retention, base: (round + 1) * 1_000_000_000, idPrefix: `r${round}` });

async function main(): Promise<void> {
  await h.manager.recover(++h.clock.now);
  // The expected state, written before every compaction (a compaction never changes it).
  const compact = h.manager.compact.bind(h.manager);
  h.manager.compact = async (now, options) => {
    writeFileSync(path.join(root!, 'expected-state.json'), JSON.stringify(h.manager.state()), { flush: true });
    return compact(now, options);
  };
  await runSteps(h, round * 1000, 60, 8);
  process.stdout.write('done without reaching the step\n');
}

main().catch((error: unknown) => {
  if (partialArmed) die();
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
