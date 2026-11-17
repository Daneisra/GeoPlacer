import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';

async function setup(hashPending = false) {
  const project = { id: 'image', generation: 'palette', width: 8, height: 5, gridX: 999, gridY: 1001, layer: 'base' };
  let release: ((v: unknown) => void) | undefined;
  const context = vm.createContext({
    crypto: webcrypto,
    TextEncoder,
    URL,
    Date,
    location: { origin: 'https://geopixels.net' },
    document: { scripts: [] },
    getSelectedEventId: () => null,
    OffscreenCanvas: class {},
    ghostImageOriginalData: { width: 8, height: 5 },
    ghostImageTopLeft: { gridX: 999, gridY: 1001 },
    ghostActivePaletteColors: new Set(['black']),
    tileImageCache: new Map(),
    userID: 'private-account',
    userData: { energy: 2 },
    Colors: ['#000000'],
    GeoPlacerCapture: {
      tileAt: (x: number, y: number) => ({
        tileX: Math.floor(x / 1000) * 1000,
        tileY: Math.floor(y / 1000) * 1000,
        localX: x % 1000,
        localY: y % 1000,
      }),
      identity: hashPending
        ? () =>
            new Promise((resolve) => {
              release = resolve;
            })
        : async () => project,
      resources: () => null,
      readRegion: (_p: unknown, rect: { width: number; height: number }) =>
        new Array(rect.width * rect.height).fill(-2),
    },
  });
  vm.runInContext(
    (await readFile(new URL('../../../browser/geopixels-reader.js', import.meta.url), 'utf8')) +
      '\nglobalThis.reader = GeoPlacerPageReader;',
    context
  );
  const reader = context.reader as {
    contract: () => Promise<{ id: string; layer: string }>;
    inspect: () => Promise<string>;
    observe: (send: (v: unknown) => Promise<void>, connected: () => boolean) => Promise<unknown>;
    unchanged: () => Promise<boolean>;
  };
  return { context, reader, project, finish: () => release!(project) };
}
describe('Versioned read-only page contracts', () => {
  it('accepts the current event getter only when it identifies the base layer', async () => {
    const s = await setup();
    expect((await s.reader.contract()).layer).toBe('base');
    s.context.getSelectedEventId = () => 2;
    await expect(
      s.reader.observe(
        async () => {},
        () => true
      )
    ).rejects.toThrow(/événementielle/);
  });
  it.each([null, '', 0, '0', 4, '4', 'unknown'])(
    'reads the explicit public event state without guessing: %s',
    async (state) => {
      const s = await setup();
      s.context.getSelectedEventId = undefined;
      s.context.activeEvent = state;
      expect((await s.reader.contract()).layer).toBe(
        state === 'unknown' ? 'unknown' : state === 4 || state === '4' ? 'event' : 'base'
      );
    }
  );
  it.each([{ value: false }, { value: [] }, { value: {} }, { value: NaN }])('does not coerce an unsupported event state to the base layer', async ({ value }) => {
    const s = await setup(); s.context.getSelectedEventId = undefined; s.context.activeEvent = value;
    expect((await s.reader.contract()).layer).toBe('unknown');
  });
  it('keeps a missing or unrecognized layer unknown and emits no observation', async () => {
    const s = await setup();
    s.context.getSelectedEventId = undefined;
    const sent: unknown[] = [];
    expect((await s.reader.contract()).layer).toBe('unknown');
    await expect(
      s.reader.observe(
        async (v) => {
          sent.push(v);
        },
        () => true
      )
    ).rejects.toThrow(/indéterminée/);
    expect(sent).toHaveLength(0);
    expect(await s.reader.inspect()).not.toContain('private-account');
  });
  it.each(['position', 'palette', 'session', 'model'])(
    'refuses a changed %s after asynchronous hashing',
    async (kind) => {
      const s = await setup(true),
        sent: unknown[] = [];
      const pending = s.reader.observe(
        async (v) => {
          sent.push(v);
        },
        () => true
      );
      await Promise.resolve();
      await Promise.resolve();
      if (kind === 'position') s.context.ghostImageTopLeft = { gridX: 1, gridY: 2 };
      if (kind === 'palette') s.context.ghostActivePaletteColors = new Set(['white']);
      if (kind === 'session') s.context.userID = 'another-private-account';
      if (kind === 'model') s.context.ghostImageOriginalData = { width: 8, height: 5 };
      s.finish();
      await expect(pending).rejects.toThrow(/modifié/);
      expect(sent).toHaveLength(0);
    }
  );
  it.each(['recognized', 'different-map', 'event-script'])(
    'requires both public legacy fingerprints and no event interface: %s',
    async (kind) => {
      const s = await setup();
      s.context.getSelectedEventId = undefined;
      let executed = 0;
      s.context.placePixels = () => {
        executed++;
        throw new Error('legacy-place');
      };
      s.context.getMapPixelHex = () => {
        executed++;
        throw new Error('legacy-map');
      };
      if (kind === 'event-script') s.context.document.scripts = [{ src: 'https://geopixels.net/js/eventLayer.js' }];
      s.context.crypto = {
        randomUUID: () => 'opaque',
        subtle: {
          digest: async (_algorithm: unknown, input: Uint8Array) => {
            const place = new TextDecoder().decode(input).includes('legacy-place');
            const hash = place
              ? '046cded7e9792f2e3a3c7cf87f6f1a6343f2183b1dfc5fc4bdf0c61cb88794f2'
              : kind === 'different-map'
                ? '0'.repeat(64)
                : '4d7fadb08c6b8bb77dbb4e596c2e67926574a283f4c702e1ef4b79177c865b87';
            return Uint8Array.from(Buffer.from(hash, 'hex')).buffer;
          },
        },
      };
      expect((await s.reader.contract()).layer).toBe(kind === 'recognized' ? 'base' : 'unknown');
      expect(executed).toBe(0);
    }
  );
  it('retains native Y orientation and unknown coverage without transmitting account identity', async () => {
    const s = await setup(),
      sent: unknown[] = [];
    await s.reader.observe(
      async (v) => {
        sent.push(v);
      },
      () => true
    );
    expect(sent[0]).toMatchObject({ rect: { x: 999, y: 997, width: 8, height: 5 }, observedAt: null, resources: null });
    expect(JSON.stringify(sent)).not.toContain('private-account');
    expect(await s.reader.unchanged()).toBe(true);
    s.context.ghostImageTopLeft = null;
    expect(await s.reader.unchanged()).toBeFalsy();
  });
});
