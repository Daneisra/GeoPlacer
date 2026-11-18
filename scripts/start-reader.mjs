/** Opt-in local reader. Its approval key is never served by the HTTP API or persisted. */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const key = randomBytes(32).toString('hex');
console.log('GeoPlacer — connexion navigateur. Placement d’un pixel, d’un lot ou d’une session bornée uniquement après autorisation explicite ; aucun achat.');
console.log('Clé locale d’approbation privée (à saisir dans le dashboard ; ne pas partager cette ligne) :');
console.log(key);
const child = spawn(
  process.execPath,
  ['--env-file-if-exists=.env', fileURLToPath(new URL('../dist/server.js', import.meta.url))],
  {
    env: { ...process.env, GEOPLACER_READER_APPROVAL_KEY: key },
    stdio: 'inherit',
    windowsHide: true,
  }
);
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
process.on('SIGINT', () => {
  if (process.platform !== 'win32') child.kill('SIGINT');
});
