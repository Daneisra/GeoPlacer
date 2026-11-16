/**
 * Phase 1C.0: the release candidate stays strictly local and simulated. Static guarantees about the
 * files a user runs (installation, update, launch, demonstration) and the inherited keep-alive,
 * complementing the behavioural tests (legacy-isolation, server-engine, no-network in the engine).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

describe('release safety (Phase 1C.0)', () => {
  it('the inherited keep-alive is never called: only defined, and neutralised by `void`', () => {
    const server = read('src/server.ts');
    const calls = server.match(/\brunKeepAlive\s*\(/g) ?? [];
    // The definition "async function runKeepAlive(): Promise<void>" is the only "runKeepAlive(" occurrence.
    expect(calls).toHaveLength(1);
    expect(server).toMatch(/async function runKeepAlive\(\)/);
    expect(server).toMatch(/void runKeepAlive;/);
    // No timer uses its interval.
    expect(server).not.toMatch(/setInterval\([^)]*KEEP_ALIVE_INTERVAL_MS/);
  });

  it('.env.example enables nothing inherited and holds no secret', () => {
    const lines = read('.env.example')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    for (const line of lines) {
      expect(line).not.toMatch(/^\s*LEGACY_/);
      expect(line).not.toMatch(/(TOKEN|COOKIE|SECRET|PASSWORD|PROXY)\s*=/i);
    }
  });

  it('the scripts a user runs never re-enable inherited features nor call inherited routes', () => {
    const files = ['scripts/setup-windows.mjs', 'start.bat', 'setup.bat', 'update.bat', 'package.json'];
    const inheritedRoutes = /['"`/](user|users\/status|template|templates\/import|token-needed|t|bridge|sign-request|sign-response|bot\/activate|bot\/deactivate|reload-proxies)['"`]/;
    for (const f of files) {
      const text = read(f);
      expect({ f, legacyVariable: /LEGACY_KEEPALIVE\s*=|set\s+LEGACY_/i.test(text) }).toEqual({ f, legacyVariable: false });
      expect({ f, inheritedRoute: inheritedRoutes.test(text.replace(/\/\/.*$/gm, '')) }).toEqual({ f, inheritedRoute: false });
    }
    // The launch and demonstration scripts start the compiled server only (no inherited entry point).
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts.start).toBe('node --env-file-if-exists=.env dist/server.js');
    expect(scripts.demo).toBe('node --env-file-if-exists=.env dist/server.js --demo');
  });

  it('update.bat installs nothing on Windows by itself (no winget call)', () => {
    const lines = read('update.bat')
      .split(/\r?\n/)
      .filter((l) => !/^\s*(rem|echo)\b/i.test(l));
    expect(lines.join('\n')).not.toMatch(/\bwinget\b/i);
  });
});
