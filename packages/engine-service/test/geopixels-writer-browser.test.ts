import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

type Command = {
    protocol: number;
    attemptId: string;
    project: Record<string, unknown>;
    gridX: number;
    gridY: number;
    color: number;
    deadline: number;
};
async function setup(
    options: {
        reply?: string;
        ok?: boolean;
        lost?: boolean;
        approved?: boolean;
        energy?: number;
        colors?: (number | string)[] | string;
        changed?: boolean;
    } = {}
) {
    const project = { id: 'fixture', generation: '1', width: 3, height: 2, gridX: 999, gridY: 1001, layer: 'base' };
    const command: Command = {
        protocol: 1,
        attemptId: '64de9aa7-8259-4f7d-98b5-5a861ca8b3fe',
        project,
        gridX: 1000,
        gridY: 1000,
        color: 0xbd637d,
        deadline: Date.now() + 25000,
    };
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const store = new Map<string, string>();
    const fetch = vi.fn(async (url: string, o: { body: string }) => {
        sent.push({ url, body: JSON.parse(o.body) as Record<string, unknown> });
        if (options.lost) throw new Error('lost response with private detail');
        return { ok: options.ok ?? true, text: async () => options.reply ?? 'Ok' };
    });
    const context = vm.createContext({
        Date,
        AbortController,
        setTimeout,
        clearTimeout,
        GeoPlacerPageReader: {
            project: () => project,
            contract: async () => ({ layer: 'base', id: 'base-only-8367389' }),
            unchanged: async () => !options.changed,
        },
        location: { origin: 'https://geopixels.net' },
        confirm: vi.fn(() => options.approved ?? true),
        fetch,
        tokenUser: 'synthetic-browser-only-secret',
        subject: 'synthetic-browser-only-subject',
        userID: 123,
        currentEnergy: options.energy ?? 5,
        userData: { colors: options.colors ?? [command.color] },
        queuedPixelsObjects: new Map(),
        isPlacingRequestInProgress: false,
        sessionStorage: { getItem: (k: string) => store.get(k), setItem: (k: string, v: string) => store.set(k, v) },
    });
    const source = await readFile(new URL('../../..//browser/geopixels-writer.js', import.meta.url), 'utf8');
    vm.runInContext(source + '\nglobalThis.writer=GeoPlacerPageWriter;', context);
    const writer = context.writer as {
        execute: (c: Command, allowed: (id: string) => Promise<boolean>, trusted: boolean) => Promise<string>;
        stop: () => void;
        reason: () => string | null;
        inspect: () => string;
    };
    return { command, writer, fetch, sent, store, context, allowed: vi.fn(async () => true) };
}
describe('Browser-only single pixel writer; all fetches are local mocks', () => {
    it('uses the verified same-origin body with one native coordinate, without calling the native queue or exporting credentials', async () => {
        const s = await setup();
        expect(await s.writer.execute(s.command, s.allowed, true)).toBe('confirmed');
        expect(s.sent).toEqual([
            {
                url: 'https://geopixels.net/PlacePixels',
                body: {
                    Token: 'synthetic-browser-only-secret',
                    Subject: 'synthetic-browser-only-subject',
                    UserId: 123,
                    Pixels: [{ GridX: 1000, GridY: 1000, Color: 0xbd637d }],
                },
            },
        ]);
        expect([...s.store.values()].join()).not.toMatch(/secret|subject/);
        expect(s.allowed).toHaveBeenCalledWith(s.command.attemptId);
        expect(await s.writer.execute(s.command, s.allowed, true)).toBe('not-sent');
        expect(s.fetch).toHaveBeenCalledTimes(1);
    });
    it.each([{ approved: false }, { energy: 0 }, { colors: [] }, { changed: true }])(
        'refuses before sending for %o',
        async (options) => {
            const s = await setup(options);
            expect(await s.writer.execute(s.command, s.allowed, true)).toBe('not-sent');
            expect(s.fetch).not.toHaveBeenCalled();
        }
    );
    it.each([{ lost: true }, { reply: 'OK' }, { reply: ' Ok' }, { ok: false }])(
        'marks any ambiguous response uncertain, with no retry: %o',
        async (options) => {
            const s = await setup(options);
            expect(await s.writer.execute(s.command, s.allowed, true)).toBe('uncertain');
            expect(await s.writer.execute(s.command, s.allowed, true)).toBe('not-sent');
            expect(s.fetch).toHaveBeenCalledTimes(1);
        }
    );
    it('requires a trusted button event and a still-valid operation grant', async () => {
        const s = await setup();
        expect(await s.writer.execute(s.command, s.allowed, false)).toBe('not-sent');
        expect(await s.writer.execute(s.command, async () => false, true)).toBe('not-sent');
        expect(s.fetch).not.toHaveBeenCalled();
    });
    it.each(['extra', 'outside', 'expired', 'event'])('refuses invalid or changed destinations: %s', async (kind) => {
        const s = await setup();
        const c = { ...s.command };
        if (kind === 'extra') Object.assign(c, { url: 'https://example.invalid' });
        if (kind === 'outside') c.gridY = 1002;
        if (kind === 'expired') c.deadline = Date.now() - 1;
        if (kind === 'event') c.project = { ...c.project, layer: 'event' };
        expect(await s.writer.execute(c, s.allowed, true)).toBe('not-sent');
        expect(s.fetch).not.toHaveBeenCalled();
    });
    it('stops a fetch already in progress as uncertain and does not retry', async () => {
        const s = await setup();
        s.context.fetch = vi.fn(
            (_url: string, o: { signal: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                    o.signal.addEventListener('abort', () => reject(new Error('aborted')));
                    s.writer.stop();
                })
        );
        expect(await s.writer.execute(s.command, s.allowed, true)).toBe('uncertain');
    });
    it('refuses a caller outside the two exact GeoPixels origins', async () => {
        const s = await setup();
        s.context.location = { origin: 'https://evil.example' };
        expect(await s.writer.execute(s.command, s.allowed, true)).toBe('not-sent');
        expect(s.fetch).not.toHaveBeenCalled();
    });
    it.each(['0, 16777215', ['0', '16777215'], [0, 16777215]])(
        'accepts observed black/white ownership in login and sync formats: %o',
        async (colors) => {
            for (const color of [0, 16777215]) {
                const s = await setup({ colors });
                s.command.color = color;
                expect(await s.writer.execute(s.command, s.allowed, true)).toBe('confirmed');
                expect(s.fetch).toHaveBeenCalledTimes(1);
                expect(s.sent[0]!.body.Pixels).toEqual([{ GridX: 1000, GridY: 1000, Color: color }]);
            }
        }
    );
    it.each(['', '0,broken', '#000000', '0x000000', '-1', '16777216', '0,'.repeat(257)])(
        'rejects malformed account palettes without guessing: %s',
        async (colors) => {
            const s = await setup({ colors });
            expect(await s.writer.execute(s.command, s.allowed, true)).toBe('not-sent');
            expect(s.writer.reason()).toContain('Format des couleurs');
            expect(s.fetch).not.toHaveBeenCalled();
        }
    );
    it('accepts a sync switching the palette from array to CSV during confirmation', async () => {
        const s = await setup();
        s.context.confirm = () => {
            s.context.userData = { colors: String(s.command.color) };
            return true;
        };
        expect(await s.writer.execute(s.command, s.allowed, true)).toBe('confirmed');
        expect(s.fetch).toHaveBeenCalledTimes(1);
    });
    it('compares exact project fields independently of JSON property order', async () => {
        const s = await setup();
        s.command.project = Object.fromEntries(Object.entries(s.command.project).reverse());
        expect(await s.writer.execute(s.command, s.allowed, true)).toBe('confirmed');
    });
    it('explains refusal and provides a passive diagnostic without revealing session values', async () => {
        const s = await setup({ energy: 0 });
        expect(s.writer.inspect()).toContain('Énergie insuffisante');
        expect(s.fetch).not.toHaveBeenCalled();
        expect(await s.writer.execute(s.command, s.allowed, true)).toBe('not-sent');
        expect(s.writer.reason()).toContain('Énergie insuffisante');
        expect(s.writer.reason() + s.writer.inspect()).not.toMatch(/synthetic|secret|subject|123/);
    });
    it('refuses execution if the duplicate ledger cannot be saved', async () => {
        const s = await setup();
        s.context.sessionStorage = {
            getItem: () => null,
            setItem: () => {
                throw new Error('unavailable');
            },
        };
        expect(await s.writer.execute(s.command, s.allowed, true)).toBe('not-sent');
        expect(s.fetch).not.toHaveBeenCalled();
    });
});
