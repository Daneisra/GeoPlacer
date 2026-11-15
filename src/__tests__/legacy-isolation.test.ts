/**
 * Phase 1B.10: isolation of the inherited Wplacer features. Negative tests:
 * the routes that could reach Wplace or run the inherited engine are refused
 * (whatever the spelling), the inherited HTTP client refuses any request,
 * purely local routes still work, and no outgoing connection is attempted.
 */

import express from 'express';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

// The inherited browser-like client (native): it must never be constructed.
const impitConstructed: unknown[] = [];
jest.mock('impit', () => ({
  Impit: jest.fn().mockImplementation((options: unknown) => {
    impitConstructed.push(options);
    throw new Error('the inherited network client must never be constructed');
  }),
}));

import { applyBaseProtections } from '../app-base.js';
import { DISABLED_LEGACY_ROUTES, LEGACY_DISABLED_CODE, disabledLegacyRoute, legacyGuard } from '../middleware/legacy-guard.js';
import { buildAllowedHostnames, compileOriginPatterns } from '../middleware/local-access.js';
import { LegacyNetworkDisabledError, WPlaceHttpClient } from '../services/http-client.js';
import { WPlacer } from '../services/wplacer-client.js';
import usersRouter, { setUsersState, setTemplatesState as setUsersTemplates, setSaveUsers, setSaveTemplates as setUsersSaveTemplates, setActiveBrowserUsers } from '../routes/users.js';
import templatesRouter, { setTemplatesState, setUsersState as setTemplatesUsers, setSettingsState as setTemplatesSettings, setSaveTemplates, setTemplateQueue, setProcessQueueFn } from '../routes/templates.js';
import settingsRouter, { setSettingsState, setSaveSettings, setLoadedProxies } from '../routes/settings.js';
import tokensRouter from '../routes/tokens.js';
import bridgeRouter from '../routes/bridge.js';
import proxyRouter, { setProxyFunctions } from '../routes/proxy.js';
import paletteRouter from '../routes/palette.js';
import { createEngineRouter } from '../api/v1/engine-router.js';
import type { EngineApi } from '../api/v1/engine-api.js';

// Every outgoing TCP connection attempted during these tests (only loopback is expected).
const connections: string[] = [];
const originalConnect = net.Socket.prototype.connect;
beforeAll(() => {
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const first = args[0] as { host?: string; port?: number } | number | string;
    const host = typeof first === 'object' && first !== null ? (first.host ?? 'localhost') : typeof args[1] === 'string' ? args[1] : 'localhost';
    connections.push(String(host));
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
});
afterAll(() => {
  net.Socket.prototype.connect = originalConnect;
});

let processQueueCalls = 0;
let server: http.Server;
let port: number;

