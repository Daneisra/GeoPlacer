import { describe, it, expect, vi } from 'vitest';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import { readFile } from 'node:fs/promises';

type Options = {
  url: string;
  method: string;
  data: string;
  anonymous: boolean;
  headers: Record<string, string>;
  onload: (v: unknown) => void;
  onerror: () => void;
};
async function setup(failures = 0, rotationFailures = 0) {
  const sent: Options[] = [];
  const context = vm.createContext({ crypto:webcrypto, URL, TextEncoder, setTimeout, clearTimeout, performance });
  const source = await readFile(new URL('../../../browser/geopixels-http-transport.js', import.meta.url), 'utf8');
  vm.runInContext(source + '\nglobalThis.factory = GeoPlacerHttpTransport;', context);
  const request = (o: Options) => {
    sent.push(o);
    const path = new URL(o.url).pathname.split('/').at(-1);
    if (path === 'observations' && failures-- > 0) {
      o.onerror();
      return { abort: () => {} };
    }
    if (path === 'renew' && rotationFailures-- > 0) {o.onerror();return {abort:()=>{}};}
    const body =
      path === 'renew' ? {nonce:JSON.parse(o.data).nonce,capability:'e'.repeat(64)} : path === 'claim'
        ? { capability: 'a'.repeat(64), requestId: 'b'.repeat(64), fingerprint: 'c'.repeat(12) }
        : path === 'status'
          ? { approved: true, lastSequence: 0, pacing: 'server-50ms', regionalProtocol:1, batchProtocol:6 }
          : path === 'observations'
            ? { accepted: true, sequence: JSON.parse(o.data).observations[0].sequence }
            : { disconnected: true };
    o.onload({ status: 200, finalUrl: o.url, responseText: JSON.stringify(body) });
    return { abort: () => {} };
  };
  const make = (address = 'http://127.0.0.1:3921', gm: unknown = request) =>
    context.factory(address, gm) as {
      pair: (code: string, origin: string, pending: (fp: string) => void) => Promise<void>;
      send: (o: unknown) => Promise<void>;
      renew: () => Promise<void>;
      poll: () => Promise<unknown>;
      claimUpgrade:()=>Promise<unknown>;
      upgradeAllowed:(id:string)=>Promise<boolean>;
      upgradeResult:(id:string,result:string)=>Promise<unknown>;
      disconnect: () => Promise<void>;
      connected: () => boolean;
    };
  return { sent, make };
}
it('retries a lost renewal reply with the identical nonce, using the new capability only after receiving it',async()=>{
  const s=await setup(0,1),t=s.make();await t.pair('d'.repeat(64),'https://geopixels.net',()=>{});await t.renew();await t.poll();
  const rotations=s.sent.filter(o=>o.url.endsWith('/renew'));expect(rotations).toHaveLength(2);expect(rotations[0]!.data).toBe(rotations[1]!.data);expect(s.sent.at(-1)!.headers.Authorization).toBe('Bearer '+'e'.repeat(64));
});

describe('Actual GM privileged transport, mocked extension API only', () => {
  it('admits only the three fixed purchase protocol operations, without a proxy URL or site credentials',async()=>{
    const s=await setup(),t=s.make(),id='64de9aa7-8259-4f7d-98b5-5a861ca8b3fe';
    await t.pair('d'.repeat(64),'https://geopixels.net',()=>{});
    await t.claimUpgrade();await t.upgradeAllowed(id);await t.upgradeResult(id,'accepted');
    expect(s.sent.slice(-3).map(o=>new URL(o.url).pathname.split('/').at(-1))).toEqual(['upgrade-claim','upgrade-check','upgrade-result']);
    expect(s.sent.slice(-3).map(o=>JSON.parse(o.data))).toEqual([{protocol:1},{protocol:1,id},{protocol:1,id,result:'accepted'}]);
    expect(s.sent.every(o=>o.anonymous)).toBe(true);
  });
  it.each([
    'http://localhost:3921',
    'https://127.0.0.1:3921',
    'http://127.0.0.1:3921/x',
    'http://user@127.0.0.1:3921',
    'http://127.0.0.1.evil:3921',
  ])('refuses an endpoint outside the fixed contract: %s', async (url) => {
    const s = await setup();
    expect(() => s.make(url)).toThrow();
  });
  it('requires the granted API, claims explicitly and sends no cookies or site secret', async () => {
    const s = await setup();
    expect(() => s.make(undefined, null)).toThrow();
    const transport = s.make(),
      pending = vi.fn();
    await transport.pair('d'.repeat(64), 'https://geopixels.net', pending);
    expect(pending).toHaveBeenCalledWith('c'.repeat(12));
    await transport.send({ type: 'observation' });
    expect(
      s.sent.every((o) => o.anonymous && o.url.startsWith('http://127.0.0.1:3921/api/v1/connector/privileged/'))
    ).toBe(true);
    expect(s.sent.at(-1)?.headers.Authorization).toBe('Bearer ' + 'a'.repeat(64));
    expect(JSON.stringify(s.sent)).not.toMatch(/tokenUser|cookie|userID/);
  });
  it('retries only the identical observation after a lost acknowledgement', async () => {
    const s = await setup(1),
      t = s.make();
    await t.pair('d'.repeat(64), 'https://geopixels.net', () => {});
    await t.send({ type: 'observation' });
    const attempts = s.sent.filter((o) => o.url.endsWith('/observations'));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.data).toBe(attempts[1]!.data);
  });
  it('keeps an observation unconfirmed after two missing responses', async () => {
    const s = await setup(2),
      t = s.make();
    await t.pair('d'.repeat(64), 'https://geopixels.net', () => {});
    await expect(t.send({ type: 'observation' })).rejects.toThrow();
    expect(t.connected()).toBe(false);
  });
  it('rejects concurrent sends and releases the capability on disconnect', async () => {
    const s = await setup(),
      t = s.make();
    await t.pair('d'.repeat(64), 'https://geopixels.net', () => {});
    const first = t.send({ type: 'observation' });
    await expect(t.send({ type: 'observation' })).rejects.toThrow(/concurrent/);
    await first;
    await t.disconnect();
    await expect(t.send({})).rejects.toThrow();
  });
  it('enforces its own deadline even when the GM implementation supplies no timeout', async () => {
    vi.useFakeTimers();
    try {
      const s = await setup(),
        abort = vi.fn();
      const t = s.make(undefined, () => ({ abort }));
      const outcome = expect(t.pair('d'.repeat(64), 'https://geopixels.net', () => {})).rejects.toThrow(/absente/);
      await vi.advanceTimersByTimeAsync(8001);
      await outcome;
      expect(abort).toHaveBeenCalledOnce();
      expect(t.connected()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it('refuses a redirect or an invalid acknowledgement', async () => {
    const s = await setup();
    const t = s.make(undefined, (o: Options) => {
      o.onload({ status: 200, finalUrl: 'http://127.0.0.1:9999/other', responseText: '{}' });
    });
    await expect(t.pair('d'.repeat(64), 'https://geopixels.net', () => {})).rejects.toThrow();
  });
});
