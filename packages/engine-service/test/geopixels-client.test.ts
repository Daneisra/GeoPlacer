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
  const channel = {
    pair: async (_code: string, _origin: string, pending: (s: string) => void) => {
      pending('123456abcdef');
      connected = true;
    },
    send: async (value: unknown) => {
      requests.push(value);
    },
    heartbeat: async () => {},
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
    setInterval: () => 1,
    clearInterval: () => {},
    WebSocket: () => {
      throw new Error('page WebSocket forbidden');
    },
  });
  vm.runInContext(await readFile(new URL('../../../browser/geopixels-client.js', import.meta.url), 'utf8'), context);
  const button = (text: string) => elements.find((e) => e.textContent === text)!;
  return { context, elements, channel, reader, button, requests };
}
describe('Passive HTTP reader panel in a local DOM fixture', () => {
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
