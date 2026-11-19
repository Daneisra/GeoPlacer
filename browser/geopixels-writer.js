/* Private browser-only writer. Site session values never leave this closure for loopback. */
const GeoPlacerPageWriter = (() => {
    let busy = false,
        dispatched = false,
        controller = null,
        lastReason = null,
        energyCeiling = null,
        energySpent = 0,
        executionSession = null;
    let maxGroupPixels=5;
    const batchTargets = new Set();
    const sessionBudgets = new Map();
    const refuse = (reason) => {
        lastReason = reason;
        return 'not-sent';
    };
    // Login exposes an array; the legacy sync worker exposes a decimal CSV string.
    // Only observed account colors are accepted, never inferred from a preset.
    function ownedColors() {
        if (typeof userData !== 'object' || userData === null) return null;
        const raw = userData.colors;
        const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.length <= 4096 ? raw.split(',') : null;
        if (!list || list.length > 256) return null;
        const parsed = [];
        for (const entry of list) {
            const value = typeof entry === 'string' && /^\d+$/.test(entry.trim()) ? Number(entry.trim()) : entry;
            if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffff) return null;
            parsed.push(value);
        }
        return parsed;
    }
    const exact = (o, keys) =>
        o &&
        typeof o === 'object' &&
        !Array.isArray(o) &&
        Object.keys(o).length === keys.length &&
        keys.every((k) => Object.hasOwn(o, k));
    function valid(c, batch = false) {
        if (c?.protocol === 2)
            return (
                batch &&
                exact(c, ['protocol', 'attemptId', 'project', 'pixels', 'deadline', 'batchId']) &&
                Array.isArray(c.pixels) &&
                c.pixels.length >= 1 &&
                c.pixels.length <= maxGroupPixels &&
                c.pixels.every(
                    (p) =>
                        exact(p, ['gridX', 'gridY', 'color']) &&
                        valid(
                            {
                                protocol: 1,
                                attemptId: c.attemptId,
                                project: c.project,
                                gridX: p.gridX,
                                gridY: p.gridY,
                                color: p.color,
                                deadline: c.deadline,
                                batchId: c.batchId,
                            },
                            true
                        )
                ) &&
                new Set(c.pixels.map((p) => p.gridX + ',' + p.gridY)).size === c.pixels.length
            );
        if (
            !exact(c, [
                'protocol',
                'attemptId',
                'project',
                'gridX',
                'gridY',
                'color',
                'deadline',
                ...(batch ? ['batchId'] : []),
            ]) ||
            c.protocol !== 1 ||
            !/^[a-f0-9-]{36}$/.test(c.attemptId) ||
            ![c.gridX, c.gridY, c.color, c.deadline].every(Number.isSafeInteger) ||
            c.color < 0 ||
            c.color > 0xffffff ||
            c.deadline <= Date.now() ||
            c.deadline > Date.now() + 30000
        )
            return false;
        const p = GeoPlacerPageReader.project();
        return (
            p &&
            exact(c.project, ['id', 'generation', 'width', 'height', 'gridX', 'gridY', 'layer']) &&
            Object.keys(c.project).every((key) => c.project[key] === p[key]) &&
            p.layer === 'base' &&
            c.gridX >= p.gridX &&
            c.gridX < p.gridX + p.width &&
            c.gridY <= p.gridY &&
            c.gridY > p.gridY - p.height
        );
    }
    function continuousGrant(c,g) {
        const r=g.region, autonomous=g.execution==='autonomous';
        return c.protocol === 2 && exact(g,['id','digest','expires','project','writes','execution','budgets','region',...(autonomous?['groupSize', ...(Object.hasOwn(g,'energyReserve') ? ['energyReserve'] : [])]:[])]) &&
            (g.energyReserve === undefined || (autonomous && Number.isSafeInteger(g.energyReserve) && g.energyReserve >= 0 && g.energyReserve <= 1e9)) &&
            g.id === c.batchId && /^[a-f0-9-]{36}$/.test(g.id) && /^[a-f0-9]{64}$/.test(g.digest) &&
            Number.isSafeInteger(g.expires) && g.expires > Date.now() && g.expires <= Date.now()+(autonomous?30000:600000) &&
            exact(g.project,['id','generation','width','height','gridX','gridY','layer']) &&
            Object.keys(g.project).every(k=>g.project[k] === c.project[k]) &&
            Array.isArray(g.writes) && g.writes.length === 0 &&
            exact(g.budgets,['pixels','energy']) && [g.budgets.pixels,g.budgets.energy].every(n=>Number.isSafeInteger(n)&&n>=1&&n<=(autonomous?c.project.width*c.project.height:1000)) &&
            exact(r,['x','y','width','height']) && [r.x,r.y,r.width,r.height].every(Number.isSafeInteger) &&
            r.x>=0 && r.y>=0 && r.width>0 && r.height>0 && r.x+r.width<=c.project.width && r.y+r.height<=c.project.height &&
            (!autonomous || (Number.isInteger(g.groupSize) && g.groupSize>=1 && g.groupSize<=maxGroupPixels && c.pixels.length<=g.groupSize)) &&
            c.pixels.every(p=> {
                const x=p.gridX-c.project.gridX, y=c.project.gridY-p.gridY;
                return x>=r.x && x<r.x+r.width && y>=r.y && y<r.y+r.height && GeoPlacerPageReader.targetColor(x,y)===p.color;
            });
    }
    function validGrant(c, grant) {
        if (['continuous','autonomous'].includes(grant?.execution)) return continuousGrant(c,grant);
        const session = grant?.execution === 'session';
        return (
            exact(grant, [
                'id',
                'digest',
                'expires',
                'project',
                'writes',
                ...(c.protocol === 2 ? ['execution'] : []),
                ...(session ? ['budgets'] : []),
            ]) &&
            (c.protocol !== 2 || ['grouped', 'session'].includes(grant.execution)) &&
            (!session ||
                (c.protocol === 2 &&
                    exact(grant.budgets, ['pixels', 'energy']) &&
                    [grant.budgets.pixels, grant.budgets.energy].every(
                        (n) => Number.isSafeInteger(n) && n >= 1 && n <= 25
                    ))) &&
            /^[a-f0-9-]{36}$/.test(grant.id) &&
            grant.id === c.batchId &&
            /^[a-f0-9]{64}$/.test(grant.digest) &&
            Number.isSafeInteger(grant.expires) &&
            grant.expires > Date.now() &&
            grant.expires <= Date.now() + 120000 &&
            exact(grant.project, ['id', 'generation', 'width', 'height', 'gridX', 'gridY', 'layer']) &&
            Object.keys(grant.project).every((k) => grant.project[k] === c.project[k]) &&
            Array.isArray(grant.writes) &&
            grant.writes.length >= 1 &&
            grant.writes.length <= (session ? Math.min(grant.budgets.pixels, grant.budgets.energy) : 5) &&
            grant.writes.every(
                (w) =>
                    exact(w, ['gridX', 'gridY', 'color']) &&
                    [w.gridX, w.gridY, w.color].every(Number.isSafeInteger) &&
                    w.color >= 0 &&
                    w.color <= 0xffffff &&
                    w.gridX >= c.project.gridX &&
                    w.gridX < c.project.gridX + c.project.width &&
                    w.gridY <= c.project.gridY &&
                    w.gridY > c.project.gridY - c.project.height
            ) &&
            new Set(grant.writes.map((w) => w.gridX + ',' + w.gridY)).size === grant.writes.length &&
            (c.protocol === 2
                ? (session || c.pixels.length === grant.writes.length) &&
                  c.pixels.every((p) =>
                      grant.writes.some((w) => w.gridX === p.gridX && w.gridY === p.gridY && w.color === p.color)
                  )
                : grant.writes.some((w) => w.gridX === c.gridX && w.gridY === c.gridY && w.color === c.color))
        );
    }
    function sessionAllowance(c, grant, commit = false) {
        if (!['session','continuous','autonomous'].includes(grant?.execution)) return true;
        const scope = JSON.stringify([grant.digest, grant.project, grant.writes, grant.budgets, grant.region, grant.groupSize]);
        const prior = sessionBudgets.get(c.batchId);
        if (prior && prior.scope !== scope) return false;
        const spent = (prior?.spent ?? 0) + c.pixels.length;
        if (spent > grant.budgets.energy || spent > grant.budgets.pixels) return false;
        if (commit) sessionBudgets.set(c.batchId, { scope, spent });
        return true;
    }
    function readinessReason(cost = 1, continuous = false) {
        if (
            typeof tokenUser !== 'string' ||
            !tokenUser ||
            typeof subject !== 'string' ||
            !subject ||
            typeof userID !== 'number' ||
            !Number.isSafeInteger(userID) ||
            userID <= 0
        )
            return 'Session de la page indisponible pour le placement. Aucun identifiant à transmettre.';
        if (
            executionSession &&
            (executionSession.user !== userID ||
                executionSession.token !== tokenUser ||
                executionSession.subject !== subject)
        )
            return 'Session de la page modifiée : recharger et refaire le couplage.';
        if (typeof currentEnergy !== 'number' || !Number.isFinite(currentEnergy))
            return 'Énergie de la page indisponible.';
        if (
            (!continuous && currentEnergy < cost) ||
            (!continuous && energyCeiling !== null && Math.min(currentEnergy, energyCeiling - energySpent) < cost)
        )
            return 'Énergie insuffisante pour poursuivre ce lot.';
        if (ownedColors() === null) return 'Format des couleurs du compte non reconnu.';
        if (typeof queuedPixelsObjects === 'undefined' || typeof queuedPixelsObjects.size !== 'number')
            return 'File native GeoPixels indisponible.';
        if (queuedPixelsObjects.size !== 0)
            return 'La file manuelle GeoPixels contient déjà des pixels. Videz-la avant cet essai.';
        if (typeof isPlacingRequestInProgress !== 'boolean') return 'État du placement natif indisponible.';
        if (isPlacingRequestInProgress) return 'Un placement GeoPixels est déjà en cours.';
        return null;
    }
    const api = {
        setLimits(limits){if(!Number.isSafeInteger(limits?.groupMax)||limits.groupMax<1||limits.groupMax>Math.floor((128*1024-4096)/160))throw new Error('Limite de transport invalide');maxGroupPixels=limits.groupMax;},
        executeBatch: (c, allowed, grant) => api.execute(c, allowed, false, grant),
        stop: () => controller?.abort(),
        reason: () => lastReason,
        inspect: () => {
            try {
                return (
                    'Placement : ' +
                    (dispatched
                        ? 'un essai a déjà été envoyé dans cette page.'
                        : busy
                          ? 'essai en cours.'
                          : (readinessReason() ??
                            'contrôles de session et de ressources disponibles ; aucun envoi lancé.'))
                );
            } catch {
                return 'Placement : vérification locale indisponible ; aucun envoi lancé.';
            }
        },
        async execute(c, allowed, trusted, grant) {
            const batch = grant !== undefined;
            lastReason = null;
            if (!['https://geopixels.net', 'https://www.geopixels.net'].includes(location.origin))
                return refuse('Origine de page refusée.');
            if (!batch && !trusted) return refuse('Cliquez vous-même sur le bouton de placement.');
            if (busy) return refuse('Un essai est déjà en cours.');
            if (!batch && dispatched) return refuse('Un essai a déjà été envoyé dans cette page. Aucun second envoi.');
            if (!valid(c, batch))
                return refuse(
                    c?.deadline <= Date.now()
                        ? 'Autorisation expirée : préparez un nouveau pixel.'
                        : 'Commande ou modèle différent de la page observée. Refaites une observation.'
                );
            const pixels = c.protocol === 2 ? c.pixels : [c];
            if (
                batch &&
                (!validGrant(c, grant) ||
                    !sessionAllowance(c, grant) ||
                    pixels.some((p) => batchTargets.has(c.batchId + '/' + p.gridX + ',' + p.gridY + ':' + p.color)))
            )
                return refuse('Pixel hors du lot autorisé ou déjà envoyé.');
            busy = true;
            let sent = false,
                timer;
            try {
                const contract = await GeoPlacerPageReader.contract();
                if (
                    contract.layer !== 'base' ||
                    !['base-only-8367389', 'event-layers-74783af-getter', 'event-layers-74783af-state'].includes(
                        contract.id
                    ) ||
                    !(await GeoPlacerPageReader.unchanged())
                )
                    return refuse('Modèle, position, couche ou session modifié : observer et lier de nouveau.');
                const continuous = ['continuous','autonomous'].includes(grant?.execution);
                const costWithReserve = pixels.length + (grant?.energyReserve ?? 0);
                if (continuous && (GeoPlacerEnergy.snapshot()?.available ?? 0) < costWithReserve) {
                    lastReason = 'En attente d’une nouvelle réponse native confirmant l’énergie disponible.';
                    return 'waiting-resources';
                }
                const reason = readinessReason(pixels.length,continuous);
                if (reason) return refuse(reason);
                if (!pixels.every((p) => (continuous ? GeoPlacerEnergy.snapshot()?.colors ?? [] : ownedColors()).includes(p.color)))
                    return refuse('Cette couleur ne figure pas dans les couleurs du compte.');
                const color = batch ? '' : '#' + c.color.toString(16).padStart(6, '0');
                if (
                    !batch &&
                    !confirm(
                        `ESSAI RÉEL UNIQUE — GeoPixels\nCouche : base\nPixel (${c.gridX}, ${c.gridY})\nCouleur : ${color}\nCoût : 1 énergie\nConfirmer uniquement après accord sur cette destination. Aucun achat.`
                    )
                )
                    return refuse('Confirmation annulée : aucun pixel envoyé.');
                // Re-check after the dialog and the local authorization request. A stop revokes this check.
                if (!(await allowed(c.attemptId)))
                    return refuse('Autorisation locale retirée ou expirée : préparez un nouveau pixel.');
                if (!(await GeoPlacerPageReader.unchanged()) || !valid(c, batch) || (batch && !validGrant(c, grant)))
                    return refuse('Modèle modifié ou autorisation expirée pendant la confirmation.');
                if (continuous && (GeoPlacerEnergy.snapshot()?.available ?? 0) < costWithReserve) {
                    lastReason = 'Énergie non confirmée par une nouvelle réponse native.';
                    return 'waiting-resources';
                }
                const finalReason = readinessReason(pixels.length,continuous);
                if (finalReason) return refuse(finalReason);
                if (!pixels.every((p) => (continuous ? GeoPlacerEnergy.snapshot()?.colors ?? [] : ownedColors()).includes(p.color)))
                    return refuse('Cette couleur ne figure plus dans les couleurs du compte.');
                if (batch && !sessionAllowance(c, grant))
                    return refuse('Budget de session épuisé ou autorisation modifiée.');
                // Keep legacy receipts; new receipts use one key per immutable attempt rather than rewriting a capped array.
                const legacy = JSON.parse(sessionStorage.getItem('geoplacer-single-pixel-dispatched-v1') || '[]');
                const receipt = 'geoplacer-dispatched-v2/' + c.attemptId;
                if (!Array.isArray(legacy) || legacy.includes(c.attemptId) || sessionStorage.getItem(receipt))
                    return refuse('Opération déjà enregistrée ou registre anti-doublon invalide. Aucun renvoi.');
                // Quota/storage errors fail before fetch, without deleting any old receipt.
                sessionStorage.setItem(receipt, '1');
                controller = new AbortController();
                timer = setTimeout(() => controller?.abort(), 10000);
                if (!batch) dispatched = true;
                if (energyCeiling === null) energyCeiling = currentEnergy;
                if (executionSession === null) executionSession = { user: userID, token: tokenUser, subject };
                if (batch && !sessionAllowance(c, grant, true)) return refuse('Budget de session épuisé.');
                energySpent += pixels.length;
                if (batch)
                    for (const p of pixels) batchTargets.add(c.batchId + '/' + p.gridX + ',' + p.gridY + ':' + p.color);
                if (typeof GeoPlacerEnergy !== 'undefined') GeoPlacerEnergy.spend(pixels.length);
                sent = true;
                // Fixed same-origin endpoint, one approved request, no redirects, no retry. No queue or bitmap mutation.
                const response = await fetch(location.origin + '/PlacePixels', {
                    method: 'POST',
                    redirect: 'error',
                    signal: controller.signal,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        Token: tokenUser,
                        Subject: subject,
                        UserId: userID,
                        Pixels: pixels.map((p) => ({ GridX: p.gridX, GridY: p.gridY, Color: p.color })),
                    }),
                });
                if(response.status===413 && grant?.execution==='autonomous'){
                    for(const p of pixels)batchTargets.delete(c.batchId+'/'+p.gridX+','+p.gridY+':'+p.color);
                    const local=sessionBudgets.get(c.batchId);if(local)local.spent-=pixels.length;
                    return 'rejected-size'; // Definitive HTTP refusal, original attempt receipt remains immutable.
                }
                return response.ok && (await response.text()) === 'Ok' ? 'confirmed' : 'uncertain';
            } catch {
                // No error bodies or session details are sent to GeoPlacer or written to the console.
                lastReason = sent
                    ? 'Réponse GeoPixels incertaine. Aucun renvoi automatique.'
                    : 'Vérification locale ou stockage anti-doublon indisponible.';
                return sent ? 'uncertain' : 'not-sent';
            } finally {
                if (sent && typeof GeoPlacerEnergy !== 'undefined') GeoPlacerEnergy.settled();
                clearTimeout(timer);
                controller = null;
                busy = false;
            }
        },
    };
    return api;
})();
