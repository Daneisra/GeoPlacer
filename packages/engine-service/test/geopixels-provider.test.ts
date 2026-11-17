import { describe, it, expect } from 'vitest';
import { asRgb, UNKNOWN, type AgentId, type AttemptId, type PixelWrite, type Template } from '@geoplacer/core';
import { GeoPixelsProvider, nativePoint, nativeTile } from '../src/geopixels/provider.js';
import { ConnectorPairing, localOrigin } from '../src/geopixels/pairing.js';
import { parseObservation, type BrowserObservation } from '../src/geopixels/protocol.js';
import { DEFAULT_SETTINGS, rulesOf } from '../src/settings.js';

const NOW = 1_000_000;
const project = { id: 'ghost', generation: '1', width: 2, height: 2, gridX: -1, gridY: 1000, layer: 'base' as const };
const template = (width = 2, height = 2) =>
  ({
    id: 'local',
    revision: 1,
    image: { width, height },
    placement: { topLeft: { x: 5, y: 8 } },
    coordinateSystem: { yAxis: 'down' },
  }) as Template;
const observation = (patch: Partial<BrowserObservation> = {}): BrowserObservation => ({
  type: 'observation' as const,
  sequence: 1,
  session: 'browser',
  project,
  capturedAt: NOW,
  observedAt: NOW,
  rect: { x: -1, y: 999, width: 2, height: 2 },
  pixels: [3, 4, 1, 2],
  resources: null,
  ...patch,
});
const writes: PixelWrite[] = [{ taskId: 'task' as PixelWrite['taskId'], point: { x: 5, y: 8 }, color: asRgb(1) }];
const options = { attemptId: 'attempt' as AttemptId };
const agent = 'agent' as AgentId;
function ready(timeout = 50) {
  const p = new GeoPixelsProvider(() => NOW, timeout);
  p.connect('local-fake', () => {});
  p.observe(observation());
  p.bind(template());
  return p;
}