beforeAll(async () => {
  const users = {};
  const settings = { drawingDirection: 'ttb' } as never;
  setUsersState(users);
  setUsersTemplates({});
  setSaveUsers(() => undefined);
  setUsersSaveTemplates(() => undefined);
  setActiveBrowserUsers(new Set());
  setTemplatesState({});
  setTemplatesUsers(users);
  setTemplatesSettings(settings);
  setSaveTemplates(() => undefined);
  setTemplateQueue([]);
  setProcessQueueFn(() => {
    processQueueCalls++;
  });
  setSettingsState(settings);
  setSaveSettings(() => undefined);
  setLoadedProxies([]);
  setProxyFunctions(() => undefined, []);

  const app = express();
  applyBaseProtections(app, {
    policy: { allowedHostnames: buildAllowedHostnames('127.0.0.1'), originPatterns: compileOriginPatterns(['http://localhost:*', 'http://127.0.0.1:*', 'chrome-extension://*']) },
    rateLimitWindowMs: 60_000,
    rateLimitMax: 10_000,
    jsonLimit: '1mb',
  });
  app.use(legacyGuard());
  app.use('/api/v1', createEngineRouter({ status: () => ({}) } as unknown as EngineApi));
  for (const r of [usersRouter, templatesRouter, settingsRouter, tokensRouter, bridgeRouter, proxyRouter, paletteRouter]) app.use(r);
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON read by the test
function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }) } },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => {
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            // not JSON (HEAD, empty)
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

const SAMPLES: [string, string, unknown?][] = [
  ['POST', '/user', { cookies: { j: 'x' } }],
  ['GET', '/user/status/123'],
  ['POST', '/users/status', {}],
  ['POST', '/template', { templateName: 'x' }],
  ['POST', '/templates/import', {}],
  ['PUT', '/template/edit/abc', {}],
  ['PUT', '/template/abc', { running: true }],
  ['GET', '/token-needed'],
  ['POST', '/t', { t: 'token' }],
  ['POST', '/bridge', {}],
  ['GET', '/sign-request'],
  ['POST', '/sign-response', {}],
  ['POST', '/bot/activate', {}],
  ['POST', '/bot/deactivate', {}],
  ['POST', '/reload-proxies', {}],
];

describe('inherited features refused (Phase 1B.10)', () => {
  it('lists one sample per disabled route', () => {
    expect(SAMPLES.length).toBe(DISABLED_LEGACY_ROUTES.length);
    for (const [method, path] of SAMPLES) expect(disabledLegacyRoute(method, path)).toBeDefined();
  });

  // Always three arguments: with two, Jest would take the third parameter for a `done` callback.
  it.each(SAMPLES.map(([m, p, b]) => [m, p, b ?? null] as const))('%s %s is refused with a stable code, before its handler', async (method, path, body) => {
    const r = await call(method, path, body ?? undefined);
    expect(r.status).toBe(410);
    expect(r.body).toMatchObject({ code: LEGACY_DISABLED_CODE });
    expect(String(r.body.error)).toMatch(/Désactivé dans GeoPlacer V1/);
  });

  it('cannot be bypassed by the spelling of the path, HEAD, or a disguised start', async () => {
    for (const [method, path] of [
      ['POST', '/USER'],
      ['POST', '/user/'],
      ['GET', '/User/Status/abc/'],
      ['POST', '/Reload-Proxies'],
      ['POST', '/BOT/activate'],
    ] as const) {
      expect((await call(method, path, method === 'GET' ? undefined : {})).status).toBe(410);
    }
    expect((await call('HEAD', '/token-needed')).status).toBe(410);
    expect((await call('HEAD', '/sign-request')).status).toBe(410);
    for (const body of [{ running: true }, {}, { running: 'false' }, { running: 0 }]) expect((await call('PUT', '/template/abc', body)).status).toBe(410);
    expect(processQueueCalls).toBe(0);
    // The new API never forwards to the inherited routes.
    expect((await call('POST', '/api/v1/user', {})).status).toBe(404);
  });

  it('keeps the purely local inherited routes', async () => {
    expect((await call('GET', '/users')).status).toBe(200);
    expect((await call('GET', '/templates')).status).toBe(200);
    expect((await call('GET', '/settings')).status).toBe(200);
    expect((await call('GET', '/palette')).status).toBe(200);
    expect((await call('DELETE', '/user/unknown')).status).toBe(400);
    // Stopping an inherited template is the safe direction: it reaches its handler (unknown template here).
    const stop = await call('PUT', '/template/abc', { running: false });
    expect(stop.status).not.toBe(410);
    expect(processQueueCalls).toBe(0);
  });
});

describe('the inherited network client refuses any request', () => {
  it('refuses to start a session, to switch accounts and to send a request', async () => {
    const client = new WPlaceHttpClient();
    await expect(client.initialize({ j: 'x' })).rejects.toBeInstanceOf(LegacyNetworkDisabledError);
    await expect(client.fetch('https://example.invalid/')).rejects.toBeInstanceOf(LegacyNetworkDisabledError);
    await expect(client.post('https://example.invalid/', {})).rejects.toBeInstanceOf(LegacyNetworkDisabledError);
    await expect(client.switchUser({ j: 'x' })).rejects.toBeInstanceOf(LegacyNetworkDisabledError);
  });

  it('an inherited account login (what the keep-alive did) fails before any network access', async () => {
    await expect(new WPlacer({}).login({ j: 'x' })).rejects.toBeInstanceOf(LegacyNetworkDisabledError);
  });

  it('never constructed the network client and never connected anywhere but the loopback', () => {
    expect(impitConstructed).toEqual([]);
    expect(connections.filter((h) => !['127.0.0.1', 'localhost', '::1'].includes(h))).toEqual([]);
  });
});
