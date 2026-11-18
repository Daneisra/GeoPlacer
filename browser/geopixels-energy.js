/* Passive tap of the public sync-worker contract (GeoPixelsFront 8367389).
 * No request is initiated. No session field is copied to loopback.
 * currentEnergy may LOWER a balance, never prove clock-based regeneration.
 */
const GeoPlacerEnergy = (() => {
    let worker = null,
        original = null,
        wrapped = null,
        pending = null,
        evidence = null;
    let sequence = 0,
        spent = 0,
        ceiling = 0,
        writing = false,
        settledAt = 0,
        evidenceUser = null;
    function clear() {
        pending = null;
        evidence = null;
        spent = 0;
        ceiling = 0;
    }
    function account() {
        return typeof userID === 'number' ? userID : null;
    }
    function colors(raw) {
        const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.length <= 4096 ? raw.split(',') : null;
        if (!list || list.length > 256) return null;
        const values = list.map((v) => (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v));
        return values.every((v) => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffff) ? [...new Set(values)] : null;
    }
    function receive(event) {
        const r = event.data;
        if (!r || !Object.hasOwn(r, 'ok')) return;
        const request = pending;
        pending = null;
        if (
            !request ||
            request.ambiguous ||
            !r.ok ||
            writing ||
            request.at <= settledAt ||
            request.user !== account() ||
            Date.now() - request.at > 30000
        )
            return;
        const raw = r.userData,
            owned = colors(raw?.colors);
        if (!raw || !Number.isSafeInteger(raw.energy) || raw.energy < 0 || raw.energy > 1e9 || !owned) return;
        evidence = {
            source: 'native-worker-response',
            sequence: ++sequence,
            requestStartedAt: request.at,
            capturedAt: Date.now(),
            energy: raw.energy,
            colors: owned,
        };
        evidenceUser = request.user;
        spent = 0;
        ceiling = raw.energy;
    }
    function attach() {
        const next = typeof syncWorker === 'object' && syncWorker ? syncWorker : null;
        if (next === worker && worker?.postMessage === wrapped) return !!worker;
        if (worker) {
            worker.removeEventListener('message', receive);
            if (worker.postMessage === wrapped) worker.postMessage = original;
        }
        worker = null;
        clear();
        if (!next || typeof next.addEventListener !== 'function' || typeof next.postMessage !== 'function')
            return false;
        original = next.postMessage;
        wrapped = function (...args) {
            // The sensitive arguments are forwarded unchanged, never retained or serialized.
            if (args[0]?.type === 'sync-delta') {
                pending = { at: Date.now(), user: account(), ambiguous: !!pending };
            }
            return Reflect.apply(original, this, args);
        };
        try {
            next.postMessage = wrapped;
            if (next.postMessage !== wrapped) return false;
            next.addEventListener('message', receive);
            worker = next;
            return true;
        } catch {
            return false;
        }
    }
    function snapshot() {
        if (evidence && account() !== evidenceUser) clear();
        if (!attach() || !evidence || writing || Date.now() - evidence.capturedAt > 30000) return null;
        const counter =
            typeof currentEnergy === 'number' && Number.isFinite(currentEnergy)
                ? Math.max(0, Math.floor(currentEnergy))
                : 0;
        ceiling = Math.min(ceiling, counter, Math.max(0, evidence.energy - spent));
        return { ...evidence, colors: [...evidence.colors], available: ceiling };
    }
    return {
        snapshot,
        inspect() {
            const r = snapshot();
            return !worker
                ? 'Énergie : interface sync-worker indisponible ; aucun crédit de recharge.'
                : r
                  ? `Énergie : réponse native n° ${r.sequence}, solde conservateur ${r.available}, reçue il y a ${Math.floor((Date.now() - r.capturedAt) / 1000)} s.`
                  : 'Énergie : attente d’une réponse native exploitable, aucun crédit de recharge.';
        },
        spend(n) {
            writing = true;
            spent += n;
            ceiling = Math.max(0, ceiling - n);
        },
        settled() {
            writing = false;
            settledAt = Date.now();
            pending = null;
        },
    };
})();
