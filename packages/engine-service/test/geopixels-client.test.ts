import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

type Element = {
  textContent: string;
  disabled: boolean;
  onclick?: () => Promise<void> | void;
  append: (...values: Element[]) => void;
  style: { cssText: string };
};
class Socket {
  static all: Socket[] = [];
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  constructor(readonly url: string) {
    Socket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}
async function setup(origin = 'https://geopixels.net', identity?: () => Promise<unknown>) {
  Socket.all = [];
  const elements: Element[] = [];
  const listeners: Record<string, (event: unknown) => void> = {};
  const inputs = ['http://127.0.0.1:3921', 'a'.repeat(64)];
  const project = { id: 'image', generation: 'filters', width: 8, height: 5, gridX: 999, gridY: 1001, layer: 'base' };
  const context = vm.createContext({
    location: { origin },
    URL,
    crypto: { randomUUID: () => 'opaque-session' },
    document: {
      addEventListener: (name: string, listener: (event: unknown) => void) => {
        listeners[name] = listener;
      },
      body: { append: () => {} },
      createElement: () => {
        const e: Element = { textContent: '', disabled: false, style: { cssText: '' }, append: () => {} };
        elements.push(e);
        return e;
      },
    },
    prompt: () => inputs.shift(),
    WebSocket: Socket,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    Map,
    OffscreenCanvas: class {},
    getSelectedEventId: () => null,
    ghostImageOriginalData: { width: 8, height: 5 },
    ghostImageTopLeft: { gridX: 999, gridY: 1001 },
    ghostActivePaletteColors: new Set(['black']),
    tileImageCache: new Map(),
    userID: 'private-id',
    userData: { energy: 2 },
    Colors: ['#000000'],
    GeoPlacerCapture: {
      identity: identity ?? (async () => project),
      resources: () => null,
      readRegion: () => new Array(40).fill(-2),
    },
  });
  vm.runInContext(await readFile(new URL('../../../browser/geopixels-client.js', import.meta.url), 'utf8'), context);
  const button = (text: string) => elements.find((e) => e.textContent === text)!;
  const status = () =>
    elements.find(
      (e) =>
        e.textContent.startsWith('Déconnecté') ||
        e.textContent.startsWith('Connexion locale') ||
        e.textContent.startsWith('Cache observé') ||
        e.textContent.includes('pendant la lecture')
    );
  function connect() {
    button('Coupler').onclick!();
    const socket = Socket.all.at(-1)!;
    socket.onopen!();
    socket.onmessage!({ data: JSON.stringify({ type: 'paired', mode: 'read-only' }) });
    return socket;
  }
  return { context, elements, button, status, connect, project, listeners };
}

describe('Actual passive reader client in a local DOM contract fixture', () => {
  it.each(['https://geopixels.net', 'https://www.geopixels.net'])(
    'runs on the explicitly supported origin %s',
    async (origin) => {
      const s = await setup(origin),
        socket = s.connect();
      expect(socket.url).toBe('ws://127.0.0.1:3921/api/v1/connector/channel');
      await s.button('Observer le modèle').onclick!();
      expect(socket.sent.at(-1)).toMatchObject({
        type: 'observation',
        observedAt: null,
        rect: { x: 999, y: 997, width: 8, height: 5 },
      });
      expect(JSON.stringify(socket.sent)).not.toContain('private-id');
    }
  );
  it.each(['https://evil.example', 'https://dev.geopixels.net', 'https://geopixels.net.evil.example'])(
    'does not run on %s',
    async (origin) => expect((await setup(origin)).elements).toHaveLength(0)
  );
  it('keeps the browser connection error visible after the close event', async () => {
    const s = await setup(),
      socket = s.connect();
    socket.onerror!();
    socket.onclose!({ code: 1006 });
    expect(s.elements.some((e) => e.textContent.startsWith('Connexion locale refusée'))).toBe(true);
  });
  it('reports a matching CSP violation without exposing its policy or hiding it on close', async () => {
    const s = await setup(),
      socket = s.connect();
    s.listeners.securitypolicyviolation!({
      effectiveDirective: 'connect-src',
      blockedURI: 'ws://127.0.0.1:3921/api/v1/connector/channel',
    });
    socket.onerror!();
    socket.onclose!({ code: 1006 });
    expect(s.elements.some((e) => e.textContent.startsWith('Connexion bloquée par la politique CSP'))).toBe(true);
  });
  it('ignores unrelated CSP violations', async () => {
    const s = await setup();
    s.connect();
    s.listeners.securitypolicyviolation!({
      effectiveDirective: 'connect-src',
      blockedURI: 'https://unrelated.example',
    });
    expect(s.elements.some((e) => e.textContent.includes('CSP'))).toBe(false);
  });
  it('handles synchronous browser refusal without leaving an active channel', async () => {
    const s = await setup();
    s.context.WebSocket = class {
      constructor() {
        throw new Error('SecurityError');
      }
    };
    s.button('Coupler').onclick!();
    expect(s.elements.some((e) => e.textContent.startsWith('Création du canal refusée'))).toBe(true);
    expect(s.button('Observer le modèle').disabled).toBe(true);
  });
  it('preserves a new channel when a late message arrives on an old socket', async () => {
    const s = await setup(),
      old = s.connect();
    s.context.prompt = (() => {
      const values = ['http://127.0.0.1:3921', 'b'.repeat(64)];
      return () => values.shift();
    })();
    const current = s.connect();
    old.onmessage!({ data: JSON.stringify({ type: 'unavailable' }) });
    expect(current.readyState).toBe(1);
    expect(s.button('Observer le modèle').disabled).toBe(false);
  });
  it.each(['position', 'palette', 'session', 'model'])(
    'refuses a capture changed during identity hashing: %s',
    async (what) => {
      let finish: ((value: unknown) => void) | undefined;
      const s = await setup(
          'https://geopixels.net',
          () =>
            new Promise((resolve) => {
              finish = resolve;
            })
        ),
        socket = s.connect();
      const pending = s.button('Observer le modèle').onclick!();
      if (what === 'position') s.context.ghostImageTopLeft = { gridX: 1000, gridY: 1001 };
      if (what === 'palette') s.context.ghostActivePaletteColors = new Set(['white']);
      if (what === 'session') s.context.userID = 'another-private-id';
      if (what === 'model') s.context.ghostImageOriginalData = { width: 8, height: 5 };
      finish!(s.project);
      await pending;
      expect(socket.sent.filter((m) => m.type === 'observation')).toHaveLength(0);
      expect(s.elements.some((e) => e.textContent.includes('pendant la lecture'))).toBe(true);
    }
  );
  it('distinguishes a missing page context from an unsupported event layer', async () => {
    const s = await setup();
    s.connect();
    s.context.getSelectedEventId = undefined;
    await s.button('Observer le modèle').onclick!();
    expect(s.elements.some((e) => e.textContent.startsWith('Interface de couche indisponible'))).toBe(true);
  });
});
