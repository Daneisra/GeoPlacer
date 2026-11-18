import { afterEach, describe, expect, it, vi } from 'vitest';
import { asTemplateId, computeProgress, createArraySnapshot } from '@geoplacer/core';
import { AutomaticUpgrades } from '../src/geopixels/automatic-upgrades.js';
import { SHOP_CATALOG, upgradeProposals, validateUpgradePolicy } from '../src/geopixels/upgrade-policy.js';
import type { WriterResources } from '../src/geopixels/writer-resources.js';
const progress = computeProgress(
    {
        id: asTemplateId('shop-test'),
        revision: 1,
        image: { width: 1, height: 1, pixels: Uint32Array.of(0) },
        placement: { topLeft: { x: 0, y: 0 } },
        coordinateSystem: { yAxis: 'down' },
    },
    createArraySnapshot({
        rect: { minX: 0, minY: 0, width: 1, height: 1 },
        coordinateSystem: { yAxis: 'down' },
        source: 'geopixels-fixture',
        observedAt: 100000,
        pixels: Int32Array.of(-1),
    }),
    100000
);
const policy = {
    maxBudget: 20,
    minimumReserve: 50,
    targetCapacity: 110,
    energyBelow: 5,
    priority: ['energy-pack', 'max-energy', 'regen-speed', 'color-unlock'] as const,
};
async function fixture() {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    let authorized = true,
        saved: unknown = null;
    let frame: WriterResources = {
        source: 'native-worker-response',
        sequence: 1,
        requestStartedAt: 99999,
        capturedAt: 100000,
        energy: 0,
        available: 0,
        colors: [0],
        shop: { catalog: SHOP_CATALOG, currency: 100, capacity: 100, intervalMs: 20000 },
    };
    const active = () =>
        authorized
            ? {
                  job: 'job-1',
                  project: {
                      id: 'p',
                      generation: 'g',
                      width: 1,
                      height: 1,
                      gridX: 0,
                      gridY: 0,
                      layer: 'base' as const,
                  },
                  policy: { ...policy, priority: [...policy.priority] },
              }
            : null;
    const lock = vi.fn(async () => true),
        unlock = vi.fn(),
        save = vi.fn(async (v: unknown) => {
            saved = structuredClone(v);
        });
    const deps = {
        save,
        active,
        resources: () => frame,
        lock,
        unlock,
        progress: async () => ({ progress, colors: [0, 1] }),
    };
    const actor = new AutomaticUpgrades(deps);
    return {
        actor,
        deps,
        lock,
        unlock,
        save,
        saved: () => saved,
        revoke: () => {
            authorized = false;
        },
        next: (patch: Partial<WriterResources>) => {
            vi.setSystemTime(Date.now() + 10);
            frame = {
                ...frame,
                ...patch,
                requestStartedAt: Date.now() - 1,
                capturedAt: Date.now(),
                sequence: frame.sequence + 1,
            };
            return frame;
        },
    };
}
afterEach(() => vi.useRealTimers());
describe('Opt-in purchases over existing ResourceManager and UpgradePlanner', () => {
    it('enforces budget, reserve, target, required colors and regeneration floor', () => {
        const shop = { catalog: SHOP_CATALOG, currency: 1000, capacity: 100, intervalMs: 15000 };
        const results = upgradeProposals(
            shop,
            0,
            [0],
            [0, 1],
            { ...policy, priority: [...policy.priority] },
            0,
            progress,
            100000
        );
        expect(results.find((p) => p.proposal.kind === 'energy-pack')).toMatchObject({
            allowed: true,
            proposal: { cost: 10, effects: { energy: { after: 20 } } },
        });
        expect(results.find((p) => p.proposal.kind === 'max-energy')?.allowed).toBe(false);
        expect(results.find((p) => p.proposal.kind === 'regen-speed')?.allowed).toBe(false);
        expect(
            upgradeProposals(
                shop,
                5,
                [0],
                [0],
                { ...policy, priority: [...policy.priority] },
                20,
                progress,
                100000
            ).every((p) => !p.allowed)
        ).toBe(true);
        expect(() => validateUpgradePolicy({ ...policy, priority: ['energy-pack', 'energy-pack'] })).toThrow();
        expect(() => validateUpgradePolicy({ ...policy, maxBudget: -1 })).toThrow();
        expect(() =>
            upgradeProposals(
                { ...shop, catalog: 'unknown' },
                0,
                [0],
                [0],
                { ...policy, priority: [...policy.priority] },
                0,
                progress,
                100000
            )
        ).toThrow();
    });
    it('uses a verified free-color price, never guesses it when unavailable',()=>{
        const shop={catalog:SHOP_CATALOG,currency:100,capacity:100,intervalMs:15000};
        const p={...policy,maxBudget:0,priority:['color-unlock' as const]};
        expect(upgradeProposals({...shop,colorPrice:0},0,[0],[1],p,0,progress,100000).find(r=>r.proposal.kind==='color-unlock')).toMatchObject({allowed:true,proposal:{cost:0,color:1}});
        expect(upgradeProposals(shop,0,[0],[1],p,0,progress,100000).some(r=>r.allowed)).toBe(false);
    });
    it('persists intent before delivery, never redelivers, verifies actual debit and effect before the next purchase', async () => {
        const f = await fixture();
        await f.actor.tick();
        expect(f.save).toHaveBeenCalled();
        const c = await f.actor.claim();
        expect(c).toMatchObject({ kind: 'energy-pack', cost: 10 });
        expect(await f.actor.claim()).toBeNull();
        expect(f.actor.allowed(c!.id)).toBe(true);
        await f.actor.result(c!.id, 'accepted');
        await f.actor.tick();
        expect(f.actor.view().history[0]!.state).toBe('accepted');
        f.next({
            energy: 20,
            available: 20,
            shop: { catalog: SHOP_CATALOG, currency: 90, capacity: 100, intervalMs: 20000 },
        });
        await f.actor.tick();
        expect(f.actor.view().history[0]!.state).toBe('verified');
        expect(f.unlock).toHaveBeenCalledOnce();
        expect(JSON.stringify(f.saved())).not.toMatch(/Token|Subject|cookie/);
    });
    it.each(['lost', 'restart', 'revoke', 'wrong-effect', 'wrong-debit'])(
        'blocks uncertain purchases without retry: %s',
        async (kind) => {
            const f = await fixture();
            await f.actor.tick();
            const c = await f.actor.claim();
            if (kind === 'restart') {
                const restarted = new AutomaticUpgrades(f.deps);
                await restarted.open(f.saved());
                await restarted.tick();
                expect(restarted.view().uncertain).toBe(1);
                expect(await restarted.claim()).toBeNull();
                return;
            }
            if (kind === 'lost') {
                vi.setSystemTime(Date.now() + 30001);
            } else if (kind === 'revoke') f.revoke();
            else {
                await f.actor.result(c!.id, 'accepted');
                f.next({
                    energy: kind === 'wrong-effect' ? 0 : 20,
                    available: 20,
                    shop: {
                        catalog: SHOP_CATALOG,
                        currency: kind === 'wrong-debit' ? 89 : 90,
                        capacity: 100,
                        intervalMs: 20000,
                    },
                });
            }
            await f.actor.tick();
            expect(f.actor.view().uncertain).toBe(1);
            expect(await f.actor.claim()).toBeNull();
            await f.actor.tick();
            expect(f.actor.view().history).toHaveLength(1);
        }
    );
    it('refuses to create an intent when durable storage fails', async () => {
        const f = await fixture(),
            a = new AutomaticUpgrades({
                ...f.deps,
                save: async () => {
                    throw new Error('disk');
                },
            });
        await expect(a.tick()).rejects.toThrow('disk');
        expect(await a.claim()).toBeNull();
        expect(f.unlock).toHaveBeenCalledOnce();
    });
    it('cancels an unclaimed intent on pause/revocation without spending', async () => {
        const f = await fixture();
        await f.actor.tick();
        f.revoke();
        await f.actor.tick();
        expect(f.actor.view().history[0]!.state).toBe('cancelled');
        expect(await f.actor.claim()).toBeNull();
    });
});
