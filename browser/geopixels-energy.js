/* Native resource evidence: passive tap of the public sync-worker contract (GeoPixelsFront 8367389).
 * Optional fixed GetUserData refresh only during explicitly authorized work; no tile fetch. No session field is copied to loopback.
 * A fresh response can supply the checkpoint used by GeoPixels to compute recharge.
 * The page counter caps that calculation and never supplies evidence by itself.
 */
const GeoPlacerEnergy = (() => {
    let worker = null,
        original = null,
        wrapped = null,
        pending = null,
        evidence = null;
    let refreshing=false,lastRefresh=0,direct=false;
    let checkpoint = null, rawEnergy = null;
    let sequence = 0,
        spent = 0,
        ceiling = 0,
        writing = false,
        settledAt = 0,
        evidenceUser = null;
    function clear() {
        pending = null;
        evidence = null;
        checkpoint = null;
        rawEnergy = null;
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
        if (typeof GeoPlacerTiles !== 'undefined' && request && !request.ambiguous) GeoPlacerTiles.receive(r, request.tiles, Date.now());
        if (r.ok) record(r.userData, request);
    }
    function record(raw, request) {
        if (
            !request ||
            request.ambiguous ||
            writing ||
            request.at <= settledAt ||
            request.user !== account() ||
            Date.now() - request.at > 30000 ||
            (evidence && request.at < evidence.requestStartedAt)
        )
            return;
        const owned = colors(raw?.colors);
        if (!raw || !Number.isSafeInteger(raw.energy) || raw.energy < 0 || raw.energy > 1e9 || !owned) return;
        const now = typeof serverNow === 'function' ? serverNow() : Math.floor(Date.now() / 1000);
        const validCheckpoint = Number.isSafeInteger(now) && Number.isSafeInteger(raw.checkedTick) &&
            raw.checkedTick > 0 && raw.checkedTick <= now && Number.isSafeInteger(raw.maxEnergy) && raw.maxEnergy >= 1 &&
            raw.maxEnergy <= 1e9 && Number.isSafeInteger(raw.energyRate) && raw.energyRate >= 15 && raw.energyRate <= 86400;
        if (checkpoint !== null && (!validCheckpoint || raw.checkedTick < checkpoint)) return;
        const energy = validCheckpoint && raw.energy < raw.maxEnergy
            ? Math.min(raw.maxEnergy, raw.energy + Math.floor((now - raw.checkedTick) / raw.energyRate))
            : raw.energy;
        // Rereading the same checkpoint must not credit locally reserved energy a second time.
        if (checkpoint === null || raw.checkedTick > checkpoint) spent = 0;
        checkpoint = validCheckpoint ? raw.checkedTick : null;
        rawEnergy = raw.energy;
        evidence = {
            source: request.direct?'native-user-response':'native-worker-response',
            sequence: ++sequence,
            requestStartedAt: request.at,
            capturedAt: Date.now(),
            energy,
            colors: owned,
            ...(typeof GeoPlacerShop!=='undefined' && GeoPlacerShop.catalog() && Number.isSafeInteger(raw.pixels) && raw.pixels>=0 && Number.isSafeInteger(raw.maxEnergy) && raw.maxEnergy>0 && Number.isSafeInteger(raw.energyRate) && raw.energyRate>=15 ? {shop:{catalog:GeoPlacerShop.catalog(),currency:Math.floor(raw.pixels/5),capacity:raw.maxEnergy,intervalMs:raw.energyRate*1000,colorPrice:GeoPlacerShop.colorPrice?.(owned)??null}} : {}),
        };
        direct=!!request.direct && energy === raw.energy;
        evidenceUser = request.user;
        ceiling = Math.max(0, energy - spent);
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
                pending = { at: Date.now(), user: account(), ambiguous: !!pending, tiles: typeof GeoPlacerTiles!=='undefined'?GeoPlacerTiles.request(args[0]):[] };
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
            direct ? evidence.energy : typeof currentEnergy === 'number' && Number.isFinite(currentEnergy) ? Math.max(0, Math.floor(currentEnergy)) : 0;
        ceiling = Math.min(ceiling, counter, Math.max(0, evidence.energy - spent));
        return { ...evidence, colors: [...evidence.colors], available: ceiling };
    }
    return {
        snapshot,
        async refresh(authorized) {
            if(!authorized || refreshing || writing || Date.now()-lastRefresh<10000 || typeof tokenUser!=='string' || !tokenUser || typeof userID!=='number')return;
            attach();refreshing=true;lastRefresh=Date.now();const at=Date.now(),user=account();
            const c=new AbortController(),timer=setTimeout(()=>c.abort(),5000);
            try {const response=await fetch('/GetUserData',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:userID,token:tokenUser}),signal:c.signal});
                if(!response.ok || writing || user!==account() || at<=settledAt)return;
                const raw=await response.json();
                record(raw,{at,user,direct:true});
            }catch { /* Missing resource proof never credits energy. */ }
            finally{clearTimeout(timer);refreshing=false;}
        },
        inspect() {
            const r = snapshot();
            return !worker
                ? 'Énergie : interface sync-worker indisponible ; aucun crédit de recharge.'
                : r
                  ? `Énergie : réponse native n° ${r.sequence}, solde brut ${rawEnergy}, solde exploitable ${r.available}, reçue il y a ${Math.floor((Date.now() - r.capturedAt) / 1000)} s.`
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
