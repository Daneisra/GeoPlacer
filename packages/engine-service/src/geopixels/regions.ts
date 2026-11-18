import { MAX_MODEL_PIXELS } from './capacity.js';
import { check, integer } from './protocol.js';

export interface ImageRegion {
    readonly id: string;
    readonly name: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly priority: 'primary' | 'secondary';
    readonly enabled: boolean;
}
export interface CaptureRegion {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly revision: number;
}
export const MAX_REGIONS = 16;
export const MAX_PROJECT_SIDE = MAX_MODEL_PIXELS;
export const OBSERVATION_CACHE_BYTES = MAX_MODEL_PIXELS * 20;
export function parseRegions(value: unknown, width: number, height: number): ImageRegion[] {
    check(Array.isArray(value) && value.length <= MAX_REGIONS, 'at most 16 observation regions');
    const ids = new Set<string>();
    let area = 0;
    const fields = ['id', 'name', 'x', 'y', 'width', 'height', 'priority', 'enabled'];
    for (const v of value as ImageRegion[]) {
        check(
            v &&
                typeof v === 'object' &&
                Object.keys(v).length === fields.length &&
                Object.keys(v).every((k) => fields.includes(k)),
            'invalid region fields'
        );
        check(
            typeof v.id === 'string' &&
                /^[a-z][a-z0-9_-]{0,31}$/.test(v.id) &&
                v.id !== 'whole-model' &&
                !ids.has(v.id),
            'invalid or duplicate region id'
        );
        ids.add(v.id);
        check(typeof v.name === 'string' && v.name.trim().length > 0 && v.name.length <= 60, 'invalid region name');
        check(
            integer(v.x, 0, width - 1) &&
                integer(v.y, 0, height - 1) &&
                integer(v.width, 1, width - v.x) &&
                integer(v.height, 1, height - v.y),
            'region outside the bound image'
        );
        check(
            ['primary', 'secondary'].includes(v.priority) && typeof v.enabled === 'boolean',
            'invalid region priority or suspension'
        );
        area += v.width * v.height;
    }
    check(area <= MAX_MODEL_PIXELS, 'combined region area exceeds the configured observation memory budget');
    return structuredClone(value) as ImageRegion[];
}

/** Smooth weighted fairness in capture count, independent of the painting scheduler. */
export function chooseRegion(regions: readonly ImageRegion[], served: ReadonlyMap<string, number>): ImageRegion | null {
    let selected: ImageRegion | null = null,
        score = Infinity;
    for (const r of regions) {
        if (!r.enabled) continue;
        const next = ((served.get(r.id) ?? 0) + 1) / (r.priority === 'primary' ? 3 : 1);
        if (next < score) {
            score = next;
            selected = r;
        }
    }
    return selected;
}
