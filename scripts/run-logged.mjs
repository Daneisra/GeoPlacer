// Runs an npm script and keeps its COMPLETE output (stdout and stderr) in
// test-logs/<date>-<script>.log, success or failure, so that an intermittent
// failure can always be examined afterwards. The exit code is preserved.
//
//   npm run check:logged          (= node scripts/run-logged.mjs check)
//   node scripts/run-logged.mjs test:packages
//
// test-logs/ is ignored by Git. Nothing is pruned automatically.
//
// Phase 1B.9: the log also records the duration and the state of the
// machine (processors, memory, and how busy the processors were, sampled
// every 5 s): a test slowed by another program is then visible in the log
// itself (Phase 1B.8 and 1B.9 timeouts, see docs/fr/qualite.md).

import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
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
const mib = (n) => `${Math.round(n / 1024 / 1024)} MiB`;
log.write(
  `# npm run ${script}\n# date ${new Date().toISOString()}\n# node ${process.version} ${process.platform}/${process.arch}\n# commit ${commit}\n` +
    `# machine ${cpus().length} logical processors, memory free ${mib(freemem())} of ${mib(totalmem())}\n\n`
);

// Machine-wide processor load (all processes), from the cumulated processor times.
const cpuTimes = () => cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + c.times.idle + c.times.user + c.times.sys + c.times.irq + c.times.nice }), { idle: 0, total: 0 });
let previous = cpuTimes();
const samples = [];
const started = Date.now();
const sampler = setInterval(() => {
  const now = cpuTimes();
  const total = now.total - previous.total;
  if (total > 0) samples.push(Math.round(100 * (1 - (now.idle - previous.idle) / total)));
  previous = now;
}, 5000);
sampler.unref();

const child = spawn(`npm run ${script}`, { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    log.write(chunk);
    (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
  });
}
child.on('close', (code, signal) => {
  clearInterval(sampler);
  const avg = samples.length === 0 ? null : Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  const busy = samples.filter((v) => v >= 90).length;
  log.write(
    `\n# duration ${Math.round((Date.now() - started) / 1000)} s\n` +
      `# machine load (all processes, every 5 s): average ${avg === null ? 'n/a' : `${avg} %`}, max ${samples.length === 0 ? 'n/a' : `${Math.max(...samples)} %`}, ${busy} sample(s) at 90 % or more\n` +
      `# memory free at the end ${mib(freemem())}\n`
  );
  log.end(`# exit code ${String(code)} signal ${String(signal)}\n`, () => {
    console.log(`\nFull log: ${path.relative(root, file)} (exit code ${String(code)})`);
    process.exit(code ?? 1);
  });
});
