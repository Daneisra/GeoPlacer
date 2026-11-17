import {
    assembleProgress,
    computeProgressWithinBounds,
    UNKNOWN,
    TRANSPARENT_U32,
    type CanvasRect,
    type CanvasSnapshot,
    type ProgressSnapshot,
    type Template,
} from '@geoplacer/core';
import type { GeoPixelsProvider } from './provider.js';
import type { ImageRegion } from './regions.js';

// Provider expires each pixel individually. Snapshot-wide freshness would discard mixed-age valid pixels.
const OPTIONS = {};
type Window = Awaited<ReturnType<GeoPixelsProvider['readWindow']>>;
type Entry = {
    stamp: number;
    until: number;
    progress: ProgressSnapshot;
    captureRange: Window['captureRange'];
    sourceRange: Window['sourceRange'];
};

/** Disjoint calculation cells, not drawing tasks or models. Classification stays in core. */
export class RegionalProgressCache {
    private transparent = 0;
    private key = '';
    private image: Template['image'] | null = null;
    private entries = new Map<string, Entry>();
    private pending: Promise<{
        progress: ProgressSnapshot;
        regions: ReturnType<RegionalProgressCache['regionResult']>[];
        recomputedCells: number;
    }> | null = null;
    private regionResult(region: ImageRegion, entry: Entry, now: number, ownCapture: number | null) {
        return {
            ...region,
            progress: entry.progress,
            captureRange: entry.captureRange,
            sourceRange: entry.sourceRange,
            lastOwnCapture: ownCapture,
            ownCaptureExpired: ownCapture !== null && now - ownCapture > 30000,
            coverageKnown: entry.progress.correct + entry.progress.incorrect,
            composite: true as const,
        };
    }
    async compute(template: Template, provider: GeoPixelsProvider, now: number) {
        // A completed band may arrive while a dashboard computation is pending.
        // Wait, then revisit dirty cells instead of annotating history with the older result.
        while (this.pending) await this.pending;
        now = Math.max(now, provider.monitoring.view().at);
        const task = this.computeNow(template, provider, now);
        this.pending = task;
        try {
            return await task;
        } finally {
            if (this.pending === task) this.pending = null;
        }
    }
    private async computeNow(t: Template, p: GeoPixelsProvider, now: number) {
        p.assertBinding(t);
        const key = JSON.stringify([
            t.id,
            t.revision,
            t.placement,
            t.coordinateSystem,
            p.channelEpoch,
            p.status().project,
        ]);
        if (key !== this.key || this.image !== t.image) {
            this.key = key;
            this.image = t.image;
            this.entries.clear();
            this.transparent = 0;
            for (const color of t.image.pixels) if (color === TRANSPARENT_U32) this.transparent++;
        }
        let recomputedCells = 0;
        const calculate = async (rect: CanvasRect, cacheKey: string): Promise<Entry> => {
            const stamp = p.regionStamp(rect),
                old = this.entries.get(cacheKey);
            if (old && old.stamp === stamp && now <= old.until) return old;
            const w = await p.readWindow(rect);
            p.assertBinding(t);
            const coordinateSystem = { yAxis: 'down' as const, bounds: rect };
            // Calculation view of the SAME image/id/revision. Nothing is registered or persisted as a model.
            const snapshot = { ...w.snapshot, coordinateSystem };
            const progress = computeProgressWithinBounds({ ...t, coordinateSystem }, snapshot, now, OPTIONS);
            const entry = {
                stamp,
                until: w.validUntil,
                progress,
                captureRange: w.captureRange,
                sourceRange: w.sourceRange,
            };
            this.entries.set(cacheKey, entry);
            recomputedCells++;
            return entry;
        };
        const colorTotals = new Map<number, number[]>();
        let invalid = 0,
            observedAt = Infinity;
        const bounds = t.coordinateSystem.bounds;
        for (let y = 0; y < t.image.height; y += 256)
            for (let x = 0; x < t.image.width; x += 256) {
                let rect = {
                    minX: t.placement.topLeft.x + x,
                    minY: t.placement.topLeft.y + y,
                    width: Math.min(256, t.image.width - x),
                    height: Math.min(256, t.image.height - y),
                };
                if (bounds) {
                    const rx = Math.max(rect.minX, bounds.minX),
                        ry = Math.max(rect.minY, bounds.minY);
                    const rw = Math.min(rect.minX + rect.width, bounds.minX + bounds.width) - rx,
                        rh = Math.min(rect.minY + rect.height, bounds.minY + bounds.height) - ry;
                    if (rw <= 0 || rh <= 0) continue;
                    rect = { minX: rx, minY: ry, width: rw, height: rh };
                }
                const e = await calculate(rect, `cell:${x}:${y}`);
                invalid += e.progress.invalidObservations;
                if (e.progress.correct + e.progress.incorrect > 0)
                    observedAt = Math.min(observedAt, e.progress.basis.observedAt);
                for (const c of e.progress.byColor) {
                    const counts = colorTotals.get(c.color) ?? [0, 0, 0, 0, 0];
                    counts[0]! += c.total;
                    counts[1]! += c.correct;
                    counts[2]! += c.wrongColor;
                    counts[3]! += c.missing;
                    counts[4]! += c.unknown;
                    colorTotals.set(c.color, counts);
                }
            }
        const source =
            p.status().mode === 'local-fake' ? ('geopixels-fixture' as const) : ('geopixels-observed' as const);
        const snapshot: CanvasSnapshot = {
            rect: {
                minX: t.placement.topLeft.x,
                minY: t.placement.topLeft.y,
                width: t.image.width,
                height: t.image.height,
            },
            coordinateSystem: t.coordinateSystem,
            source,
            observedAt: Number.isFinite(observedAt) ? observedAt : 0,
            get: () => UNKNOWN,
        };
        const colors = [...colorTotals.keys()],
            counters = new Float64Array(colors.length * 5);
        colors.forEach((c, i) => counters.set(colorTotals.get(c)!, i * 5));
        const progress = assembleProgress(t, snapshot, now, OPTIONS, colors, counters, invalid, this.transparent);
        const monitor = p.monitoring.view(),
            regions = [];
        for (const r of monitor.configuredRegions) {
            const rect = {
                minX: t.placement.topLeft.x + r.x,
                minY: t.placement.topLeft.y + r.y,
                width: r.width,
                height: r.height,
            };
            const e = await calculate(rect, 'region:' + r.id + ':' + JSON.stringify(rect));
            const own = [...monitor.history]
                .reverse()
                .find(
                    (h) =>
                        h.regionId === r.id &&
                        h.captureRegion?.x === r.x &&
                        h.captureRegion?.y === r.y &&
                        h.captureRegion?.width === r.width &&
                        h.captureRegion?.height === r.height &&
                        h.projectKey === monitor.lastCapture?.projectKey
                );
            regions.push(this.regionResult(r, e, now, own?.capturedAt ?? null));
        }
        const activeKeys = new Set(
            monitor.configuredRegions.map(
                (r) =>
                    'region:' +
                    r.id +
                    ':' +
                    JSON.stringify({
                        minX: t.placement.topLeft.x + r.x,
                        minY: t.placement.topLeft.y + r.y,
                        width: r.width,
                        height: r.height,
                    })
            )
        );
        for (const k of this.entries.keys()) if (k.startsWith('region:') && !activeKeys.has(k)) this.entries.delete(k);
        p.assertBinding(t);
        return { progress, regions, recomputedCells };
    }
}
