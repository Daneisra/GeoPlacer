/* Private browser-only writer. Site session values never leave this closure for loopback. */
const GeoPlacerPageWriter = (() => {
    let busy = false,
        dispatched = false,
        controller = null;
    const exact = (o, keys) =>
        o &&
        typeof o === 'object' &&
        !Array.isArray(o) &&
        Object.keys(o).length === keys.length &&
        keys.every((k) => Object.hasOwn(o, k));
    function valid(c) {
        if (
            !exact(c, ['protocol', 'attemptId', 'project', 'gridX', 'gridY', 'color', 'deadline']) ||
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
            JSON.stringify(c.project) === JSON.stringify(p) &&
            p.layer === 'base' &&
            c.gridX >= p.gridX &&
            c.gridX < p.gridX + p.width &&
            c.gridY <= p.gridY &&
            c.gridY > p.gridY - p.height
        );
    }
    const ready = () =>
        typeof tokenUser === 'string' &&
        tokenUser.length > 0 &&
        typeof subject === 'string' &&
        subject.length > 0 &&
        typeof userID === 'number' &&
        Number.isSafeInteger(userID) &&
        userID > 0 &&
        typeof currentEnergy === 'number' &&
        Number.isFinite(currentEnergy) &&
        currentEnergy >= 1 &&
        typeof userData === 'object' &&
        userData !== null &&
        Array.isArray(userData.colors) &&
        typeof queuedPixelsObjects !== 'undefined' &&
        queuedPixelsObjects.size === 0 &&
        typeof isPlacingRequestInProgress === 'boolean' &&
        !isPlacingRequestInProgress;
    return {
        stop: () => controller?.abort(),
        async execute(c, allowed, trusted) {
            if (
                !['https://geopixels.net', 'https://www.geopixels.net'].includes(location.origin) ||
                !trusted ||
                busy ||
                dispatched ||
                !valid(c)
            )
                return 'not-sent';
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
                    !(await GeoPlacerPageReader.unchanged()) ||
                    !ready() ||
                    !userData.colors.includes(c.color)
                )
                    return 'not-sent';
                const color = '#' + c.color.toString(16).padStart(6, '0');
                if (
                    !confirm(
                        `ESSAI RÉEL UNIQUE — GeoPixels\nCouche : base\nPixel (${c.gridX}, ${c.gridY})\nCouleur : ${color}\nCoût : 1 énergie\nConfirmer uniquement après accord sur cette destination. Aucun achat.`
                    )
                )
                    return 'not-sent';
                // Re-check after the dialog and the local authorization request. A stop revokes this check.
                if (
                    !(await allowed(c.attemptId)) ||
                    !(await GeoPlacerPageReader.unchanged()) ||
                    !valid(c) ||
                    !ready() ||
                    !userData.colors.includes(c.color)
                )
                    return 'not-sent';
                const key = 'geoplacer-single-pixel-dispatched-v1';
                const ids = JSON.parse(sessionStorage.getItem(key) || '[]');
                if (!Array.isArray(ids) || ids.includes(c.attemptId) || ids.length >= 100) return 'not-sent';
                sessionStorage.setItem(key, JSON.stringify([...ids, c.attemptId]));
                controller = new AbortController();
                timer = setTimeout(() => controller?.abort(), 10000);
                dispatched = true;
                sent = true;
                // Fixed same-origin endpoint, single pixel, no redirects, no retry. No queue or bitmap mutation.
                const response = await fetch(location.origin + '/PlacePixels', {
                    method: 'POST',
                    redirect: 'error',
                    signal: controller.signal,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        Token: tokenUser,
                        Subject: subject,
                        UserId: userID,
                        Pixels: [{ GridX: c.gridX, GridY: c.gridY, Color: c.color }],
                    }),
                });
                return response.ok && (await response.text()) === 'Ok' ? 'confirmed' : 'uncertain';
            } catch {
                // No error bodies or session details are sent to GeoPlacer or written to the console.
                return sent ? 'uncertain' : 'not-sent';
            } finally {
                clearTimeout(timer);
                controller = null;
                busy = false;
            }
        },
    };
})();
