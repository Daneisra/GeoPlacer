/**
 * The real server process with the new engine (Phase 1B.9): API and
 * WebSocket on a temporary data directory, second instance refused,
 * controlled shutdown (IPC: Windows cannot send SIGINT to a child), restart,
 * brutal kill during a simulation. Needs the packages built
 * (npm run build:packages; `npm test` does it first).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import WebSocket from 'ws';

jest.setTimeout(180_000);

const repoRoot = path.resolve(__dirname, '..', '..');
const serverEntry = path.join(repoRoot, 'src', 'server.ts');
// The server runs in a temporary directory (its ./data): the TypeScript loader is given by path.
const tsxLoader = pathToFileURL(path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

interface Server {
  readonly proc: ChildProcess;
  readonly port: number;
  readonly exit: Promise<number | null>;
  output(): string;
}

/** Starts the server in `cwd` (its ./data); resolves once it listens (IPC message), or when it exits first. */
async function startServer(cwd: string): Promise<Server> {
  const port = await freePort();
  const proc = spawn(process.execPath, ['--import', tsxLoader, serverEntry], {
    cwd,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let out = '';
  proc.stdout!.on('data', (c: Buffer) => (out += c.toString()));
  proc.stderr!.on('data', (c: Buffer) => (out += c.toString()));
  const exit = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON read by the test
  const listening = new Promise<number>((resolve) => proc.on('message', (m: any) => m?.type === 'listening' && resolve(m.port as number)));
  const first = await Promise.race([listening.then((p) => ({ kind: 'listening' as const, p })), exit.then((code) => ({ kind: 'exit' as const, code }))]);
  return { proc, port: first.kind === 'listening' ? first.p : port, exit, output: () => out };
}

async function stopServer(s: Server): Promise<number | null> {
  if (s.proc.exitCode === null) s.proc.send('shutdown');
  return s.exit;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON read by the test
function call(port: number, method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }) } },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: text });
          }
        });
      }
    );
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

/** A minimal RGBA PNG (stripes of two demo colors, a transparent diagonal). */
function png(w: number, h: number): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 4) + 1 + x * 4;
      if (x === y) continue;
      const red = (x + y) % 2 === 0;
      raw[o] = red ? 0xed : 0x00;
      raw[o + 1] = red ? 0x1c : 0xa2;
      raw[o + 2] = red ? 0x24 : 0xe8;
      raw[o + 3] = 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const dirs: string[] = [];
const servers: Server[] = [];
afterAll(async () => {
  for (const s of servers) if (s.proc.exitCode === null) s.proc.kill('SIGKILL');
  await Promise.all(servers.map((s) => s.exit));
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
});

async function workDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'gp-server-'));
  dirs.push(d);
  return d;
}

const FAST = { simulator: { width: 64, height: 64, costPerPixel: 1, capacity: 2000, regenIntervalMs: 3_600_000, writeLatencyMs: 20 }, agent: { startEnergy: 2000, startCurrency: 0 }, run: { maxBatchSize: 10, minBatchSize: 1 }, resetWorld: true };

/** Configures the engine, imports and selects a w x w template; returns its id and paintable pixels. */
async function prepare(port: number, w: number): Promise<{ id: string; paintable: number }> {
  expect((await call(port, 'PUT', '/api/v1/simulator/settings', FAST)).status).toBe(200);
  const t = await call(port, 'POST', '/api/v1/templates', { name: 'Fresque', pngBase64: png(w, w), x: 2, y: 3, strategy: 'top-to-bottom' });
  expect(t.status).toBe(200);
  expect((await call(port, 'PUT', '/api/v1/engine/selection', { templateId: t.body.templateId })).status).toBe(200);
  return { id: t.body.templateId, paintable: t.body.paintablePixels };
}