describe('GeoPixels native coordinate and observation contracts', () => {
  it.each([
    [-1, -1, -1000, -1000, 999, 999],
    [999, 1000, 0, 1000, 999, 0],
    [1000, 999, 1000, 0, 0, 999],
    [-1001, -1000, -2000, -1000, 999, 0],
  ])('tile edge %i,%i', (x, y, tx, ty, lx, ly) => {
    expect(nativeTile(x, y)).toEqual({ tileX: tx, tileY: ty, localX: lx, localY: ly });
  });
  it('maps top-left image down into native Y-up without an off-by-one', () => {
    expect(nativePoint(project, 1, 1)).toEqual({ x: 0, y: 999 });
  });
  it('flips native row ordering once and keeps a snapshot immutable', async () => {
    const p = ready(),
      r = { minX: 5, minY: 8, width: 2, height: 2 };
    const old = await p.reader.readRegion(r);
    expect([old.get({ x: 5, y: 8 }), old.get({ x: 6, y: 9 })]).toEqual([1, 4]);
    p.observe(observation({ sequence: 2, pixels: [9, 9, 9, 9] }));
    expect(old.get({ x: 5, y: 8 })).toBe(1);
    expect((await p.reader.readRegion(r)).get({ x: 5, y: 8 })).toBe(9);
    p.close();
  });
  it('keeps unobserved cells unknown, transparent distinct and out-of-region unknown', async () => {
    const p = new GeoPixelsProvider(() => NOW);
    p.connect('local-fake', () => {});
    p.observe(observation({ rect: { x: -1, y: 1000, width: 1, height: 1 }, pixels: [-1] }));
    p.bind(template());
    const s = await p.reader.readRegion({ minX: 5, minY: 8, width: 2, height: 2 });
    expect(s.get({ x: 5, y: 8 })).toBe(-1);
    expect(s.get({ x: 6, y: 8 })).toBe(UNKNOWN);
    expect(s.get({ x: 0, y: 0 })).toBe(UNKNOWN);
    p.close();
  });
  it.each(['sequence', 'pixels', 'resources', 'secret', 'position', 'time', 'layer'])('rejects invalid %s', (kind) => {
    const o: Record<string, unknown> = { ...structuredClone(observation()) };
    if (kind === 'sequence') o.sequence = 0;
    if (kind === 'pixels') o.pixels = [0];
    if (kind === 'resources') o.resources = { energy: 5 };
    if (kind === 'secret') o.token = 'should-never-enter';
    if (kind === 'position') o.rect = { x: -3, y: 999, width: 2, height: 2 };
    if (kind === 'time') o.observedAt = NOW + 1;
    if (kind === 'layer') o.project = { ...project, layer: 'event' };
    expect(() => parseObservation(o, NOW)).toThrow();
  });
  it('rejects replay and out-of-order messages without destroying newer data', async () => {
    const p = ready();
    p.observe(observation({ sequence: 3, pixels: [9, 9, 9, 9] }));
    expect(() => p.observe(observation({ sequence: 2 }))).toThrow();
    expect((await p.reader.readRegion({ minX: 5, minY: 8, width: 1, height: 1 })).get({ x: 5, y: 8 })).toBe(9);
    p.close();
  });
  it('rejects a newer envelope carrying older per-pixel data', async () => {
    const p = ready();
    p.observe(observation({ sequence: 2, observedAt: NOW - 1, pixels: [9, 9, 9, 9] }));
    expect((await p.reader.readRegion({ minX: 5, minY: 8, width: 1, height: 1 })).get({ x: 5, y: 8 })).toBe(1);
    p.close();
  });
  it.each(['session', 'position', 'model'])('invalidates binding after a %s change', async (kind) => {
    const p = ready();
    const patch =
      kind === 'session'
        ? { session: 'new' }
        : {
            project: { ...project, ...(kind === 'position' ? { gridX: 2 } : { generation: '2' }) },
            rect: { x: kind === 'position' ? 2 : -1, y: 999, width: 2, height: 2 },
          };
    p.observe(observation({ sequence: 2, ...patch }));
    expect(p.status().bound).toBe(false);
    expect(p.canWrite()).toBe(false);
    p.close();
  });
  it('returns unknown on stale pixels and disconnected channels', async () => {
    let now = NOW;
    const p = new GeoPixelsProvider(() => now);
    p.connect('local-fake', () => {});
    p.observe(observation());
    p.bind(template());
    now += 30_001;
    p.heartbeat();
    expect(p.status().captureExpired).toBe(true);
    expect(p.status().captureAgeMs).toBe(30_001);
    expect((await p.reader.readRegion({ minX: 5, minY: 8, width: 1, height: 1 })).get({ x: 5, y: 8 })).toBe(UNKNOWN);
    p.disconnect();
    expect(p.status().connected).toBe(false);
    p.close();
  });
  it('reports missing resources without inventing zero energy', async () => {
    const p = ready();
    expect(p.status().resources).toBeNull();
    await expect(p.resourceSource(rulesOf(DEFAULT_SETTINGS.simulator)).observe(agent)).rejects.toThrow();
    p.close();
  });
  it('refuses stale or incompatible resource observations', async () => {
    const p = ready();
    const rules = rulesOf(DEFAULT_SETTINGS.simulator);
    p.observe(
      observation({
        sequence: 2,
        resources: {
          observedAt: NOW - 31_000,
          energy: 12,
          capacity: rules.energy.baseCapacity,
          currency: 50,
          regenIntervalMs: rules.energy.regenIntervalMs,
          colors: [],
        },
      })
    );
    await expect(p.resourceSource(rules).observe(agent)).rejects.toThrow(/stale/);
    p.close();
  });
  it('preserves undated cache colors as explicitly undated observations', async () => {
    const p = ready();
    p.disconnect();
    p.connect('read-only', () => {});
    p.observe(observation({ observedAt: null }));
    p.bind(template());
    const s = await p.reader.readRegion({ minX: 5, minY: 8, width: 1, height: 1 });
    expect(s.observedAt).toBe(0);
    expect(s.get({ x: 5, y: 8 })).toBe(1); // Cache color retained, without inventing a date.
    expect(s.source).toBe('geopixels-observed');
    expect(p.status().freshness).toBe('unverified');
    p.close();
  });
  it.each([
    [64, 64],
    [595, 894],
    [2000, 2000],
  ])('bounds memory and partial coverage for %i x %i', async (w, h) => {
    const p = new GeoPixelsProvider(() => NOW);
    p.connect('local-fake', () => {});
    p.observe(
      observation({ project: { ...project, width: w, height: h }, rect: { x: -1, y: 1000, width: 1, height: 1 }, pixels: [0xffffff] })
    );
    p.bind(template(w, h));
    const s = await p.reader.readRegion({ minX: 5, minY: 8, width: w, height: h });
    expect(s.get({ x: 5, y: 8 })).toBe(0xffffff);
    expect(s.get({ x: 5 + w - 1, y: 8 + h - 1 })).toBe(UNKNOWN);
    p.close();
  });
});

