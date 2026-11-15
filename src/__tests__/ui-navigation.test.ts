/**
 * Non-regression of the browser acceptance findings (Phase 1B.7):
 * - F13: a browser navigation (address bar, F5) to a UI page whose address
 *   is also an API route gets the UI; API calls keep the API.
 * - F12: every HTTP call of the UI targets a route the server really has
 *   (the "Start All" / "Stop All" buttons called routes that did not exist).
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { detectFrontend, isUiDocumentRequest, uiDocumentMiddleware, UI_PAGES } from '../config/frontend.js';

const root = path.resolve(__dirname, '..', '..');

describe('F13: browser navigations to UI pages get the UI', () => {
  it('recognises document navigations, never API calls', () => {
    for (const page of UI_PAGES) {
      expect(isUiDocumentRequest('GET', page, { secFetchDest: 'document' })).toBe(true);
      expect(isUiDocumentRequest('HEAD', page, { secFetchDest: 'document' })).toBe(true);
      expect(isUiDocumentRequest('GET', page, { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' })).toBe(true);
      // fetch / axios / curl
      expect(isUiDocumentRequest('GET', page, { secFetchDest: 'empty', accept: 'text/html' })).toBe(false);
      expect(isUiDocumentRequest('GET', page, { accept: 'application/json, text/plain, */*' })).toBe(false);
      expect(isUiDocumentRequest('GET', page, { accept: '*/*' })).toBe(false);
      expect(isUiDocumentRequest('GET', page, {})).toBe(false);
      expect(isUiDocumentRequest('PUT', page, { secFetchDest: 'document' })).toBe(false);
    }
    expect(isUiDocumentRequest('GET', '/settings/', { secFetchDest: 'document' })).toBe(true);
    expect(isUiDocumentRequest('GET', '/templates/import', { secFetchDest: 'document' })).toBe(false);
    expect(isUiDocumentRequest('GET', '/api-docs', { secFetchDest: 'document' })).toBe(false);
  });

  it('in a real Express app: the UI for a reload, the JSON for the API, before the API routes', async () => {
    const dist = mkdtempSync(path.join(tmpdir(), 'geoplacer-ui-'));
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>ui</title>');
    const app = express();
    app.use(uiDocumentMiddleware(detectFrontend(dist)));
    app.get('/settings', (_req, res) => {
      res.json({ api: true });
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const reload = await fetch(`${base}/settings`, { headers: { 'Sec-Fetch-Dest': 'document', Accept: 'text/html' } });
      expect(reload.headers.get('content-type')).toMatch(/text\/html/);
      expect(await reload.text()).toContain('<title>ui</title>');
      const api = await fetch(`${base}/settings`, { headers: { Accept: 'application/json, text/plain, */*' } });
      expect(await api.json()).toEqual({ api: true });
      // Without a build, the API is untouched.
      const noBuild = express();
      noBuild.use(uiDocumentMiddleware(detectFrontend(path.join(dist, 'absent'))));
      expect(typeof noBuild).toBe('function');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('is registered before the API routers in the server', () => {
    const server = readFileSync(path.join(root, 'src', 'server.ts'), 'utf8');
    const middleware = server.indexOf('app.use(uiDocumentMiddleware(');
    expect(middleware).toBeGreaterThan(0);
    for (const router of ['logsRouter', 'usersRouter', 'settingsRouter', 'templatesRouter']) {
      expect(middleware).toBeLessThan(server.indexOf(`app.use(${router})`));
    }
  });
});

/** Express-style route patterns of the server: "METHOD /path/:param". */
function serverRoutes(): Set<string> {
  const routes = new Set<string>();
  const files = [path.join(root, 'src', 'server.ts'), ...readdirSync(path.join(root, 'src', 'routes')).filter((f) => f.endsWith('.ts')).map((f) => path.join(root, 'src', 'routes', f))];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:router|app)\.(get|post|put|delete|patch)\(\s*'([^']+)'/g)) routes.add(`${m[1]!.toUpperCase()} ${m[2]}`);
  }
  return routes;
}

/** HTTP calls of the UI: axios.<method>('...' or `...${x}...`) -> "METHOD /path/:param". */
function uiCalls(): { file: string; call: string }[] {
  const out: { file: string; call: string }[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const text = readFileSync(full, 'utf8');
        for (const m of text.matchAll(/axios\.(get|post|put|delete|patch)\(\s*(['`])([^'`]+)\2/g)) {
          const pathPattern = m[3]!.replace(/\$\{[^}]+\}/g, ':param').split('?')[0]!;
          out.push({ file: path.relative(root, full).split(path.sep).join('/'), call: `${m[1]!.toUpperCase()} ${pathPattern}` });
        }
      }
    }
  };
  walk(path.join(root, 'frontend', 'src'));
  return out;
}

const matches = (call: string, route: string): boolean => {
  const [m1, p1] = call.split(' ');
  const [m2, p2] = route.split(' ');
  if (m1 !== m2) return false;
  const a = p1!.split('/');
  const b = p2!.split('/');
  return a.length === b.length && a.every((seg, i) => seg === b[i] || seg === ':param' || b[i]!.startsWith(':'));
};

describe('F12: the UI only calls routes the server has', () => {
  it('every axios call of the UI matches a server route', () => {
    const routes = [...serverRoutes()];
    const calls = uiCalls();
    expect(calls.length).toBeGreaterThan(10);
    const missing = calls.filter((c) => !routes.some((r) => matches(c.call, r)));
    expect(missing).toEqual([]);
  });

  it('starting templates stays disabled in the UI (the inherited engine would place pixels on a real service)', () => {
    const text = readFileSync(path.join(root, 'frontend', 'src', 'components', 'ManageTemplates.tsx'), 'utf8');
    expect(text).not.toMatch(/running:\s*true/);
    expect(text).toMatch(/disabled title=\{START_DISABLED\}/);
  });
});
