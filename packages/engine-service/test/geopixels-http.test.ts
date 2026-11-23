import { randomUUID } from 'node:crypto';
import type { SinglePixelWriter } from '../src/geopixels/single-pixel-writer.js';
import { describe, it, expect } from 'vitest';
import { ConnectorHttpChannel, type ChannelDiagnostic } from '../src/geopixels/http-channel.js';
import { ConnectorPairing } from '../src/geopixels/pairing.js';
import { GeoPixelsProvider } from '../src/geopixels/provider.js';

const KEY = 'a'.repeat(64),
  ORIGIN = 'https://geopixels.net';
function setup(writer?: SinglePixelWriter) {
  let now = 100_000;
  const pairing = new ConnectorPairing(() => now),
    provider = new GeoPixelsProvider(() => now);
  const events:ChannelDiagnostic[]=[];
  const http = new ConnectorHttpChannel(pairing, provider, KEY, () => now, writer, event=>events.push(event));
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
  it('reports rate limiting separately and keeps the same capability after the window', () => {
    const s = setup();
    const { capability } = s.ready();
    for (let i = 0; i < 25; i++) s.http.verify(capability, true);
    expect(() => s.http.verify(capability, true)).toThrow(expect.objectContaining({ code: 'CONNECTOR_RATE_LIMIT' }));
    s.advance(1_000);
    expect(() => s.http.verify(capability, true)).not.toThrow();
  });
  it('permits extra observation recovery only for the same approved channel while the writer is idle', () => {
    let locked = true;
    const writer = { batch: { subscribe: () => () => {} }, view: () => ({ locked }) } as unknown as SinglePixelWriter;
    const s = setup(writer);
    const { capability } = s.ready();
    const { http } = s;
    const observation = [s.observation()];
    expect(() => http.batch(capability, observation, true)).toThrow(/idle writer/);
    locked = false;
    expect(http.batch(capability, observation, true)).toMatchObject({ sequence: 1, duplicate: false });
    expect(http.batch(capability, observation, true)).toMatchObject({ sequence: 1, duplicate: true });
    http.revoke();
    expect(() => http.batch(capability, observation, true)).toThrow(/capability/);
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
  it('expires an unapproved claim and reconnects a silent approved reader', () => {
    const s = setup(),
      c = s.claim();
    s.advance(60_000);
    expect(() => s.http.approve(KEY, c.requestId)).toThrow();
    const live = s.ready();
    s.advance(45_000);
    expect(s.provider.status().connected).toBe(false);
    expect(s.http.info()).toMatchObject({ active: true, expires: null });
    expect(s.http.status(live.capability)).toMatchObject({ approved: true });
    expect(s.provider.status().connected).toBe(true);
  });
  it('keeps the same approved capability during an hour of regular heartbeats', () => {
    const s = setup(),
      c = s.ready();
    for (let t = 20_000; t <= 3_600_000; t += 20_000) {
      s.advance(20_000);
      expect(s.http.status(c.capability, 9)).toMatchObject({ approved: true, expires: null, renewRequired: false });
    }
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
  it('polls protocol 10 without rebuilding the drawing or purchase history',()=>{
    const pairing=new ConnectorPairing(),provider=new GeoPixelsProvider();
    const writer={batch:{subscribe:()=>()=>{},control:()=>({commandReady:false}),view:()=>{throw new Error('full history on hot path');},grant:()=>null,upgradeAuthority:()=>null,transportRenewable:()=>false},upgrades:{commandReady:()=>false,view:()=>{throw new Error('purchase history on hot path');}}} as unknown as SinglePixelWriter;
    const http=new ConnectorHttpChannel(pairing,provider,KEY,Date.now,writer),claim=http.claim(ORIGIN,http.issue(KEY,ORIGIN).token);
    http.approve(KEY,claim.requestId);expect(http.status(claim.capability,10)).toMatchObject({batchProtocol:6,batch:{commandReady:false},upgrades:{commandReady:false}});provider.close();
  });
  it('bounds authenticated message frequency and never returns capabilities from status', () => {
    const s = setup(),
      c = s.ready();
    for (let i = 0; i < 25; i++) {s.http.verify(c.capability,true);s.http.status(c.capability);s.http.verify(c.capability);}
    expect(() => s.http.verify(c.capability,true)).toThrow();
    expect(JSON.stringify(s.http.info())).not.toContain(c.capability);
    expect(JSON.stringify(s.http.info())).not.toContain(KEY);
  });
});


describe('Precise coupling diagnostics independent of drawing authority',()=>{
  it('retains the original approval timestamp after inactivity',()=>{
    const s=setup(),c=s.ready(),initial=s.http.info();
    expect(initial).toMatchObject({approvedAt:100000,expires:null,remainingMs:null});
    s.advance(3_600_000);s.http.tick();
    expect(s.http.status(c.capability)).toMatchObject({ approved: true });
    expect(s.http.info()).toEqual(initial);
    expect(s.events.map(e=>e.code)).toEqual(['HTTP_APPROVED']);
  });
  it('revokes an approved idle reader and keeps the reason across repeated cleanup calls',()=>{
    const s=setup(),c=s.ready();s.advance(600_000);s.http.tick();s.http.revoke();s.http.revoke();
    expect(s.http.info().lastTermination?.code).toBe('HTTP_REVOKED');
    expect(()=>s.http.status(c.capability)).toThrow();
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
    const now=100000,p=new GeoPixelsProvider(()=>now),pair=new ConnectorPairing(()=>now);
    const h=new ConnectorHttpChannel(pair,p,KEY,()=>now,undefined,()=>{throw new Error('logger unavailable');});
    const c=h.claim(ORIGIN,h.issue(KEY,ORIGIN).token);h.approve(KEY,c.requestId);h.revoke();
    expect(p.status().connected).toBe(false);expect(h.info().lastTermination?.code).toBe('HTTP_REVOKED');
  });
});

describe('Transport renewal is separate from drawing authority',()=>{
  function renewable(){
    let now=100000,authorized=true;
    const pairing=new ConnectorPairing(()=>now),provider=new GeoPixelsProvider(()=>now),events:ChannelDiagnostic[]=[];
    const writer={batch:{subscribe:()=>()=>{},transportRenewable:()=>authorized,control:()=>({commandReady:false}),view:()=>({commandReady:false}),grant:()=>null}} as unknown as SinglePixelWriter;
    const http=new ConnectorHttpChannel(pairing,provider,KEY,()=>now,writer,e=>events.push(e));
    const c=http.claim(ORIGIN,http.issue(KEY,ORIGIN).token);http.approve(KEY,c.requestId);http.status(c.capability,9);
    return {http,provider,c,events,advance:(ms:number)=>{now+=ms;},stop:()=>{authorized=false;}};
  }
  it('retries a lost rotation reply idempotently, commits possession, preserves epoch/sequence and rejects the old capability',()=>{
    const s=renewable(),epoch=s.provider.channelEpoch,nonce=randomUUID(),before=s.http.info().approvedAt;
    const a=s.http.renew(s.c.capability,nonce);expect(s.http.renew(s.c.capability,nonce)).toEqual(a);
    expect(s.http.info().approvedAt).toBe(before);s.advance(1000);
    expect(s.http.status(a.capability,9)).toMatchObject({lastSequence:0,approved:true});
    expect(s.provider.channelEpoch).toBe(epoch);expect(s.http.info().approvedAt).toBe(before);
    expect(()=>s.http.status(s.c.capability,9)).toThrow();expect(s.events.at(-1)?.code).toBe('HTTP_RENEWED');
  });
  it('does not require a rotation when an authorized drawing stops',()=>{
    const s=renewable(),epoch=s.provider.channelEpoch;
    s.advance(3_600_000);s.stop();
    expect(s.http.status(s.c.capability,9)).toMatchObject({approved:true,renewRequired:false});
    expect(s.provider.channelEpoch).toBe(epoch);expect(s.http.info().active).toBe(true);
  });
  it('cannot renew stopped or revoked work, or commit an expired rotation',()=>{
    const stopped=renewable(),rotation=stopped.http.renew(stopped.c.capability,randomUUID());stopped.stop();
    expect(()=>stopped.http.renew(stopped.c.capability,randomUUID())).toThrow();expect(()=>stopped.http.status(rotation.capability,9)).toThrow();
    const revoked=renewable(),r=revoked.http.renew(revoked.c.capability,randomUUID());revoked.http.revoke();
    expect(()=>revoked.http.status(r.capability,9)).toThrow();expect(()=>revoked.http.renew(revoked.c.capability,randomUUID())).toThrow();
    const expired=renewable(),pending=expired.http.renew(expired.c.capability,randomUUID());expired.advance(10_001);
    expect(()=>expired.http.status(pending.capability,9)).toThrow();
    expect(expired.http.status(expired.c.capability,9).approved).toBe(true);
  });
  it('cannot rotate an unapproved pairing or a legacy read-only session',()=>{
    const s=setup(),c=s.claim();expect(()=>s.http.renew(c.capability,randomUUID())).toThrow();
    s.http.approve(KEY,c.requestId);s.http.status(c.capability,8);expect(()=>s.http.renew(c.capability,randomUUID())).toThrow();
  });
});

it('keeps command/ACK replies bounded independently of drawing history size',async()=>{
  const pairing=new ConnectorPairing(),provider=new GeoPixelsProvider();
  const verbose={id:'drawing',state:'running',confirmed:50000,acceptedRequests:10000,uncertain:0,commandReady:false,targets:Array(50000).fill({x:1,y:2,color:0})};
  const writer={batch:{subscribe:()=>()=>{},transportRenewable:()=>true,control:()=>verbose,view:()=>verbose,grant:()=>null,result:async()=>verbose}} as unknown as SinglePixelWriter;
  const http=new ConnectorHttpChannel(pairing,provider,KEY,Date.now,writer),c=http.claim(ORIGIN,http.issue(KEY,ORIGIN).token);http.approve(KEY,c.requestId);
  expect(JSON.stringify(http.status(c.capability,9)).length).toBeLessThan(8192);
  const reply=await http.batchResult(c.capability,'drawing','attempt','confirmed');expect(JSON.stringify(reply).length).toBeLessThan(200);expect(reply.confirmed).toBe(50000);
});
