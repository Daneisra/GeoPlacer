import {
    createResourceManager,
    evaluateUpgradePolicy,
    type AgentId,
    type Rgb,
    type ResourceRules,
    type ProgressSnapshot,
    type UpgradeKind,
} from '@geoplacer/core';
import { check } from './protocol.js';

/** Public shop contract: GeoPixelsFront@74783af, index.html + userProfile.js.
 * Prices are DISPLAYED game currency (raw userData.pixels / 5), never money. */
export const SHOP_CATALOG = 'geopixels-shop-74783af-v1';
export const UPGRADE_KINDS = ['energy-pack', 'max-energy', 'regen-speed', 'color-unlock'] as const;
export type AutomaticUpgradePolicy = {
    maxBudget: number;
    minimumReserve: number;
    targetCapacity: number;
    energyBelow: number;
    priority: UpgradeKind[];
};
export type ShopObservation = {
    catalog: string;
    currency: number;
    capacity: number;
    intervalMs: number;
    colorPrice?: 0 | 100 | null;
};
export function validateUpgradePolicy(v: unknown): asserts v is AutomaticUpgradePolicy {
    const p = v as AutomaticUpgradePolicy;
    check(
        !!p &&
            Object.keys(p).length === 5 &&
            ['maxBudget', 'minimumReserve', 'targetCapacity', 'energyBelow'].every(
                (k) =>
                    Number.isSafeInteger(p[k as keyof typeof p]) &&
                    (p[k as keyof typeof p] as number) >= 0 &&
                    (p[k as keyof typeof p] as number) <= 1e9
            ) &&
            Array.isArray(p.priority) &&
            p.priority.length <= 4 &&
            new Set(p.priority).size === p.priority.length &&
            p.priority.every((k) => UPGRADE_KINDS.includes(k)),
        'invalid automatic upgrade policy'
    );
}
export function upgradeProposals(
    shop: ShopObservation,
    energy: number,
    colors: number[],
    required: number[],
    policy: AutomaticUpgradePolicy,
    spent: number,
    progress: ProgressSnapshot,
    now: number
) {
    validateUpgradePolicy(policy);
    check(shop.catalog === SHOP_CATALOG && shop.capacity > 0 && shop.intervalMs >= 15000, 'unverified shop');
    const rules: ResourceRules = {
        schemaVersion: 1,
        id: SHOP_CATALOG,
        version: 1,
        energy: {
            costPerPixel: 1,
            baseCapacity: shop.capacity,
            regenAmount: 1,
            regenIntervalMs: shop.intervalMs,
            aboveCapacity: 'keep',
        },
        palette: {
            initialColors: colors as Rgb[],
            unlockable:
                shop.colorPrice == null
                    ? []
                    : required
                          .filter((c) => !colors.includes(c))
                          .map((c) => ({ color: c as Rgb, cost: shop.colorPrice! })),
        },
        upgrades: {
            maxEnergy: [{ cost: 50, capacityBonus: 5 }],
            ...(shop.intervalMs > 15000
                ? { regenSpeed: [{ cost: 500, regenIntervalMs: shop.intervalMs - 1000 }] }
                : {}),
            energyPack: { cost: 10, energy: 20, maxPurchases: 1 },
        },
        currency: {},
    };
    const agent = 'geopixels-upgrades' as AgentId,
        manager = createResourceManager(rules);
    const state = manager.observe({
        type: 'resource-observation',
        agent,
        observedAt: now,
        energy,
        currency: shop.currency,
        unlockedColors: colors as Rgb[],
        upgrades: { maxEnergy: 0, regenSpeed: 0, energyPacks: 0 },
        availability: { status: 'available' },
    }).state;
    return evaluateUpgradePolicy(
        {
            agent,
            agents: [{ id: agent, state }],
            progress,
            parameters: { rules, msPerPixel: 1, minCoveragePercent: 0 },
            now,
        },
        {
            ...policy,
            requiredColors: required as Rgb[],
            enabled: Object.fromEntries(
                UPGRADE_KINDS.map((k) => [
                    k,
                    policy.priority.includes(k) && (k !== 'energy-pack' || energy < policy.energyBelow),
                ])
            ) as Record<UpgradeKind, boolean>,
        },
        spent
    );
}
