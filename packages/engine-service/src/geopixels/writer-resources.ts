/** Sanitized evidence of an existing native worker response. No site session fields. */
export type WriterResources = {
    source: 'native-worker-response' | 'native-user-response';
    sequence: number;
    requestStartedAt: number;
    capturedAt: number;
    energy: number;
    available: number;
    colors: number[];
    shop?: import('./upgrade-policy.js').ShopObservation;
};
export function validWriterResources(value: unknown): value is WriterResources {
    const r = value as WriterResources;
    return (
        !!r &&
        typeof r === 'object' &&
        !Array.isArray(r) &&
        Object.keys(r).length === (r.shop ? 8 : 7) &&
        ['source', 'sequence', 'requestStartedAt', 'capturedAt', 'energy', 'available', 'colors'].every((k) =>
            Object.hasOwn(r, k)
        ) &&
        (!r.shop ||
            (Object.keys(r.shop).length === (Object.hasOwn(r.shop, 'colorPrice') ? 5 : 4) &&
                ['catalog', 'currency', 'capacity', 'intervalMs'].every((k) => Object.hasOwn(r.shop!, k)) &&
                (r.shop.colorPrice == null || r.shop.colorPrice === 0 || r.shop.colorPrice === 100) &&
                r.shop.catalog === 'geopixels-shop-74783af-v1' &&
                [r.shop.currency, r.shop.capacity, r.shop.intervalMs].every(Number.isSafeInteger) &&
                r.shop.currency >= 0 &&
                r.shop.currency <= 1e9 &&
                r.shop.capacity >= 1 &&
                r.shop.capacity <= 1e9 &&
                r.shop.intervalMs >= 15000 &&
                r.shop.intervalMs <= 86400000)) &&
        ['native-worker-response', 'native-user-response'].includes(r.source) &&
        [r.sequence, r.requestStartedAt, r.capturedAt, r.energy, r.available].every(Number.isSafeInteger) &&
        r.sequence > 0 &&
        r.requestStartedAt > 0 &&
        r.capturedAt >= r.requestStartedAt &&
        r.energy >= 0 &&
        r.energy <= 1e9 &&
        r.available >= 0 &&
        r.available <= r.energy &&
        Array.isArray(r.colors) &&
        r.colors.length <= 256 &&
        new Set(r.colors).size === r.colors.length &&
        r.colors.every((c) => Number.isSafeInteger(c) && c >= 0 && c <= 0xffffff)
    );
}
