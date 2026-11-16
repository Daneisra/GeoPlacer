/** Runs the real local channel in an ESM process (Jest's legacy CJS resolver cannot load workspace exports). */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
it('passes the eight actual HTTP/WebSocket security scenarios', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('scripts/test-connector-channel.mjs')], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 25_000,
  });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ passed: 8 });
}, 30_000);
