/* Passive provenance of native sync-worker responses. Cursors are opaque, never dates.
 * No requests, no auth fields, and no claim that the server's underlying canvas is current. */
const GeoPlacerTiles = (() => {
    const proofs = new Map();
    let source = null,
        merge = null,
        original = null,
        wrapped = null;
    const jobs = new Map(),
        blocked = new Set();
    function merged(event) {
        const r = event.data,
            list = jobs.get(r?.tileKey);
        if (!list) return;
        const job = list.shift();
        if (!list.length) jobs.delete(r.tileKey);
        const entry = cache()?.get(r.tileKey);
        if (
            job?.at &&
            !job.ambiguous &&
            r.colorBitmap &&
            entry?.colorBitmap === r.colorBitmap &&
            entry.timestamp === job.cursor
        )
            proofs.set(r.tileKey, { bitmap: r.colorBitmap, cursor: job.cursor, at: job.at, state: 'native-updated' });
        else proofs.delete(r.tileKey);
    }
    function attachMerge() {
        const next = typeof mergeWorker === 'object' && mergeWorker ? mergeWorker : null;
        if (next === merge && next?.postMessage === wrapped) return;
        if (merge) {
            merge.removeEventListener('message', merged);
            if (merge.postMessage === wrapped) merge.postMessage = original;
        }
        jobs.clear();
        blocked.clear();
        merge = null;
        if (!next || typeof next.addEventListener !== 'function' || typeof next.postMessage !== 'function') return;
        original = next.postMessage;
        wrapped = function (...args) {
            const key = args[0]?.tileKey;
            if (typeof key === 'string' && !blocked.has(key) && /^-?\d{1,10},-?\d{1,10}$/.test(key)) {
                const list = jobs.get(key) ?? [],
                    job = { cursor: cache()?.get(key)?.timestamp, at: null, ambiguous: list.length > 0 };
                for (const old of list) old.ambiguous = true;
                if (list.length >= 16) {
                    jobs.delete(key);
                    blocked.add(key);
                } else {
                    list.push(job);
                    jobs.set(key, list);
                }
                while (jobs.size > 256) {
                    const oldest = jobs.keys().next().value;
                    jobs.delete(oldest);
                    blocked.add(oldest);
                }
                if (blocked.size > 512) {
                    jobs.clear();
                    blocked.clear();
                    merge.removeEventListener('message', merged);
                    if (merge.postMessage === wrapped) merge.postMessage = original;
                    merge = null;
                }
            }
            return Reflect.apply(original, this, args);
        };
        try {
            next.postMessage = wrapped;
            if (next.postMessage !== wrapped) return;
            next.addEventListener('message', merged);
            merge = next;
        } catch {
            /* Unverifiable merges remain cache-only. */
        }
    }
    function cache() {
        return typeof tileImageCache === 'object' ? tileImageCache : null;
    }
    function request(message) {
        attachMerge();
        const c = cache();
        if (c !== source) {
            proofs.clear();
            source = c;
        }
        return Array.isArray(message?.tiles) && message.tiles.length <= 256
            ? message.tiles.map((t) => {
                  const key = `${t.x},${t.y}`,
                      entry = c?.get(key);
                  return { key, cursor: entry?.timestamp, bitmap: entry?.colorBitmap };
              })
            : [];
    }
    function receive(data, requested, at) {
        if (!data?.ok || !data.processedTiles || !Array.isArray(requested)) return;
        for (const old of requested) {
            const r = data.processedTiles['tile_' + old.key.replace(',', '_')];
            if (!r) continue;
            const deltas = Array.isArray(r.deltas) ? r.deltas.length : -1;
            // Only a single correlated native merge may establish an update receipt.
            if (r.type === 'full' && deltas === 0 && r.colorBitmap)
                proofs.set(old.key, { bitmap: r.colorBitmap, cursor: r.timestamp, at, state: 'native-updated' });
            else if (r.type === 'delta' && deltas === 0 && old.bitmap)
                proofs.set(old.key, { bitmap: old.bitmap, cursor: old.cursor, at, state: 'native-checked' });
            else {
                proofs.delete(old.key);
                const list = jobs.get(old.key);
                if (deltas > 0 && list?.length === 1 && !list[0].ambiguous && list[0].cursor === r.timestamp)
                    list[0].at = at;
            }
        }
        while (proofs.size > 256) proofs.delete(proofs.keys().next().value);
    }
    function inspect(rect) {
        const c = cache(),
            result = [];
        if (c !== source) {
            proofs.clear();
            source = c;
        }
        for (let y = Math.floor(rect.y / 1000) * 1000; y < rect.y + rect.height; y += 1000)
            for (let x = Math.floor(rect.x / 1000) * 1000; x < rect.x + rect.width; x += 1000) {
                const key = `${x},${y}`,
                    e = c?.get(key),
                    p = proofs.get(key);
                const valid = p && p.bitmap === e?.colorBitmap && p.cursor === e?.timestamp;
                result.push({
                    key,
                    state: !e?.colorBitmap ? 'missing' : valid ? p.state : 'cache-only',
                    nativeReceivedAt: valid ? p.at : null,
                });
            }
        return result;
    }
    function coverage(project) {
        const keys = [];
        let complete = true;
        for (const [key, entry] of cache() ?? []) {
            const parts = key.split(',').map(Number),
                [x, y] = parts;
            if (
                parts.length !== 2 ||
                !parts.every(Number.isSafeInteger) ||
                x % 1000 ||
                y % 1000 ||
                !entry?.colorBitmap?.width ||
                !entry.colorBitmap.height
            )
                continue;
            if (
                x >= project.gridX + project.width ||
                x + 1000 <= project.gridX ||
                y > project.gridY ||
                y + 1000 <= project.gridY - project.height + 1
            )
                continue;
            if (keys.length === 128) {
                complete = false;
                break;
            }
            keys.push(key);
        }
        return { keys, complete }; // Presence only: never a source date or a promise of full pixel readability.
    }
    return { request, receive, inspect, coverage };
})();
