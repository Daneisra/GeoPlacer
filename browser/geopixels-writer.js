/* Private browser-only writer. Site session values never leave this closure for loopback. */
const GeoPlacerPageWriter = (() => {
    let busy = false,
        dispatched = false,
        controller = null,
        lastReason = null,
        energyCeiling = null,
        energySpent = 0,
        executionSession = null;
    const batchTargets = new Set();
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
                c.pixels.length <= 5 &&
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
    function validGrant(c, grant) {
        return (
            exact(grant, [
                'id',
                'digest',
                'expires',
                'project',
                'writes',
                ...(c.protocol === 2 ? ['execution'] : []),
            ]) &&
            (c.protocol !== 2 || grant.execution === 'grouped') &&
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
            grant.writes.length <= 5 &&
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
                ? c.pixels.length === grant.writes.length &&
                  c.pixels.every((p) =>
                      grant.writes.some((w) => w.gridX === p.gridX && w.gridY === p.gridY && w.color === p.color)
                  )
                : grant.writes.some((w) => w.gridX === c.gridX && w.gridY === c.gridY && w.color === c.color))
        );
    }
    function readinessReason(cost = 1) {
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
            currentEnergy < cost ||
            (energyCeiling !== null && Math.min(currentEnergy, energyCeiling - energySpent) < cost)
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
                const reason = readinessReason(pixels.length);
                if (reason) return refuse(reason);
                if (!pixels.every((p) => ownedColors().includes(p.color)))
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
                const finalReason = readinessReason(pixels.length);
                if (finalReason) return refuse(finalReason);
                if (!pixels.every((p) => ownedColors().includes(p.color)))
                    return refuse('Cette couleur ne figure plus dans les couleurs du compte.');
                const key = 'geoplacer-single-pixel-dispatched-v1';
                const ids = JSON.parse(sessionStorage.getItem(key) || '[]');
                if (!Array.isArray(ids) || ids.includes(c.attemptId) || ids.length >= 100)
                    return refuse('Registre anti-doublon indisponible ou opération déjà enregistrée. Aucun renvoi.');
                sessionStorage.setItem(key, JSON.stringify([...ids, c.attemptId]));
                controller = new AbortController();
                timer = setTimeout(() => controller?.abort(), 10000);
                if (!batch) dispatched = true;
                if (energyCeiling === null) energyCeiling = currentEnergy;
                if (executionSession === null) executionSession = { user: userID, token: tokenUser, subject };
                energySpent += pixels.length;
                if (batch)
                    for (const p of pixels) batchTargets.add(c.batchId + '/' + p.gridX + ',' + p.gridY + ':' + p.color);
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
                return response.ok && (await response.text()) === 'Ok' ? 'confirmed' : 'uncertain';
            } catch {
                // No error bodies or session details are sent to GeoPlacer or written to the console.
                lastReason = sent
                    ? 'Réponse GeoPixels incertaine. Aucun renvoi automatique.'
                    : 'Vérification locale ou stockage anti-doublon indisponible.';
                return sent ? 'uncertain' : 'not-sent';
            } finally {
                clearTimeout(timer);
                controller = null;
                busy = false;
            }
        },
    };
    return api;
})();
