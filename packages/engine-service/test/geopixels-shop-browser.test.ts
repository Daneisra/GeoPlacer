import { describe, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
async function fixture(status = 200, lost = false) {
    const project = { id: 'model', generation: 'g', width: 1, height: 1, gridX: 1, gridY: 2, layer: 'base' };
    const command = {
        id: webcrypto.randomUUID(),
        job: webcrypto.randomUUID(),
        project,
        kind: 'energy-pack',
        color: null as number|null,
        cost: 10,
        catalog: 'geopixels-shop-74783af-v1',
        deadline: Date.now() + 25000,
        policy: { maxBudget: 10, minimumReserve: 50, targetCapacity: 300, energyBelow: 5, priority: ['energy-pack'] },
    };
    const receipt = new Map<string, string>(),
        calls: { url: string; body: Record<string, unknown> }[] = [];
    const frame = {
        sequence: 1,
        available: 0,
        energy: 0,
        colors: [0],
        shop: { catalog: command.catalog, currency: 100, capacity: 100, intervalMs: 20000 },
    };
    const prices: Record<string, string> = {
        EnergyInput: '10 Pixels / +20 energy',
        EnergyCapacityInput: '50 Pixels / +5 max',
        FasterRechargeInput: '500 Pixels / -1s (cap at 15s)',
        ExtraColorInput: '100 Pixels / Any hex color allowed',
    };
    const context = vm.createContext({
        Date,
        AbortController,
        setTimeout,
        clearTimeout,
        tokenUser: 'browser-only-token',
        subject: 'browser-only-subject',
        userID: 1,
        queuedPixelsObjects: new Map(),
        isPlacingRequestInProgress: false,
        document: {
            getElementById: (id: string) => ({ parentElement: { parentElement: { textContent: prices[id] } } }),
        },
        GeoPlacerEnergy: { snapshot: () => frame, spend: vi.fn(), settled: vi.fn() },
        GeoPlacerPageReader: { project: () => project, unchanged: async () => true },
        sessionStorage: {
            getItem: (k: string) => receipt.get(k) ?? null,
            setItem: (k: string, v: string) => receipt.set(k, v),
        },
        fetch: async (url: string, o: { body: string }) => {
            calls.push({ url, body: JSON.parse(o.body) });
            if (lost) throw new Error('lost');
            return { status };
        },
    });
    vm.runInContext(
        "function MakePurchase(){return '/MakePurchase UserId Subject';}\n" +
            (await readFile(new URL('../../../browser/geopixels-shop.js', import.meta.url), 'utf8')) +
            ';globalThis.api=GeoPlacerShop;',
        context
    );
    return { api: context.api, context, command, calls, frame, prices, receipt };
}
describe('Fixed browser-only in-game shop port', () => {
    it.each([0,100])('verifies the native free-color condition and price %s before an unlock',async(cost)=>{
        const f=await fixture();
        const owned=cost===0?[0]:Array.from({length:34},(_,i)=>i);
        f.context.Colors=[...owned.map(c=>'#'+c.toString(16).padStart(6,'0')),'#00000000'];
        vm.runInContext('function toggleProfile(){return Colors.length < 35;}',f.context);
        expect(f.api.colorPrice(owned)).toBe(cost);
        f.frame.colors=owned;Object.assign(f.frame.shop,{colorPrice:cost});
        f.command.kind='color-unlock';f.command.color=1000;f.command.cost=cost;f.command.policy.maxBudget=100;f.command.policy.minimumReserve=0;f.command.policy.priority=['color-unlock'];
        expect(await f.api.execute(f.command,async()=>true)).toBe('accepted');expect(f.calls[0]!.body).toMatchObject({type:'ExtraColor',amount:1000});
    });
    it('makes exactly one native request, keeps credentials in-browser, cannot resend a receipt or exceed budget', async () => {
        const f = await fixture();
        expect(await f.api.execute(f.command, async () => true)).toBe('accepted');
        expect(f.calls).toEqual([
            {
                url: '/MakePurchase',
                body: {
                    Token: 'browser-only-token',
                    Subject: 'browser-only-subject',
                    UserId: 1,
                    type: 'Energy',
                    amount: 1,
                },
            },
        ]);
        expect(await f.api.execute(f.command, async () => true)).toBe('not-sent');
        expect(await f.api.execute({ ...f.command, id: webcrypto.randomUUID() }, async () => true)).toBe('not-sent');
        expect(f.calls).toHaveLength(1);
        expect(JSON.stringify([...f.receipt])).not.toMatch(/token|subject/i);
    });
    it.each(['price', 'reserve', 'budget', 'revoked', 'model', 'queue', 'currency-type', 'real-money'])(
        'refuses before fetch: %s',
        async (which) => {
            const f = await fixture();
            if (which === 'price') f.prices.EnergyInput = '11 Pixels / +20 energy';
            if (which === 'reserve') f.command.policy.minimumReserve = 95;
            if (which === 'budget') f.command.policy.maxBudget = 0;
            if (which === 'model') f.command.project = { ...f.command.project, gridX: 99 };
            if (which === 'queue') f.context.queuedPixelsObjects.set('manual', 1);
            if (which === 'currency-type') f.command.catalog = 'money';
            if (which === 'real-money') f.command.kind = 'BuyMorePixels';
            expect(await f.api.execute(f.command, async () => which !== 'revoked')).toBe('not-sent');
            expect(f.calls).toHaveLength(0);
        }
    );
    it('keeps a missing response uncertain and cannot resend it', async () => {
        const f = await fixture(200, true);
        expect(await f.api.execute(f.command, async () => true)).toBe('uncertain');
        expect(await f.api.execute(f.command, async () => true)).toBe('not-sent');
        expect(f.calls).toHaveLength(1);
    });
});
