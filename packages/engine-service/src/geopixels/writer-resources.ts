/** Sanitized evidence of an existing native worker response. No site session fields. */
export type WriterResources = {
    source: 'native-worker-response';
    sequence: number;
    requestStartedAt: number;
    capturedAt: number;
    energy: number;
    available: number;
    colors: number[];
};
export function validWriterResources(value: unknown): value is WriterResources {
    const r = value as WriterResources;
    return (
        !!r &&
        typeof r === 'object' &&
        !Array.isArray(r) &&
        Object.keys(r).length === 7 &&
        ['source', 'sequence', 'requestStartedAt', 'capturedAt', 'energy', 'available', 'colors'].every((k) =>
            Object.hasOwn(r, k)
        ) &&
        r.source === 'native-worker-response' &&
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