describe('server with the engine (real processes)', () => {
  it('runs a simulation from the API, streams it over the WebSocket, survives a disconnection, refuses a second instance, restarts consistently', async () => {
    const dir = await workDir();
    const a = await startServer(dir);
    servers.push(a);
    expect(a.proc.exitCode).toBeNull();
    expect(a.output()).toContain('local simulation only');
    const { id, paintable } = await prepare(a.port, 24);

    // A second server on the same data directory is refused explicitly, without writing.
    const b = await startServer(dir);
    servers.push(b);
    expect(await b.exit).toBe(2);
    expect(b.output()).toContain('already used by another GeoPlacer instance');

    // WebSocket: hello first, then sequenced events.
    const ws = new WebSocket(`ws://127.0.0.1:${a.port}/api/v1/ws`, { headers: { Host: `127.0.0.1:${a.port}` } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON read by the test
    const messages: any[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once('open', r));
    expect((await call(a.port, 'POST', '/api/v1/engine/start', {})).body.changed).toBe(true);
    await until(async () => messages.length, (n) => n > 3);
    expect(messages[0].type).toBe('hello');
    const seqs = messages.filter((m) => m.type === 'event').map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    // Disconnect: the simulation goes on.
    ws.close();
    const mid = (await call(a.port, 'GET', '/api/v1/engine/status')).body.scheduler?.applied ?? 0;
    await until(() => call(a.port, 'GET', '/api/v1/engine/status'), (r) => (r.body.scheduler?.applied ?? 0) > mid);
    // Reconnect: a fresh, consistent hello.
    const ws2 = new WebSocket(`ws://127.0.0.1:${a.port}/api/v1/ws`, { headers: { Host: `127.0.0.1:${a.port}` } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON read by the test
    const hello = await new Promise<any>((r) => ws2.once('message', (d) => r(JSON.parse(d.toString()))));
    expect(hello).toMatchObject({ type: 'hello', status: { mode: 'simulation', selection: { templateId: id } } });
    ws2.close();
    const done = await until(() => call(a.port, 'GET', '/api/v1/engine/status'), (r) => r.body.state === 'completed');
    expect(done.body.scheduler.applied).toBe(paintable);

    // Controlled shutdown, then a restart finds the same state.
    expect(await stopServer(a)).toBe(0);
    expect(a.output()).toMatch(/Engine stopped and data directory released/);
    const c = await startServer(dir);
    servers.push(c);
    const status = (await call(c.port, 'GET', '/api/v1/engine/status')).body;
    expect(status.selection.templateId).toBe(id);
    expect((await call(c.port, 'GET', '/api/v1/resources')).body.energy).toBe(2000 - paintable);
    await call(c.port, 'POST', '/api/v1/engine/start', {});
    const again = await until(() => call(c.port, 'GET', '/api/v1/engine/status'), (r) => r.body.state === 'completed');
    expect(again.body.scheduler.applied).toBe(0); // nothing painted twice
    expect(await stopServer(c)).toBe(0);
  });

  it('a server killed during a simulation restarts, reconciles and finishes without spending twice', async () => {
    const dir = await workDir();
    const a = await startServer(dir);
    servers.push(a);
    const { paintable } = await prepare(a.port, 30);
    await call(a.port, 'POST', '/api/v1/engine/start', {});
    await until(() => call(a.port, 'GET', '/api/v1/engine/status'), (r) => (r.body.scheduler?.applied ?? 0) > 100);
    a.proc.kill('SIGKILL');
    await a.exit;
    const b = await startServer(dir);
    servers.push(b);
    const before = (await call(b.port, 'GET', '/api/v1/engine/status')).body;
    expect(before.world.available).toBe(true);
    await call(b.port, 'POST', '/api/v1/engine/start', {});
    const done = await until(() => call(b.port, 'GET', '/api/v1/engine/status'), (r) => r.body.state === 'completed' || r.body.state === 'error');
    expect(done.body.state).toBe('completed');
    expect((await call(b.port, 'GET', '/api/v1/resources')).body.energy).toBe(2000 - paintable);
    expect(await stopServer(b)).toBe(0);
  });
});
