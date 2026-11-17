import { describe, it, expect } from 'vitest';
import { ConnectorHttpChannel, HTTP_IDLE_MS, HTTP_LIFETIME_MS } from '../src/geopixels/http-channel.js';
import { ConnectorPairing } from '../src/geopixels/pairing.js';
import { GeoPixelsProvider } from '../src/geopixels/provider.js';

const KEY = 'a'.repeat(64),
  ORIGIN = 'https://geopixels.net';
function setup() {
  let now = 100_000;
  const pairing = new ConnectorPairing(() => now),
    provider = new GeoPixelsProvider(() => now);
  const http = new ConnectorHttpChannel(pairing, provider, KEY, () => now);
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
