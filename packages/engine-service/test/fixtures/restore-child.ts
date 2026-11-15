/**
 * Crash child of the restore tests (Phase 1B.10). argv: <backup> <data> <step>.
 * Restores, and kills itself at the named step (explicit synchronisation, no timer).
 */

import { writeSync } from 'node:fs';
import { restoreBackup, type RestoreStep } from '../../src/index.js';

const [backup, data, step] = process.argv.slice(2);
if (backup === undefined || data === undefined || step === undefined) throw new Error('usage: restore-child <backup> <data> <step>');
writeSync(1, 'ready\n');
await restoreBackup(backup, data, {
  onStep: (s: RestoreStep) => {
    if (s === step) {
      writeSync(1, `reached ${step}\n`);
      process.kill(process.pid, 'SIGKILL');
    }
  },
});
writeSync(1, 'done\n');
