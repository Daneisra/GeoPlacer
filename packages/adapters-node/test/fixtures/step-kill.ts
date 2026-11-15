/**
 * Named-step kill for the crash children (Phase 1B.8): a step is
 * `<storage step>:<file name suffix>#<occurrence>`, e.g.
 * `temp-written:manifest.json#2`. When the storage hook reaches it (counted
 * only once armed), the child prints "reached <step>" and kills itself:
 * explicit synchronisation, no timer.
 */

import { writeSync } from 'node:fs';
import type { StorageStep } from '../../src/index.js';

export function stepKiller(step: string): { readonly onStep: (s: StorageStep, file: string) => void; arm(): void } {
  const [spec, occurrence] = step.split('#');
  const [kind, suffix] = spec!.split(':');
  const target = Number(occurrence);
  if (!kind || !suffix || !Number.isSafeInteger(target) || target < 1) throw new Error(`bad step ${step}`);
  let armed = false;
  let seen = 0;
  return {
    arm: () => {
      armed = true;
    },
    onStep: (s, file) => {
      if (!armed || s !== kind || !(file.endsWith(suffix) || file.startsWith(suffix))) return;
      if (++seen === target) {
        writeSync(1, `reached ${step}\n`);
        process.kill(process.pid, 'SIGKILL');
      }
    },
  };
}
