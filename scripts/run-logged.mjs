// Runs an npm script and keeps its COMPLETE output (stdout and stderr) in
// test-logs/<date>-<script>.log, success or failure, so that an intermittent
// failure can always be examined afterwards. The exit code is preserved.
//
//   npm run check:logged          (= node scripts/run-logged.mjs check)
//   node scripts/run-logged.mjs test:packages
//
// test-logs/ is ignored by Git. Nothing is pruned automatically.

import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = process.argv[2];
if (!script || !/^[\w:.-]+$/.test(script)) {
  console.error('usage: node scripts/run-logged.mjs <npm-script>');
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'test-logs');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = path.join(dir, `${stamp}-${script.replace(/:/g, '_')}.log`);
const log = createWriteStream(file);

let commit = 'unknown';
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} catch {
  /* not a git checkout */
}
log.write(`# npm run ${script}\n# date ${new Date().toISOString()}\n# node ${process.version} ${process.platform}/${process.arch}\n# commit ${commit}\n\n`);

const child = spawn(`npm run ${script}`, { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    log.write(chunk);
    (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
  });
}
child.on('close', (code, signal) => {
  log.end(`\n# exit code ${String(code)} signal ${String(signal)}\n`, () => {
    console.log(`\nFull log: ${path.relative(root, file)} (exit code ${String(code)})`);
    process.exit(code ?? 1);
  });
});
