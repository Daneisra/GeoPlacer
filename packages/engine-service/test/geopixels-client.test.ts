import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
type Element = {
  textContent: string;
  disabled: boolean;
  onclick?: () => Promise<void>;
  append: (...values: Element[]) => void;
  style: { cssText: string };
};
async function setup(origin = 'https://geopixels.net') {
  const elements: Element[] = [],
    requests: unknown[] = [];
  let connected = false;
  let now = 100000;
  const polls: ((value: { monitoring: { revision: number; state: string; intervalMs: number } }) => void)[] = [];
  let control: { revision: number; state: string; intervalMs: number } | undefined;
  const channel = {
    pair: async (_code: string, _origin: string, pending: (s: string) => void) => {
      pending('123456abcdef');
      connected = true;
    },
    send: async (value: unknown) => {
      requests.push(value);
    },
    poll: () => new Promise<{ monitoring: { revision: number; state: string; intervalMs: number } }>(resolve => polls.push(resolve)),
    disconnect: async () => {
      connected = false;
    },
    connected: () => connected,
    latency: () => 12,
  };
  const reader = {
    inspect: async () => 'Contrat inconnu : aucune observation',
    unchanged: async () => true,
    observe: async (send: (o: unknown) => Promise<void>) => {
      await send({ type: 'observation' });
      return { contract: 'fixture' };
    },
  };
  const context = vm.createContext({
    location: { origin },
    document: {
      body: { append: () => {} },
      createElement: () => {
        const e: Element = { textContent: '', disabled: false, style: { cssText: '' }, append: () => {} };
        elements.push(e);
        return e;
      },
    },
    prompt: (() => {
      const inputs = ['http://127.0.0.1:3921', 'a'.repeat(64)];
      return () => inputs.shift();
    })(),
    GeoPlacerReaderVersion: 'test',
    GM_xmlhttpRequest: () => {},
    GeoPlacerHttpTransport: () => channel,
    GeoPlacerPageReader: reader,
    Date: { now: () => now },
    setInterval: () => { throw new Error('Page cadence timers are forbidden by this fixture'); },
    WebSocket: () => {
      throw new Error('page WebSocket forbidden');
    },
  });
  vm.runInContext(await readFile(new URL('../../../browser/geopixels-client.js', import.meta.url), 'utf8'), context);
  const button = (text: string) => elements.find((e) => e.textContent === text)!;
  const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
  const tick=async()=>{await flush();polls.shift()?.({monitoring:control ?? {revision:0,state:'stopped',intervalMs:5000}});await flush();};
  return { context, elements, channel, reader, button, requests, tick, advance: (ms: number) => { now += ms; }, setControl: (value: typeof control) => { control = value; } };
}
describe('Passive HTTP reader panel in a local DOM fixture', () => {
  it('captures repeatedly only when requested, then pauses, resumes and stops without catching up', async () => {
    const s = await setup(); await s.button('Coupler').onclick!();
    await s.tick(); expect(s.requests).toHaveLength(0);
    s.setControl({ revision:1, state:'running', intervalMs:5000 }); await s.tick();
    expect(s.requests).toHaveLength(1);
    s.advance(4999); await s.tick(); expect(s.requests).toHaveLength(1);
    s.advance(1); await s.tick(); expect(s.requests).toHaveLength(2);
    s.setControl({ revision:2, state:'paused', intervalMs:5000 }); await s.tick();
    s.advance(60000); await s.tick(); expect(s.requests).toHaveLength(2);
    s.setControl({ revision:3, state:'running', intervalMs:5000 }); await s.tick(); expect(s.requests).toHaveLength(3);
    s.setControl({ revision:4, state:'stopped', intervalMs:5000 }); await s.tick();
    s.advance(60000); await s.tick(); expect(s.requests).toHaveLength(3);
  });
  it('never overlaps captures or applies a late control response after disconnect', async () => {
    const s = await setup(); await s.button('Coupler').onclick!();
    s.setControl({revision:1,state:'running',intervalMs:5000});
    await s.button('Déconnecter').onclick!(); await s.tick();
    expect(s.requests).toHaveLength(0); expect(s.channel.connected()).toBe(false);
  });
  it('stops after a changed model and does not auto-pair again', async () => {
    const s = await setup(); await s.button('Coupler').onclick!();
    s.setControl({ revision:1, state:'running', intervalMs:5000 });
    s.reader.unchanged=async()=>false; await s.tick();
    expect(s.requests).toHaveLength(0); expect(s.channel.connected()).toBe(false);
  });
  it.each(['https://geopixels.net', 'https://www.geopixels.net'])(
    'couples only the HTTP reader on %s',
    async (origin) => {
      const s = await setup(origin);
      await s.button('Coupler').onclick!();
      expect(s.button('Observer le modèle').disabled).toBe(false);
      await s.button('Observer le modèle').onclick!();
      expect(s.requests).toHaveLength(1);
      expect(s.elements.some((e) => e.textContent.startsWith('Observation confirmée'))).toBe(true);
    }
  );
  it.each(['https://evil.example', 'https://dev.geopixels.net', 'https://geopixels.net.evil.example'])(
    'does not run on %s',
    async (origin) => expect((await setup(origin)).elements).toHaveLength(0)
  );
  it('keeps a transport error visible and disables observation', async () => {
    const s = await setup();
    s.channel.pair = async () => {
      throw new Error('Transport refusé');
    };
    await s.button('Coupler').onclick!();
    expect(s.elements.some((e) => e.textContent === 'Transport refusé')).toBe(true);
    expect(s.button('Observer le modèle').disabled).toBe(true);
  });
  it('does not announce a successful observation when its acknowledgement is lost', async () => {
    const s = await setup();
    await s.button('Coupler').onclick!();
    s.channel.send = async () => {
      throw new Error('Observation non confirmée');
    };
    await s.button('Observer le modèle').onclick!();
    expect(s.elements.some((e) => e.textContent === 'Observation non confirmée')).toBe(true);
    expect(s.channel.connected()).toBe(false);
  });
  it('disconnects explicitly and allows the diagnostic while unpaired', async () => {
    const s = await setup();
    await s.button('Coupler').onclick!();
    await s.button('Déconnecter').onclick!();
    expect(s.channel.connected()).toBe(false);
    await s.button('Diagnostiquer').onclick!();
    expect(s.elements.some((e) => e.textContent.startsWith('Contrat inconnu'))).toBe(true);
  });
  it('ignores completion of a pairing cancelled by the user', async () => {
    const s = await setup();
    let finish: (() => void) | undefined;
    s.channel.pair = async () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const pending = s.button('Coupler').onclick!();
    await Promise.resolve();
    await Promise.resolve();
    await s.button('Déconnecter').onclick!();
    finish!();
    await pending;
    expect(s.button('Observer le modèle').disabled).toBe(true);
  });
});