describe('Writer result fencing and uncertainty', () => {
  it('has no real-site write capability', async () => {
    const p = ready();
    p.connect('read-only', () => {});
    p.observe(observation());
    p.bind(template());
    await expect(p.writer.applyPixels(agent, writes, options)).rejects.toThrow(/unavailable/);
    p.close();
  });
  it('validates results, maps native coordinates and never replays an attempt', async () => {
    const p = ready();
    let command: import('../src/geopixels/provider.js').BrowserCommand | undefined;
    p.connect('local-fake', (c) => {
      command = c;
    });
    p.observe(observation());
    p.bind(template());
    const answer = p.writer.applyPixels(agent, writes, options);
    expect(command!.writes[0]).toEqual({ taskId: 'task', gridX: -1, gridY: 1000, color: 1 });
    expect(() =>
      p.result({ type: 'result', id: 'wrong', attemptId: 'attempt', session: 'browser', outcomes: [{ taskId: 'task', status: 'applied' }] })
    ).toThrow();
    p.result({
      type: 'result',
      id: command!.id,
      attemptId: 'attempt',
      session: 'browser',
      outcomes: [{ taskId: 'task', status: 'applied' }],
    });
    expect((await answer).outcomes[0]!.status).toBe('applied');
    await expect(p.writer.applyPixels(agent, writes, options)).rejects.toThrow();
    p.close();
  });
  it('marks a lost response unknown and rejects a late result', async () => {
    const p = ready(5);
    const answer = p.writer.applyPixels(agent, writes, options);
    await expect(answer).rejects.toThrow(/reconcile/);
    expect(() => p.result({})).toThrow();
    p.close();
  });
  it.each(['disconnect', 'abort', 'changed-project'])('retains uncertainty on %s', async (kind) => {
    const p = ready();
    const controller = new AbortController();
    const answer = p.writer.applyPixels(agent, writes, { ...options, signal: controller.signal });
    if (kind === 'disconnect') p.disconnect();
    if (kind === 'abort') controller.abort();
    if (kind === 'changed-project') p.observe(observation({ sequence: 2, session: 'other' }));
    await expect(answer).rejects.toThrow(/reconcile/);
    p.close();
  });
  it('refuses two concurrent commands', async () => {
    const p = ready();
    const first = p.writer.applyPixels(agent, writes, options);
    await expect(p.writer.applyPixels(agent, writes, { attemptId: 'second' as AttemptId })).rejects.toThrow(/concurrent/);
    p.close();
    await expect(first).rejects.toThrow();
  });
});

describe('Local pairing security', () => {
  it.each(['https://geopixels.net', 'https://www.geopixels.net'])(
    'allows read-only pairing at %s, never a fake writer',
    (origin) => {
      const pairing = new ConnectorPairing();
      const issued = pairing.issue('read-only', origin);
      expect(pairing.acceptsOrigin(origin)).toBe(true);
      expect(
        pairing.acceptsOrigin(
          origin === 'https://geopixels.net' ? 'https://www.geopixels.net' : 'https://geopixels.net'
        )
      ).toBe(false);
      expect(() => pairing.issue('local-fake', origin)).toThrow();
      expect(issued.mode).toBe('read-only');
    }
  );

  it.each(['https://evil.example', 'null', 'http://127.0.0.1.evil:3000', 'http://user@localhost:3000', 'http://localhost:3000/path'])(
    'rejects hostile origin %s',
    (origin) => {
      expect(localOrigin(origin)).toBe(false);
      expect(() => new ConnectorPairing().issue('local-fake', origin)).toThrow();
    }
  );
  it('never authorizes a fake writer from the actual site', () => {
    expect(() => new ConnectorPairing().issue('local-fake', 'https://www.geopixels.net')).toThrow();
  });
  it('binds token to exact origin, consumes it once and revokes the channel', () => {
    const p = new ConnectorPairing(() => NOW),
      issued = p.issue('local-fake', 'http://127.0.0.1:3000');
    let closed = 0;
    expect(() => p.redeem('http://localhost:3000', issued.token, () => {})).toThrow();
    expect(() => p.redeem(issued.origin, '0'.repeat(64), () => {})).toThrow();
    expect(p.redeem(issued.origin, issued.token, () => closed++)).toBe('local-fake');
    expect(() => p.redeem(issued.origin, issued.token, () => {})).toThrow();
    p.revoke();
    expect(closed).toBe(1);
  });
  it('expires and replaces pending pairings', () => {
    let now = NOW;
    const p = new ConnectorPairing(() => now);
    const old = p.issue('read-only', 'https://www.geopixels.net');
    const current = p.issue('read-only', old.origin);
    expect(() => p.redeem(old.origin, old.token, () => {})).toThrow();
    now += 60_000;
    expect(p.acceptsOrigin(current.origin)).toBe(false);
    expect(() => p.redeem(current.origin, current.token, () => {})).toThrow();
  });
});
