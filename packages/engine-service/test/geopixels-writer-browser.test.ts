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
type NativeCommand = Omit<Command, 'gridX' | 'gridY' | 'color'> & {
    protocol: 2;
    batchId: string;
    pixels: { gridX: number; gridY: number; color: number }[];
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
        executeBatch: (
            c: (Command & { batchId: string }) | NativeCommand,
            allowed: (id: string) => Promise<boolean>,
            grant: object
        ) => Promise<string>;
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

function lot(s: Awaited<ReturnType<typeof setup>>) {
    const id = '8c555673-b6ee-4c25-8a33-84b90e84d6c4';
    const commands = Array.from({ length: 5 }, (_, i) => ({
        ...s.command,
        batchId: id,
        attemptId: `64de9aa7-8259-4f7d-98b5-5a861ca8b3f${i}`,
        gridX: 999 + (i % 3),
        gridY: 1001 - Math.floor(i / 3),
    }));
    const grant = {
        id,
        digest: 'a'.repeat(64),
        project: s.command.project,
        expires: Date.now() + 110000,
        writes: commands.map((c) => ({ gridX: c.gridX, gridY: c.gridY, color: c.color })),
    };
    return { commands, grant };
}
describe('Browser writer with one explicit bounded batch approval', () => {
    it('sends five unique single-pixel requests without per-pixel confirmation; refuses duplicate target even with a new attempt', async () => {
        const s = await setup(),
            b = lot(s);
        for (const c of b.commands) expect(await s.writer.executeBatch(c, s.allowed, b.grant)).toBe('confirmed');
        expect(s.fetch).toHaveBeenCalledTimes(5);
        expect(s.context.confirm).not.toHaveBeenCalled();
        expect(s.sent.every((x) => (x.body.Pixels as unknown[]).length === 1)).toBe(true);
        expect(
            await s.writer.executeBatch(
                { ...b.commands[0]!, attemptId: '74de9aa7-8259-4f7d-98b5-5a861ca8b3fe' },
                s.allowed,
                b.grant
            )
        ).toBe('not-sent');
        expect(s.fetch).toHaveBeenCalledTimes(5);
    });
    it('uses a conservative energy budget even when the site counter is not updated', async () => {
        const s = await setup({ energy: 1 }),
            b = lot(s);
        expect(await s.writer.executeBatch(b.commands[0]!, s.allowed, b.grant)).toBe('confirmed');
        expect(await s.writer.executeBatch(b.commands[1]!, s.allowed, b.grant)).toBe('not-sent');
        expect(s.fetch).toHaveBeenCalledTimes(1);
    });
    it('rechecks owned colors, session, queue and channel before each request', async () => {
        const s = await setup(),
            b = lot(s);
        expect(await s.writer.executeBatch(b.commands[0]!, s.allowed, b.grant)).toBe('confirmed');
        s.context.userData = { colors: [] };
        expect(await s.writer.executeBatch(b.commands[1]!, s.allowed, b.grant)).toBe('not-sent');
        s.context.userData = { colors: [s.command.color] };
        expect(await s.writer.executeBatch(b.commands[1]!, async () => false, b.grant)).toBe('not-sent');
        s.context.userID = 124;
        expect(await s.writer.executeBatch(b.commands[1]!, s.allowed, b.grant)).toBe('not-sent');
        expect(s.fetch).toHaveBeenCalledTimes(1);
    });
    it.each(['too-many', 'outside-scope', 'expired', 'unknown-field'])(
        'rejects invalid batch scope: %s',
        async (kind) => {
            const s = await setup(),
                b = lot(s);
            let grant: object = b.grant;
            if (kind === 'too-many') grant = { ...b.grant, writes: [...b.grant.writes, b.grant.writes[0]] };
            if (kind === 'outside-scope') grant = { ...b.grant, writes: [b.grant.writes[1]] };
            if (kind === 'expired') grant = { ...b.grant, expires: Date.now() - 1 };
            if (kind === 'unknown-field') grant = { ...b.grant, url: 'https://example.invalid' };
            expect(await s.writer.executeBatch(b.commands[0]!, s.allowed, grant)).toBe('not-sent');
            expect(s.fetch).not.toHaveBeenCalled();
        }
    );
    it('never repeats an ambiguous native send', async () => {
        const s = await setup({ lost: true }),
            b = lot(s);
        expect(await s.writer.executeBatch(b.commands[0]!, s.allowed, b.grant)).toBe('uncertain');
        expect(await s.writer.executeBatch(b.commands[0]!, s.allowed, b.grant)).toBe('not-sent');
        expect(s.fetch).toHaveBeenCalledTimes(1);
    });
});

function nativeLot(s: Awaited<ReturnType<typeof setup>>) {
    const b = lot(s),
        command: NativeCommand = {
            protocol: 2,
            batchId: b.grant.id,
            attemptId: s.command.attemptId,
            project: s.command.project,
            deadline: s.command.deadline,
            pixels: b.grant.writes,
        };
    return { command, grant: { ...b.grant, execution: 'grouped' } };
}
describe('Native grouped browser writer (site fetch is always mocked)', () => {
    it('sends one request containing exactly five approved targets and never repeats it', async () => {
        const s = await setup(),
            b = nativeLot(s);
        expect(await s.writer.executeBatch(b.command, s.allowed, b.grant)).toBe('confirmed');
        expect(s.fetch).toHaveBeenCalledTimes(1);
        expect(s.context.confirm).not.toHaveBeenCalled();
        expect(s.sent[0]!.body.Pixels).toEqual(
            b.command.pixels.map((p) => ({ GridX: p.gridX, GridY: p.gridY, Color: p.color }))
        );
        expect(
            await s.writer.executeBatch(
                { ...b.command, attemptId: '74de9aa7-8259-4f7d-98b5-5a861ca8b3fe' },
                s.allowed,
                b.grant
            )
        ).toBe('not-sent');
        expect(s.fetch).toHaveBeenCalledTimes(1);
    });
    it.each(['energy', 'color', 'outside', 'duplicate', 'oversized', 'malformed', 'extra', 'revoked'])(
        'refuses the ENTIRE group before sending: %s',
        async (kind) => {
            const s = await setup({ energy: kind === 'energy' ? 4 : 5 }),
                b = nativeLot(s);
            if (kind === 'color') s.context.userData = { colors: [] };
            if (kind === 'outside')
                b.command.pixels = [...b.command.pixels.slice(1), { gridX: 12345, gridY: 0, color: 0 }];
            if (kind === 'duplicate') b.command.pixels = [...b.command.pixels.slice(1), b.command.pixels[1]!];
            if (kind === 'oversized') b.command.pixels = [...b.command.pixels, b.command.pixels[0]!];
            if (kind === 'malformed') Object.assign(b.command, { pixels: [null] });
            if (kind === 'extra') Object.assign(b.command, { url: 'https://example.invalid' });
            expect(
                await s.writer.executeBatch(b.command, kind === 'revoked' ? async () => false : s.allowed, b.grant)
            ).toBe('not-sent');
            expect(s.fetch).not.toHaveBeenCalled();
        }
    );
    it('retains the whole dispatch on a lost global reply with no blind retry', async () => {
        const s = await setup({ lost: true }),
            b = nativeLot(s);
        expect(await s.writer.executeBatch(b.command, s.allowed, b.grant)).toBe('uncertain');
        expect(await s.writer.executeBatch(b.command, s.allowed, b.grant)).toBe('not-sent');
        expect(s.fetch).toHaveBeenCalledTimes(1);
    });
    it('aborts one in-flight native request and retains the whole attempt as uncertain', async () => {
        const s = await setup(),
            b = nativeLot(s);
        s.fetch.mockImplementationOnce(
            (_url, o) =>
                new Promise((_resolve, reject) => {
                    (o as { body: string; signal: AbortSignal }).signal.addEventListener('abort', () =>
                        reject(new Error('aborted'))
                    );
                })
        );
        const result = s.writer.executeBatch(b.command, s.allowed, b.grant);
        for (let i = 0; i < 30 && s.fetch.mock.calls.length === 0; i++) await Promise.resolve();
        expect(s.fetch).toHaveBeenCalledTimes(1);
        s.writer.stop();
        expect(await result).toBe('uncertain');
        expect(await s.writer.executeBatch(b.command, s.allowed, b.grant)).toBe('not-sent');
        expect(s.fetch).toHaveBeenCalledTimes(1);
    });
});

function sessionLot(s: Awaited<ReturnType<typeof setup>>, size = 25, energy = 25) {
    s.command.project.width = 25;
    s.command.project.height = 1;
    const pixels = Array.from({ length: size }, (_, i) => ({ gridX: 999 + i, gridY: 1001, color: s.command.color }));
    const grant = {
        id: '8c555673-b6ee-4c25-8a33-84b90e84d6c4',
        digest: 'b'.repeat(64),
        expires: Date.now() + 110000,
        project: s.command.project,
        execution: 'session',
        budgets: { pixels: 25, energy },
        writes: pixels,
    };
    const commands = Array.from({ length: Math.ceil(size / 5) }, (_, i): NativeCommand => ({
        protocol: 2,
        batchId: grant.id,
        attemptId: `64de9aa7-8259-4f7d-98b5-5a861ca8b3f${i}`,
        project: s.command.project,
        deadline: Date.now() + 25000,
        pixels: pixels.slice(i * 5, i * 5 + 5),
    }));
    return { grant, commands };
}
describe('Browser-only bounded session (no account request or regeneration)', () => {
    it('sends 25 different authorized pixels in five groups under one frozen budget', async () => {
        const s = await setup({ energy: 25 }),
            b = sessionLot(s);
        for (const c of b.commands) expect(await s.writer.executeBatch(c, s.allowed, b.grant)).toBe('confirmed');
        expect(s.fetch).toHaveBeenCalledTimes(5);
        const sent = s.sent.flatMap((x) => x.body.Pixels as { GridX: number; GridY: number }[]);
        expect(sent).toHaveLength(25);
        expect(new Set(sent.map((p) => p.GridX + ',' + p.GridY)).size).toBe(25);
        expect(await s.writer.executeBatch(b.commands[0]!, s.allowed, b.grant)).toBe('not-sent');
        expect(s.fetch).toHaveBeenCalledTimes(5);
    });
    it('refuses a group with insufficient real page energy and resumes only within the original conservative balance', async () => {
        const s = await setup({ energy: 25 }),
            b = sessionLot(s);
        for (const c of b.commands.slice(0, 2))
            expect(await s.writer.executeBatch(c, s.allowed, b.grant)).toBe('confirmed');
        s.context.currentEnergy = 0;
        expect(await s.writer.executeBatch(b.commands[2]!, s.allowed, b.grant)).toBe('not-sent');
        expect(s.fetch).toHaveBeenCalledTimes(2);
        s.context.currentEnergy = 15;
        for (const c of b.commands.slice(2))
            expect(await s.writer.executeBatch(c, s.allowed, b.grant)).toBe('confirmed');
        expect(s.fetch).toHaveBeenCalledTimes(5);
    });
    it('does not invent regeneration or silently change the approved energy budget', async () => {
        const s = await setup({ energy: 10 }),
            b = sessionLot(s);
        for (const c of b.commands.slice(0, 2))
            expect(await s.writer.executeBatch(c, s.allowed, b.grant)).toBe('confirmed');
        s.context.currentEnergy = 25;
        expect(await s.writer.executeBatch(b.commands[2]!, s.allowed, b.grant)).toBe('not-sent');
        expect(s.fetch).toHaveBeenCalledTimes(2);
        const over = { ...b.grant, budgets: { pixels: 25, energy: 26 } };
        expect(await s.writer.executeBatch(b.commands[2]!, s.allowed, over)).toBe('not-sent');
    });
});


describe('Continuous writer browser boundaries',()=>{
    async function continuous() {
        const s=await setup({energy:100,colors:[0]});
        s.context.GeoPlacerPageReader.targetColor=()=>0;
        let available=10;
        s.context.GeoPlacerEnergy={snapshot:()=>({available}),spend:(n:number)=>{available-=n;},settled:()=>{}};
        const command={protocol:2 as const,attemptId:s.command.attemptId,batchId:'c954385d-7ab0-4939-a233-1d7e784bd526',project:s.command.project,deadline:Date.now()+20000,pixels:[{gridX:999,gridY:1001,color:0}]};
        const grant={id:command.batchId,digest:'a'.repeat(64),expires:Date.now()+60000,project:command.project,writes:[],execution:'continuous',budgets:{pixels:100,energy:100},region:{x:0,y:0,width:2,height:2}};
        return {...s,command,grant,setAvailable:(n:number)=>{available=n;}};
    }
    it('sends a dynamically chosen exact template color inside the approved rectangle',async()=>{
        const s=await continuous();expect(await s.writer.executeBatch(s.command,s.allowed,s.grant)).toBe('confirmed');expect(s.fetch).toHaveBeenCalledTimes(1);
        expect(await s.writer.executeBatch({...s.command,attemptId:'b6a44c06-1c32-40d6-9c68-c885d44e0cd1'},s.allowed,s.grant)).toBe('not-sent');
    });
    it.each(['outside','wrong-color','budget','duration','field'])('rejects altered continuous authority: %s',async kind=>{
        const s=await continuous();
        if(kind==='outside')s.command.pixels[0]!.gridX=1001;
        if(kind==='wrong-color')s.command.pixels[0]!.color=1;
        if(kind==='budget')s.grant.budgets.energy=1001;
        if(kind==='duration')s.grant.expires=Date.now()+600001;
        if(kind==='field')Object.assign(s.grant,{endpoint:'https://example.invalid'});
        expect(await s.writer.executeBatch(s.command,s.allowed,s.grant)).toBe('not-sent');expect(s.fetch).not.toHaveBeenCalled();
    });
    it('waits without sending when no proven energy is available, then accepts new evidence',async()=>{
        const s=await continuous();s.setAvailable(0);expect(await s.writer.executeBatch(s.command,s.allowed,s.grant)).toBe('waiting-resources');expect(s.fetch).not.toHaveBeenCalled();
        s.setAvailable(1);expect(await s.writer.executeBatch(s.command,s.allowed,s.grant)).toBe('confirmed');
    });
    it('checks energy again after the asynchronous channel check',async()=>{
        const s=await continuous();expect(await s.writer.executeBatch(s.command,async()=>{s.setAvailable(0);return true;},s.grant)).toBe('waiting-resources');expect(s.fetch).not.toHaveBeenCalled();
    });
});
