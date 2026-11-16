/**
 * /api/v1 routes and engine WebSocket channel (Phase 1B.9), behind the same
 * protections as the server (app-base.ts), with a fake engine: the routes
 * contain no rule, the engine decides.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { applyBaseProtections } from '../app-base.js';
import { createEngineRouter } from '../api/v1/engine-router.js';
import { attachEngineSocket, type SocketLike } from '../api/v1/engine-socket.js';
import type { EngineApi, EngineEventEnvelopeLike } from '../api/v1/engine-api.js';
import { buildAllowedHostnames, compileOriginPatterns, type LocalAccessPolicy } from '../middleware/local-access.js';

class FakeEngineError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
  }
}

function fakeEngine() {
  const calls: string[] = [];
  const listeners = new Set<(e: EngineEventEnvelopeLike) => void>();
  let seq = 0;
  let state = 'stopped';
  const result = (changed: boolean) => ({ changed, status: { state } });
  const api: EngineApi & { calls: string[]; emit(type: string, extra?: Record<string, unknown>): void; listeners: number } = {
    calls,
    get listeners() {
      return listeners.size;
    },
    emit(type, extra = {}) {
      const e = { stream: 's1', seq: ++seq, at: 1, event: { type, ...extra } };
      for (const l of listeners) l(e);
    },
    status: () => ({ state, mode: 'simulation' }),
    start: async () => {
      calls.push('start');
      if (state === 'running') return result(false);
      state = 'running';
      return result(true);
    },
    pause: async () => {
      if (state !== 'running') throw new FakeEngineError('NOT_RUNNING', 409, 'the simulation is not running');
      return result(true);
    },
    resume: () => {
      throw new FakeEngineError('NOT_PAUSED', 409, 'nothing to resume');
    },
    stop: async (o) => (calls.push(`stop:${String(o?.abort)}`), result(true)),
    subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    get stream() {
      return { id: 's1', seq };
    },
    listTemplates: async () => ({ templates: [] }),
    importTemplate: async (i) => (calls.push(`import:${i.name}:${i.png.length}:${i.strategy}`), { templateId: 'abc' }),
    templateInfoOf: async (id) => {
      if (id !== 'abc') throw new FakeEngineError('TEMPLATE_NOT_FOUND', 404, 'not found');
      return { templateId: id };
    },
    templateImage: async () => ({}),
    selectTemplate: async (id) => (calls.push(`select:${id}`), result(true)),
    moveTemplate: async () => ({}),
    settings: { schemaVersion: 1 },
    configure: async (p) => (calls.push(`configure:${JSON.stringify(p)}`), result(true)),
    resetWorld: async (c) => (calls.push(`reset:${c}`), result(true)),
    resetAgent: async () => result(true),
    canvasRegion: async (r) => (calls.push(`canvas:${JSON.stringify(r ?? null)}`), { seq }),
    simulateExternalEdit: async () => ({ changed: 1 }),
    resourcesView: async () => {
      throw new Error('secret internal detail C:\\Users\\someone\\data');
    },
    applyUpgrade: async (id, confirmed) => (calls.push(`upgrade:${id}:${String(confirmed)}`), {}),
    attemptsView: () => ({ open: [], recent: [] }),
    journalDiagnosis: async () => ({ mode: 'full' }),
    compact: async () => {
      throw new FakeEngineError('COMPACTION_IN_PROGRESS', 409, 'a compaction is already in progress');
    },
    backup: async () => (calls.push('backup'), { name: 'geoplacer-sauvegarde-x', files: 3, bytes: 10, createdAt: 'now' }),
    demoAvailability: async () => ({ available: true, reason: null, active: false }),
    setupDemo: async () => (calls.push('demo'), result(true)),
    importGhost: async (input) => (calls.push(`ghost:${input.name}:${input.palette.length}:${input.x ?? '-'}`), { templateId: 'fantome', width: 2, height: 2 }),
    listGhosts: async () => ({ templates: [], unreadable: 0 }),
    ghostInfoOf: async (id) => ({ templateId: id }),
    // A hostile file name: it must never reach the Content-Disposition header as is.
    exportGhost: async (id) => (calls.push(`export:${id}`), { png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), filename: 'evil"\r\nX-Injected: 1.png' }),
    deleteGhost: async (id) => (calls.push(`delete:${id}`), { deleted: id }),
  };
  return api;
}

const policy: LocalAccessPolicy = {
  allowedHostnames: buildAllowedHostnames('127.0.0.1'),
  originPatterns: compileOriginPatterns(['http://localhost:*', 'http://127.0.0.1:*', 'chrome-extension://*']),
};

let server: http.Server;
let port: number;
let engine: ReturnType<typeof fakeEngine>;

beforeAll(async () => {
  engine = fakeEngine();
  const app = express();
  applyBaseProtections(app, { policy, rateLimitWindowMs: 60_000, rateLimitMax: 1000, jsonLimit: '64kb' });
  app.use('/api/v1', createEngineRouter(engine));
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Answer {
  readonly status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON read by the test
  readonly body: any;
  readonly headers: http.IncomingHttpHeaders;
}

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => {
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            // plain text
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

describe('/api/v1: commands and errors', () => {
  it('reads the status, and starts (idempotent: a second start reports no change)', async () => {
    const status = await call('GET', '/api/v1/engine/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ mode: 'simulation' });
    expect(status.headers['cache-control']).toBe('no-store');
    expect((await call('POST', '/api/v1/engine/start', {})).body).toMatchObject({ changed: true });
    expect((await call('POST', '/api/v1/engine/start', {})).body).toMatchObject({ changed: false });
  });

  it('answers an engine refusal with its stable code and status', async () => {
    const r = await call('POST', '/api/v1/engine/resume', {});
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: { code: 'NOT_PAUSED', message: 'nothing to resume' } });
    const c = await call('POST', '/api/v1/journal/compact', {});
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('COMPACTION_IN_PROGRESS');
    const t = await call('GET', '/api/v1/templates/zzz');
    expect(t.status).toBe(404);
    expect(t.body.error.code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('never leaks an internal error (no stack, no path)', async () => {
    const r = await call('GET', '/api/v1/resources');
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(r.body)).not.toMatch(/secret|Users|stack/);
  });

  it('validates every body strictly: unknown fields, wrong types, bad ids, bad base64', async () => {
    const extra = await call('POST', '/api/v1/engine/stop', { abort: true, force: true });
    expect(extra.status).toBe(400);
    expect(extra.body.error.code).toBe('INVALID_REQUEST');
    expect((await call('POST', '/api/v1/engine/stop', { abort: 'yes' })).status).toBe(400);
    expect((await call('PUT', '/api/v1/engine/selection', { templateId: '../etc' })).status).toBe(400);
    expect((await call('POST', '/api/v1/templates', { name: 'x', pngBase64: '***', x: 0, y: 0, strategy: 'top-to-bottom' })).status).toBe(400);
    expect((await call('POST', '/api/v1/templates', { name: 'x', pngBase64: 'iVBORw0K', x: 0, y: 0, strategy: 'teleport' })).status).toBe(400);
    expect((await call('POST', '/api/v1/simulator/external-edit', { count: 1e9 })).status).toBe(400);
    expect((await call('GET', '/api/v1/simulator/canvas?x=1&y=2')).status).toBe(400);
    expect((await call('PUT', '/api/v1/simulator/settings', { simulator: { width: -5 } })).status).toBe(400);
    expect(engine.calls.filter((c) => c.startsWith('configure'))).toEqual([]);
  });

  it('passes valid commands through, unchanged', async () => {
    expect((await call('POST', '/api/v1/engine/stop', { abort: true })).status).toBe(200);
    expect((await call('PUT', '/api/v1/engine/selection', { templateId: 'abc' })).status).toBe(200);
    expect((await call('POST', '/api/v1/templates', { name: ' Fresque ', pngBase64: 'iVBORw0KGgo=', x: 1, y: 2, strategy: 'random' })).status).toBe(200);
    expect((await call('PUT', '/api/v1/simulator/settings', { simulator: { width: 128 }, resetWorld: true })).status).toBe(200);
    expect((await call('POST', '/api/v1/resources/upgrades', { proposalId: 'p1', confirm: true })).status).toBe(200);
    expect((await call('GET', '/api/v1/simulator/canvas?x=1&y=2&w=3&h=4')).status).toBe(200);
    expect(engine.calls).toEqual(
      expect.arrayContaining(['stop:true', 'select:abc', 'import:Fresque:8:random', 'configure:{"simulator":{"width":128},"resetWorld":true}', 'upgrade:p1:true', 'canvas:{"minX":1,"minY":2,"width":3,"height":4}'])
    );
  });

  it('backs up without any client-chosen path (a path in the body is refused)', async () => {
    expect((await call('POST', '/api/v1/backup', {})).body).toMatchObject({ name: 'geoplacer-sauvegarde-x' });
    expect((await call('POST', '/api/v1/backup', { out: 'C:/Windows' })).status).toBe(400);
  });

  it('an unknown /api/v1 route is a JSON 404, never the UI', async () => {
    const r = await call('GET', '/api/v1/nothing-here');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });
});

describe('/api/v1: protections (Phase 1A kept, plus the engine guards)', () => {
  it('refuses a foreign origin and a foreign Host (DNS rebinding)', async () => {
    expect((await call('POST', '/api/v1/engine/start', {}, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('GET', '/api/v1/engine/status', undefined, { Host: 'evil.example' })).status).toBe(403);
  });

  it('refuses a browser extension origin, although the inherited routes still allow it', async () => {
    const r = await call('POST', '/api/v1/engine/start', {}, { Origin: 'chrome-extension://abcdefghijklmnop' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN_ORIGIN');
  });

  it('accepts the dashboard origin', async () => {
    expect((await call('GET', '/api/v1/engine/status', undefined, { Origin: `http://127.0.0.1:${port}` })).status).toBe(200);
  });

  it('refuses a state-changing request that is not JSON (cross-site forms)', async () => {
    const r = await call('POST', '/api/v1/engine/start', 'a=1', { 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(r.status).toBe(415);
    expect(r.body.error.code).toBe('JSON_REQUIRED');
    expect((await call('POST', '/api/v1/engine/stop', undefined)).status).toBe(415);
  });

  it('refuses a body above the size limit', async () => {
    const r = await call('POST', '/api/v1/templates', { name: 'x', pngBase64: 'A'.repeat(100_000), x: 0, y: 0, strategy: 'random' });
    expect(r.status).toBe(413);
  });
});

describe('GeoPixels ghost image export routes (Phase 1C.1)', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

  it('imports with the player palette; bounded palette, sizes and coordinates', async () => {
    const ok = await call('POST', '/api/v1/geopixels/templates', { name: 'Fantôme', pngBase64: png, palette: ['#ff0000', '00ff00'], x: 107958, y: 196137 });
    expect(ok.status).toBe(200);
    expect(engine.calls).toContain('ghost:Fantôme:2:107958');
    for (const bad of [
      { name: 'x', pngBase64: png },
      { name: 'x', pngBase64: png, palette: [] },
      { name: 'x', pngBase64: png, palette: Array.from({ length: 257 }, (_, i) => `#${i.toString(16).padStart(6, '0')}`) },
      { name: 'x', pngBase64: png, palette: ['#ff0000'], width: 0 },
      { name: 'x', pngBase64: png, palette: ['#ff0000'], height: 4097 },
      { name: 'x', pngBase64: png, palette: ['#ff0000'], x: 1e10 },
      { name: 'x', pngBase64: png, palette: ['#ff0000'], cookie: 'j=abc' },
    ]) {
      const r = await call('POST', '/api/v1/geopixels/templates', bad);
      expect({ status: r.status, code: r.body.error?.code }).toEqual({ status: 400, code: 'INVALID_REQUEST' });
    }
  });

  it('exports a PNG as an attachment; the file name cannot inject a header', async () => {
    const r = await call('GET', '/api/v1/geopixels/templates/fantome/export.png');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-disposition']).toBe('attachment; filename="evil___X-Injected__1.png"');
    expect(r.headers['x-injected']).toBeUndefined();
    expect(engine.calls).toContain('export:fantome');
    expect((await call('GET', '/api/v1/geopixels/templates/BAD..ID/export.png')).status).toBe(400);
  });

  it('deletes with a JSON request only (no cross-site form)', async () => {
    expect((await call('DELETE', '/api/v1/geopixels/templates/fantome', 'a=1', { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    const r = await call('DELETE', '/api/v1/geopixels/templates/fantome', {});
    expect(r.status).toBe(200);
    expect(engine.calls).toContain('delete:fantome');
  });
});

describe('engine WebSocket channel', () => {
  class FakeSocket implements SocketLike {
    readyState = 1;
    bufferedAmount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON read by the test
    readonly sent: any[] = [];
    private readonly handlers = new Map<string, ((data?: unknown) => void)[]>();
    send(data: string): void {
      this.sent.push(JSON.parse(data));
    }
    on(event: string, listener: (data?: unknown) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
      return this;
    }
    fire(event: string, data?: unknown): void {
      for (const h of this.handlers.get(event) ?? []) h(data);
    }
  }

  it('a new client gets the current state at once, then the events in order', () => {
    const api = fakeEngine();
    const ws = new FakeSocket();
    attachEngineSocket(ws, api);
    expect(ws.sent[0]).toMatchObject({ type: 'hello', stream: 's1', seq: 0, status: { state: 'stopped' } });
    api.emit('state', { from: 'stopped', to: 'running' });
    api.emit('canvas', { pixels: [1, 2] });
    expect(ws.sent.slice(1).map((m) => [m.type, m.seq, m.event.type])).toEqual([
      ['event', 1, 'state'],
      ['event', 2, 'canvas'],
    ]);
  });

  it('a slow client never blocks the engine: events are dropped, then a resync is sent once it caught up', () => {
    const api = fakeEngine();
    const ws = new FakeSocket();
    attachEngineSocket(ws, api, { maxBufferedBytes: 100 });
    ws.bufferedAmount = 1_000;
    for (let i = 0; i < 50; i++) api.emit('canvas', { pixels: [i, i] });
    expect(ws.sent).toHaveLength(1); // only the hello
    ws.bufferedAmount = 0;
    api.emit('status', { status: {} });
    expect(ws.sent.slice(1).map((m) => m.type)).toEqual(['resync', 'event']);
    expect(ws.sent[1]).toMatchObject({ type: 'resync', dropped: 50 });
    expect(ws.sent[2].event.type).toBe('canvas-resync');
  });

  it('a slow client is resynchronised once drained, even when no further event comes (run over)', async () => {
    const api = fakeEngine();
    const ws = new FakeSocket();
    attachEngineSocket(ws, api, { maxBufferedBytes: 100, drainCheckMs: 5 });
    ws.bufferedAmount = 1_000;
    api.emit('canvas', { pixels: [1, 1] });
    api.emit('state', { from: 'running', to: 'completed' });
    expect(ws.sent).toHaveLength(1);
    ws.bufferedAmount = 0;
    await new Promise((r) => setTimeout(r, 40));
    expect(ws.sent.slice(1).map((m) => m.type)).toEqual(['resync', 'event']);
    expect(ws.sent[1]).toMatchObject({ dropped: 2 });
    ws.fire('close');
  });

  it('a reconnection gets a fresh hello; a closed socket is unsubscribed and the engine goes on', () => {
    const api = fakeEngine();
    const first = new FakeSocket();
    attachEngineSocket(first, api);
    expect(api.listeners).toBe(1);
    first.fire('close');
    expect(api.listeners).toBe(0);
    api.emit('state', { from: 'running', to: 'paused' });
    const second = new FakeSocket();
    attachEngineSocket(second, api);
    expect(second.sent[0]).toMatchObject({ type: 'hello', seq: 1 });
    second.fire('message', JSON.stringify({ type: 'ping' }));
    second.fire('message', 'not json');
    expect(second.sent.at(-1)).toEqual({ type: 'pong' });
  });
});
