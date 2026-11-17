import { spawnSync } from 'node:child_process';
import path from 'node:path';
it('passes the single-pixel HTTP/browser workflow and security scenarios without contacting GeoPixels', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('scripts/test-single-pixel.mjs')], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 25_000,
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ passed: 8, realPlacements: 0 });
}, 30_000);
