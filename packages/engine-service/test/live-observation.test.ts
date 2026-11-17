import { describe, it, expect } from 'vitest';
import type { Template } from '@geoplacer/core';
import { ObservationMonitor, parseObservationHistory } from '../src/geopixels/monitor.js';
import { GeoPixelsProvider } from '../src/geopixels/provider.js';
import { ConnectorHttpChannel, HTTP_LIFETIME_MS } from '../src/geopixels/http-channel.js';
import { ConnectorPairing } from '../src/geopixels/pairing.js';
import type { BrowserObservation } from '../src/geopixels/protocol.js';

function setup() {
  let now = 100_000, sequence = 0, capture = 0;
  const provider = new GeoPixelsProvider(() => now), pairing = new ConnectorPairing(() => now);
  const http = new ConnectorHttpChannel(pairing, provider, 'a'.repeat(64), () => now);
  const claim = http.claim('https://geopixels.net', http.issue('a'.repeat(64), 'https://geopixels.net').token);
  http.approve('a'.repeat(64), claim.requestId);
  http.status(claim.capability, 3);
  const project = { id: 'image', generation: 'palette', width: 2, height: 2, gridX: 999, gridY: 1001, layer: 'base' as const };
  const send = (pixels = [0, 0, -2, -1], patch: Partial<BrowserObservation> = {}) => {
    const o: BrowserObservation = { type: 'observation', sequence: ++sequence, session: 'opaque-session', project,
      capturedAt: now, observedAt: null, rect: { x: 999, y: 1000, width: 2, height: 2 }, pixels, resources: null,
      capture: { id: `capture-${++capture}`, index: 0, count: 1 }, ...patch };
    http.batch(claim.capability, [o]); return o;
  };
  return { provider, http, claim, project, send, advance: (ms: number) => { now += ms; }, now: () => now };
}
describe('Repeated cache observation, without service freshness claims', () => {
  it('wakes a held response on control change and refuses concurrent polls', async () => {
    const s=setup(), abort=new AbortController();
    const pending=s.http.poll(s.claim.capability,3,undefined,abort.signal);
    await expect(s.http.poll(s.claim.capability,3,undefined,new AbortController().signal)).rejects.toThrow(/concurrent/);
    s.provider.monitoring.command('start',5000);
    expect(await pending).toMatchObject({monitoring:{state:'running'},pacing:'server-50ms'});
  });
  it('cancels held requests on abort or revocation without extending authority', async () => {
    const s=setup(), abort=new AbortController();
    const pending=s.http.poll(s.claim.capability,3,undefined,abort.signal);
    abort.abort(); await expect(pending).rejects.toThrow(/aborted/);
    const next=s.http.poll(s.claim.capability,3,undefined,new AbortController().signal);
    s.http.revoke();await expect(next).rejects.toThrow();
  });
  it('cannot keep a capability alive past its absolute deadline with a held request', async () => {
    const s=setup();const pending=s.http.poll(s.claim.capability,3,undefined,new AbortController().signal);
    s.advance(HTTP_LIFETIME_MS);s.http.tick();await expect(pending).rejects.toThrow();
  });
  it('requires capability negotiation and enforces bounded, acknowledged controls', () => {
    const m = new ObservationMonitor();
    expect(() => m.command('start', 10000)).toThrow();
    m.capabilities(true);
    for (const n of [0, 4999, 60001, NaN]) expect(() => m.command('start', n)).toThrow();
    expect(m.command('start', 5000)).toMatchObject({ state: 'running', pending: true });
    const revision = m.control().revision;
    m.acknowledge(revision, 'running');
    m.command('pause', 5000);
    m.acknowledge(revision, 'running');
    expect(m.view()).toMatchObject({ state: 'paused', pending: true });
    expect(() => m.acknowledge(999, 'running')).toThrow();
    expect(() => m.acknowledge(m.control().revision, 'running')).toThrow();
    m.acknowledge(m.control().revision, 'paused');
    expect(m.view().pending).toBe(false);
    m.command('resume', 5000); m.command('stop', 5000);
    expect(m.view().state).toBe('stopped');
  });
  it('records identical old cache reads without inventing source freshness', () => {
    const s = setup(); s.send(); s.advance(10000); s.send();
    const v = s.provider.monitoring.view();
    expect(v.lastCapture).toMatchObject({ total: 4, known: 3, unknown: 1, transparent: 1, unchanged: 4, changedKnown: 0, sourceObservedAt: null });
    expect(v.history).toHaveLength(2);
    expect(v.history[1]!.capturedAt).toBeGreaterThan(v.history[0]!.capturedAt);
    expect(v.history.every(p => p.sourceObservedAt === null)).toBe(true);
    expect(s.provider.status().resourcesStale).toBe(true);
  });
  it('expires pixel observations while heartbeats preserve the channel', async () => {
    const s=setup(); s.send([0,0,0,0]);
    s.provider.bind({ id:'local', revision:1, image:{width:2,height:2}, coordinateSystem:{yAxis:'down'}, placement:{topLeft:{x:0,y:0}} } as Template);
    s.advance(20000); s.http.status(s.claim.capability,3); s.advance(10001); s.http.status(s.claim.capability,3);
    expect((await s.provider.reader.readRegion({minX:0,minY:0,width:2,height:2})).get({x:0,y:0})).toBe(-2);
    expect(s.provider.status()).toMatchObject({ connected:true, captureExpired:true, freshness:'unverified' });
  });
  it('separates changed colors, erasure, newly loaded values and missing tiles', () => {
    const s = setup(); s.send([0, 0, -2, 0]); s.advance(1000); s.send([0xffffff, -1, 0, -2]);
    expect(s.provider.monitoring.view().lastCapture).toMatchObject({ changedKnown: 2, newlyKnown: 1, becameUnknown: 1, unknown: 1 });
  });
  it('retains an actual source date instead of refreshing it when reread', () => {
    const s = setup(); s.send([0, 0, 0, 0], { observedAt: s.now() - 20000 });
    s.advance(5000); s.send([0, 0, 0, 0], { observedAt: s.now() - 25000 });
    expect(s.provider.monitoring.view().lastCapture?.sourceObservedAt).toBe(80000);
  });
  it('only completes an entire ordered capture, never treating a partial map as complete', () => {
    const s = setup();
    s.send([0, -2], { capture: { id: 'bands', index: 0, count: 2 }, rect: { x: 999, y: 1001, width: 2, height: 1 } });
    expect(s.provider.monitoring.view()).toMatchObject({ inFlight: true, history: [] });
    expect(() => s.send([0, 0], { capture: { id: 'bands', index: 1, count: 2 }, rect: { x: 999, y: 1001, width: 2, height: 1 } })).toThrow();
    s.send([-2, -2], { sequence: 2, capture: { id: 'bands', index: 1, count: 2 }, rect: { x: 999, y: 1000, width: 2, height: 1 } });
    expect(s.provider.monitoring.view().lastCapture).toMatchObject({ total: 4, known: 1, unknown: 3, regionCount: 2 });
  });
  it('rejects a malformed multi-band HTTP batch before applying its first envelope', () => {
    const s = setup();
    const first = { type: 'observation', sequence: 1, session: 'session', project: s.project, capturedAt: s.now(), observedAt: null,
      resources: null, pixels: [0, 0], rect: { x: 999, y: 1001, width: 2, height: 1 }, capture: { id: 'bands', index: 0, count: 2 } };
    expect(() => s.http.batch(s.claim.capability, [first, { ...first, sequence: 2 }])).toThrow();
    expect(s.provider.status().project).toBe(null);
    expect(s.http.status(s.claim.capability, 3).lastSequence).toBe(0);
  });
  it.each(['session','position','palette','image'] as const)('stops and unbinds a changed %s identity', kind => {
    const s = setup(); s.send();
    s.provider.bind({ id: 'local', revision: 1, image: { width: 2, height: 2 }, coordinateSystem: { yAxis: 'down' }, placement: { topLeft: { x: 0, y: 0 } } } as Template);
    s.provider.monitoring.command('start', 5000);
    const project = { ...s.project, ...(kind === 'position' ? { gridX: 998 } : kind === 'palette' ? { generation: 'new-palette' } : kind === 'image' ? { id: 'new-image' } : {}) };
    s.send([0,0,0,0], { project, session: kind === 'session' ? 'new-session' : 'opaque-session', rect: { x: project.gridX, y: 1000, width: 2, height: 2 } });
    expect(s.provider.status().bound).toBe(false);
    expect(s.provider.monitoring.view().state).toBe('stopped');
    expect(s.provider.monitoring.view().history[1]!.projectKey).not.toBe(s.provider.monitoring.view().history[0]!.projectKey);
  });
  it('does not silently extend the absolute coupling lifetime with monitoring', () => {
    const s = setup(); s.send(); s.provider.monitoring.command('start', 5000);
    for (let i=0;i<HTTP_LIFETIME_MS/10000-1;i++) { s.advance(10000); s.http.status(s.claim.capability, 3); }
    s.advance(10000);
    expect(() => s.http.status(s.claim.capability, 3)).toThrow();
    expect(s.provider.status().connected).toBe(false);
    expect(s.provider.monitoring.view().state).toBe('stopped');
  });
  it.each(['revoke', 'disconnect'] as const)('stops on %s and refuses former capabilities', kind => {
    const s = setup(); s.send(); s.provider.monitoring.command('start', 5000);
    if (kind === 'revoke') s.http.revoke(); else s.http.disconnect(s.claim.capability);
    expect(s.provider.monitoring.view().state).toBe('stopped');
    expect(() => s.http.status(s.claim.capability, 3)).toThrow();
    expect(s.provider.monitoring.view().history).toHaveLength(1);
  });
  it('bounds history and validates its persisted schema without restoring authority', () => {
    const s = setup();
    for (let i=0;i<125;i++) { s.send(); s.advance(100); }
    const data=s.provider.monitoring.persisted();
    expect(data.history).toHaveLength(120);
    const restored=new ObservationMonitor(); restored.restore(parseObservationHistory(JSON.parse(JSON.stringify(data))));
    expect(restored.view()).toMatchObject({ state:'stopped', supported:false, lastCapture:null });
    expect(() => parseObservationHistory({ ...data, token:'forbidden' })).toThrow();
    expect(() => parseObservationHistory({ schemaVersion:1, history:[{...data.history[0], known:99999999}] })).toThrow();
  });
});
