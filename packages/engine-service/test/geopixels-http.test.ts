import { describe, it, expect } from 'vitest';
import { ConnectorHttpChannel, HTTP_IDLE_MS, HTTP_LIFETIME_MS, type ChannelDiagnostic } from '../src/geopixels/http-channel.js';
import { ConnectorPairing } from '../src/geopixels/pairing.js';
import { GeoPixelsProvider } from '../src/geopixels/provider.js';

const KEY = 'a'.repeat(64),
  ORIGIN = 'https://geopixels.net';
function setup() {
  let now = 100_000;
  const pairing = new ConnectorPairing(() => now),
    provider = new GeoPixelsProvider(() => now);
  const events:ChannelDiagnostic[]=[];
  const http = new ConnectorHttpChannel(pairing, provider, KEY, () => now, undefined, event=>events.push(event));
  const claim = () => http.claim(ORIGIN, http.issue(KEY, ORIGIN).token);
  const ready = () => {
    const s = claim();
    http.approve(KEY, s.requestId);
    return s;
  };
  const observation = (sequence = 1) => ({
    type: 'observation',
    sequence,
    session: 'opaque-session',
    project: { id: 'ghost', generation: 'palette', width: 2, height: 3, gridX: -1, gridY: 1000, layer: 'base' },
    capturedAt: now,
    observedAt: null,
    rect: { x: -1, y: 998, width: 2, height: 3 },
    pixels: [-2, -1, 0, 0xffffff, -2, 0],
    resources: null,
  });
  return {
    pairing,
    events,
    provider,
    http,
    claim,
    ready,
    observation,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe('Privileged HTTP reader capability and sequence protocol', () => {
  it('requires a private approval credential, including against forged management headers', () => {
    const s = setup();
    expect(() => s.http.issue('b'.repeat(64), ORIGIN)).toThrow();
    const disabled = new ConnectorHttpChannel(s.pairing, s.provider, undefined);
    expect(disabled.info().enabled).toBe(false);
    expect(() => disabled.issue(KEY, ORIGIN)).toThrow();
  });
  it('binds the one-use claim to the selected origin and transport', () => {
    const s = setup(),
      code = s.http.issue(KEY, ORIGIN);
    expect(s.pairing.acceptsOrigin(ORIGIN)).toBe(false);
    expect(() => s.pairing.issue('local-fake', 'http://127.0.0.1:3000', 'http')).toThrow();
    expect(() => s.pairing.redeem(ORIGIN, code.token, () => {})).toThrow();
    expect(() => s.http.claim('https://www.geopixels.net', code.token)).toThrow();
    s.http.claim(ORIGIN, code.token);
    expect(() => s.http.claim(ORIGIN, code.token)).toThrow();
  });
  it('does not treat a claim as approval or proof of origin', () => {
    const s = setup(),
      claim = s.claim();
    expect(s.http.info().pending?.originClaim).toBe(ORIGIN);
    expect(s.provider.status().connected).toBe(false);
    expect(s.http.status(claim.capability).approved).toBe(false);
    expect(() => s.http.batch(claim.capability, [s.observation()])).toThrow();
    expect(() => s.http.approve('b'.repeat(64), claim.requestId)).toThrow();
  });
  it('accepts observations only after voluntary approval, without enabling writes', () => {
    const s = setup(),
      claim = s.ready();
    expect(s.http.batch(claim.capability, [s.observation()])).toMatchObject({ accepted: true, sequence: 1 });
    expect(s.provider.status()).toMatchObject({ connected: true, mode: 'read-only' });
    expect(s.provider.canWrite()).toBe(false);
  });
  it('deduplicates an exact batch after loss of its acknowledgement', () => {
    const s = setup(),
      c = s.ready(),
      batch = [s.observation()];
    s.http.batch(c.capability, batch);
    expect(s.http.batch(c.capability, batch)).toMatchObject({ sequence: 1, duplicate: true });
    expect(() => s.http.batch(c.capability, [{ ...batch[0], pixels: [0, 0, 0, 0, 0, 0] }])).toThrow();
  });
  it('refuses gaps, replay and concurrent conflicting batches', () => {
    const s = setup(),
      c = s.ready();
    expect(() => s.http.batch(c.capability, [s.observation(2)])).toThrow();
    s.http.batch(c.capability, [s.observation()]);
    s.http.batch(c.capability, [s.observation(2)]);
    expect(() => s.http.batch(c.capability, [s.observation()])).toThrow();
  });
  it('validates the whole batch before producing any partial acknowledgement', () => {
    const s = setup(),
      c = s.ready();
    expect(() =>
      s.http.batch(c.capability, [s.observation(), { ...s.observation(2), tokenUser: 'forbidden' }])
    ).toThrow();
    expect(s.http.status(c.capability).lastSequence).toBe(0);
    expect(s.provider.status().project).toBeNull();
  });
  it.each(['session', 'model', 'position'])('invalidates the binding on a changed %s', (kind) => {
    const s = setup(),
      c = s.ready();
    s.http.batch(c.capability, [s.observation()]);
    const next = s.observation(2);
    if (kind === 'session') next.session = 'new-session';
    if (kind === 'model') next.project.id = 'other-ghost';
    if (kind === 'position') next.project.gridY++;
    if (kind === 'position') next.rect.y++;
    expect(() => s.http.batch(c.capability, [next])).toThrow(/Pair and bind/);
    expect(s.provider.status().bound).toBe(false);
    expect(s.provider.status().connected).toBe(false);
  });
  it('expires an unapproved claim and a silent approved reader', () => {
    const s = setup(),
      c = s.claim();
    s.advance(60_000);
    expect(() => s.http.approve(KEY, c.requestId)).toThrow();
    const live = s.ready();
    s.advance(HTTP_IDLE_MS);
    expect(() => s.http.status(live.capability)).toThrow();
    expect(s.provider.status().connected).toBe(false);
  });
  it('expires absolute lifetime even with regular heartbeats', () => {
    const s = setup(),
      c = s.ready();
    for (let t = 20_000; t < HTTP_LIFETIME_MS; t += 20_000) {
      s.advance(20_000);
      s.http.status(c.capability);
    }
    s.advance(20_000);
    expect(() => s.http.status(c.capability)).toThrow();
  });
  it('revokes capabilities and permits only a fresh pairing after restart', () => {
    const s = setup(),
      c = s.ready();
    s.pairing.revoke();
    expect(() => s.http.status(c.capability)).toThrow();
    const next = s.ready();
    const restarted = new ConnectorHttpChannel(s.pairing, s.provider, KEY);
    expect(() => restarted.status(next.capability)).toThrow();
    s.http.disconnect(next.capability);
    expect(s.provider.status().connected).toBe(false);
  });
  it('does not disconnect a replacement fixture channel on stale HTTP cleanup', () => {
    const s = setup();
    s.ready();
    s.provider.connect('local-fake', () => {});
    s.http.revoke();
    expect(s.provider.status().mode).toBe('local-fake');
  });
  it('bounds authenticated message frequency and never returns capabilities from status', () => {
    const s = setup(),
      c = s.ready();
    for (let i = 0; i < 25; i++) s.http.status(c.capability);
    expect(() => s.http.status(c.capability)).toThrow();
    expect(JSON.stringify(s.http.info())).not.toContain(c.capability);
    expect(JSON.stringify(s.http.info())).not.toContain(KEY);
  });
});


describe('Precise coupling diagnostics without changing lifetime or authority',()=>{
  it('keeps the absolute deadline after nine minutes of activity, independently of a later 600 s drawing authorization',()=>{
    const s=setup(),c=s.ready(),initial=s.http.info();
    expect(initial).toMatchObject({approvedAt:100000,expires:100000+HTTP_LIFETIME_MS,remainingMs:HTTP_LIFETIME_MS});
    for(let i=0;i<27;i++){s.advance(20000);s.http.status(c.capability);}
    const drawingStartedAt=640000; // A later drawing authorization cannot reset HTTP approval.
    expect(s.http.info()).toMatchObject({remainingMs:60000,expires:initial.expires});
    for(let i=0;i<2;i++){s.advance(20000);s.http.status(c.capability);}
    s.advance(20000);s.http.tick();
    expect(s.http.info().lastTermination).toMatchObject({code:'HTTP_LIFETIME_EXPIRED',at:700000,approvedAt:100000,expiresAt:700000});
    expect(700000-drawingStartedAt).toBe(60000);expect(s.provider.status().error).toMatch(/dix minutes/);
    expect(()=>s.http.status(c.capability)).toThrow();expect(s.events.map(e=>e.code)).toEqual(['HTTP_APPROVED','HTTP_LIFETIME_EXPIRED']);
  });
  it('distinguishes inactivity from absolute expiry and keeps the reason across repeated cleanup calls',()=>{
    const s=setup();s.ready();s.advance(HTTP_IDLE_MS);s.http.tick();s.http.revoke();
    expect(s.http.info().lastTermination?.code).toBe('HTTP_IDLE_EXPIRED');expect(s.provider.status().error).toMatch(/30 secondes/);
  });
  it('distinguishes changed project context from a replacement channel',()=>{
    const s=setup(),c=s.ready();s.http.batch(c.capability,[s.observation()]);
    expect(()=>s.http.batch(c.capability,[{...s.observation(2),session:'changed'}])).toThrow();
    expect(s.http.info().lastTermination?.code).toBe('HTTP_CONTEXT_CHANGED');
    const next=s.ready();s.provider.connect('local-fake',()=>{});s.http.tick();
    expect(s.http.info().lastTermination?.code).toBe('HTTP_CHANNEL_REPLACED');expect(s.provider.status().mode).toBe('local-fake');expect(()=>s.http.status(next.capability)).toThrow();
  });
  it('records pending expiry and reader disconnect without exposing approval keys or capabilities',()=>{
    const s=setup();s.claim();s.advance(60000);s.http.tick();expect(s.http.info().lastTermination?.code).toBe('HTTP_PENDING_EXPIRED');
    const c=s.ready();s.http.disconnect(c.capability);expect(s.http.info().lastTermination?.code).toBe('HTTP_READER_DISCONNECTED');
    const text=JSON.stringify({events:s.events,info:s.http.info()});expect(text).not.toContain(c.capability);expect(text).not.toContain(KEY);expect(text).not.toContain(c.requestId);
  });
  it('revokes even if the diagnostic logger fails',()=>{
    let now=100000;const p=new GeoPixelsProvider(()=>now),pair=new ConnectorPairing(()=>now);
    const h=new ConnectorHttpChannel(pair,p,KEY,()=>now,undefined,()=>{throw new Error('logger unavailable');});
    const c=h.claim(ORIGIN,h.issue(KEY,ORIGIN).token);h.approve(KEY,c.requestId);now+=HTTP_IDLE_MS;h.tick();
    expect(p.status().connected).toBe(false);expect(h.info().lastTermination?.code).toBe('HTTP_IDLE_EXPIRED');
  });
});
