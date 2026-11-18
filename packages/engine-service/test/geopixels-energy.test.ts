import { describe, it, expect, vi } from 'vitest';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
async function fixture() {
    let now = 100000;
    const listeners = new Set<(e: { data: unknown }) => void>();
    const original = vi.fn();
    const worker = {
        postMessage: original,
        addEventListener: (_k: string, fn: (e: { data: unknown }) => void) => listeners.add(fn),
        removeEventListener: (_k: string, fn: (e: { data: unknown }) => void) => listeners.delete(fn),
    };
    const context = vm.createContext({ Date: { now: () => now }, syncWorker: worker, userID: 123, currentEnergy: 10 });
    vm.runInContext(
        (await readFile(new URL('../../../browser/geopixels-energy.js', import.meta.url), 'utf8')) +
            ';globalThis.api=GeoPlacerEnergy',
        context
    );
    const api = context.api as {
        snapshot: () => Record<string, unknown> | null;
        spend: (n: number) => void;
        settled: () => void;
    };
    const advance = (ms = 1) => {
        now += ms;
    };
    function request() {
        worker.postMessage({ type: 'sync-delta', userID: 123, tokenUser: 'synthetic-private-browser-value' });
    }
    function reply(energy = 10, extra: object = {}) {
        advance();
        for (const listener of listeners)
            listener({ data: { ok: true, userData: { energy, colors: '0,16777215', ...extra } } });
    }
    api.snapshot();
    return { api, worker, context, request, reply, advance, original, listeners };
}
describe('Passive native resource evidence, no service request or token export', () => {
    it('forwards native arguments unchanged and exports only seven safe fields', async () => {
        const f = await fixture(),
            message = { type: 'sync-delta', userID: 123, tokenUser: 'synthetic-private-browser-value' },
            transfer: unknown[] = [];
        Reflect.apply(f.worker.postMessage, f.worker, [message, transfer]);
        f.reply();
        expect(f.original.mock.calls[0]?.[0]).toBe(message);
        expect(f.original.mock.calls[0]?.[1]).toBe(transfer);
        const result = f.api.snapshot();
        expect(result).toMatchObject({ energy: 10, available: 10, colors: [0, 16777215], sequence: 1 });
        expect(Object.keys(result!).sort()).toEqual(
            ['available', 'capturedAt', 'colors', 'energy', 'requestStartedAt', 'sequence', 'source'].sort()
        );
        expect(JSON.stringify(result)).not.toMatch(/synthetic|token|userID/);
    });
    it('does not manufacture evidence from currentEnergy or unmatched/failed replies', async () => {
        const f = await fixture();
        f.context.currentEnergy = 100;
        expect(f.api.snapshot()).toBeNull();
        f.reply();
        expect(f.api.snapshot()).toBeNull();
        f.request();
        for (const fn of f.listeners) fn({ data: { ok: false } });
        expect(f.api.snapshot()).toBeNull();
    });
    it('deducts spending; clock-based counter growth cannot replenish it', async () => {
        const f = await fixture();
        f.request();
        f.reply();
        f.api.spend(5);
        expect(f.api.snapshot()).toBeNull();
        f.api.settled();
        expect(f.api.snapshot()?.available).toBe(5);
        f.context.currentEnergy = 200;
        f.advance(10000);
        expect(f.api.snapshot()?.available).toBe(5);
        f.context.currentEnergy = 3;
        expect(f.api.snapshot()?.available).toBe(3);
        f.context.currentEnergy = 200;
        expect(f.api.snapshot()?.available).toBe(3);
    });
    it('credits a new native response after a completed write, never an old in-flight request', async () => {
        const f = await fixture();
        f.request();
        f.reply(5);
        f.api.spend(5);
        f.api.settled();
        f.reply(100);
        expect(f.api.snapshot()?.available).toBe(0);
        f.advance();
        f.request();
        f.reply(10);
        expect(f.api.snapshot()).toMatchObject({ energy: 10, available: 10, sequence: 2 });
    });
    it('keeps capture time unchanged across repeated polls and expires after 30 seconds', async () => {
        const f = await fixture();
        f.request();
        f.reply();
        const first = f.api.snapshot();
        f.advance(29000);
        expect(f.api.snapshot()?.capturedAt).toBe(first?.capturedAt);
        f.advance(1001);
        expect(f.api.snapshot()).toBeNull();
    });
    it('drops ambiguous concurrent native requests and replies after account change', async () => {
        const f = await fixture();
        f.request();
        f.request();
        f.reply();
        expect(f.api.snapshot()).toBeNull();
        f.request();
        f.context.userID = 456;
        f.reply();
        expect(f.api.snapshot()).toBeNull();
    });
    it.each([
        { energy: -1 },
        { energy: 1.5 },
        { colors: 'not-a-color' },
        { colors: ['#000000'] },
        { colors: [16777216] },
    ])('fails closed on incompatible resource contract %o', async (extra) => {
        const f = await fixture();
        f.request();
        f.reply(10, extra);
        expect(f.api.snapshot()).toBeNull();
    });
    it('drops previously usable evidence when the page account changes', async () => {
        const f = await fixture();
        f.request();
        f.reply();
        expect(f.api.snapshot()?.available).toBe(10);
        f.context.userID = 456;
        expect(f.api.snapshot()).toBeNull();
    });
    it('detaches an old worker, clears evidence and tolerates unavailable/frozen workers', async () => {
        const f = await fixture();
        f.request();
        f.reply();
        f.context.syncWorker = null;
        expect(f.api.snapshot()).toBeNull();
        expect(f.worker.postMessage).toBe(f.original);
        expect(f.listeners.size).toBe(0);
        f.context.syncWorker = Object.freeze({ ...f.worker });
        expect(f.api.snapshot()).toBeNull();
    });
});
