/** Sanitized evidence of an existing native worker response. No site session fields. */
export type WriterResources = {
    source: 'native-worker-response' | 'native-user-response';
    sequence: number;
    requestStartedAt: number;
    capturedAt: number;
    energy: number;
    available: number;
    colors: number[];
    capacity?: number;
    shop?: import('./upgrade-policy.js').ShopObservation;
};

export type AccountPaletteSample = Pick<WriterResources, 'source' | 'capturedAt' | 'colors'>;

export function validAccountPaletteSample(value: unknown): value is AccountPaletteSample {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const sample = value as AccountPaletteSample;
    return Object.keys(sample).length === 3 && validPaletteFields(sample);
}

function validPaletteFields(sample: AccountPaletteSample) {
    return (sample.source === 'native-worker-response' || sample.source === 'native-user-response') &&
        Number.isSafeInteger(sample.capturedAt) && sample.capturedAt > 0 && sample.capturedAt <= 8.64e15 &&
        Array.isArray(sample.colors) && sample.colors.length <= 256 &&
        new Set(sample.colors).size === sample.colors.length &&
        sample.colors.every(c => Number.isSafeInteger(c) && c >= 0 && c <= 0xffffff);
}
export function validWriterResources(value: unknown): value is WriterResources {
    const r = value as WriterResources;
    return (
        !!r &&
        typeof r === 'object' &&
        !Array.isArray(r) &&
        Object.keys(r).length === 7 + Number(!!r.shop) + Number(Object.hasOwn(r, 'capacity')) &&
        ['source', 'sequence', 'requestStartedAt', 'capturedAt', 'energy', 'available', 'colors'].every((k) =>
            Object.hasOwn(r, k)
        ) &&
        (!Object.hasOwn(r, 'capacity') || (Number.isSafeInteger(r.capacity) && r.capacity! >= 1 && r.capacity! <= 1e9)) &&
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
        validPaletteFields(r) &&
        [r.sequence, r.requestStartedAt, r.capturedAt, r.energy, r.available].every(Number.isSafeInteger) &&
        r.sequence > 0 &&
        r.requestStartedAt > 0 &&
        r.capturedAt >= r.requestStartedAt &&
        r.energy >= 0 &&
        r.energy <= 1e9 &&
        r.available >= 0 &&
        r.available <= r.energy
    );
}
