/* Fixed in-game shop port. Credentials stay in this browser closure.
 * GeoPixelsFront@74783af: userProfile.js/MakePurchase + index.html prices.
 * Never call MakePurchase itself: its synchronize() would fetch map tiles. */
const GeoPlacerShop = (() => {
    const catalogId = 'geopixels-shop-74783af-v1';
    const types = {
        'energy-pack': ['Energy', 10],
        'max-energy': ['EnergyCapacity', 50],
        'regen-speed': ['FasterRecharge', 500],
        'color-unlock': ['ExtraColor', 100],
    };
    let controller = null;
    function catalog() {
        if (typeof MakePurchase !== 'function') return null;
        const f = Function.prototype.toString.call(MakePurchase);
        if (!f.includes('/MakePurchase') || !f.includes('UserId') || !f.includes('Subject')) return null;
        const cards = [
            ['EnergyInput', '10 Pixels / +20 energy'],
            ['EnergyCapacityInput', '50 Pixels / +5 max'],
            ['FasterRechargeInput', '500 Pixels / -1s (cap at 15s)'],
            ['ExtraColorInput', '100 Pixels / Any hex color allowed'],
        ];
        return cards.every(([id, price]) =>
            document.getElementById(id)?.parentElement?.parentElement?.textContent?.includes(price)
        )
            ? catalogId
            : null;
    }
    function colorPrice(owned) {
        // Public profile contract counts the transparent swatch among the first 35 colors.
        if (
            typeof toggleProfile !== 'function' ||
            !/Colors\.length\s*<\s*35/.test(Function.prototype.toString.call(toggleProfile)) ||
            typeof Colors === 'undefined' ||
            !Array.isArray(Colors) ||
            Colors.length !== owned.length + 1 ||
            !Colors.includes('#00000000')
        )
            return null;
        const native = Colors.filter((c) => c !== '#00000000').map((c) =>
            /^#[0-9a-f]{6}$/i.test(c) ? parseInt(c.slice(1), 16) : -1
        );
        if (native.length !== owned.length || native.some((c) => !owned.includes(c))) return null;
        return owned.length < 34 ? 0 : 100;
    }
    let purchaseSession = null;
    function offerAvailable(kind) {
        const ids = { 'energy-pack': 'EnergyInput', 'max-energy': 'EnergyCapacityInput', 'regen-speed': 'FasterRechargeInput', 'color-unlock': 'ExtraColorInput' };
        const input = document.getElementById(ids[kind]);
        const buttons = input?.parentElement?.parentElement?.querySelectorAll?.('button') ?? [];
        const buy = [...buttons].find(button => /^Buy$/i.test(button.textContent?.trim() ?? ''));
        return !!input && !input.disabled && !buy?.disabled;
    }
    async function execute(c, allowed) {
        let sent = false,
            timer;
        try {
            if (
                controller ||
                !c ||
                Object.keys(c).length !== 9 ||
                !['id', 'job', 'project', 'kind', 'color', 'cost', 'catalog', 'deadline', 'policy'].every((k) =>
                    Object.hasOwn(c, k)
                ) ||
                !types[c.kind] ||
                c.catalog !== catalog() ||
                !/^[a-f0-9-]{36}$/.test(c.id) ||
                !/^[a-f0-9-]{36}$/.test(c.job) ||
                c.deadline <= Date.now() ||
                c.deadline > Date.now() + 30000
            )
                return 'not-sent';
            if (
                !(await GeoPlacerPageReader.unchanged()) ||
                JSON.stringify(c.project) !== JSON.stringify(GeoPlacerPageReader.project()) ||
                c.project.layer !== 'base'
            )
                return 'not-sent';
            const p = c.policy,
                r = GeoPlacerEnergy.snapshot();
            if (c.cost !== (c.kind === 'color-unlock' ? r?.shop?.colorPrice : types[c.kind][1])) return 'not-sent';
            if (c.kind === 'color-unlock' && colorPrice(r?.colors ?? []) !== r?.shop?.colorPrice) return 'not-sent';
            if (
                !r?.shop ||
                !p ||
                Object.keys(p).length !== 5 ||
                !['maxBudget', 'minimumReserve', 'targetCapacity', 'energyBelow', 'priority'].every((k) =>
                    Object.hasOwn(p, k)
                ) ||
                !Array.isArray(p.priority) ||
                new Set(p.priority).size !== p.priority.length ||
                p.priority.some((k) => !types[k]) ||
                !p.priority.includes(c.kind) ||
                (p.maxBudget !== null && (!Number.isSafeInteger(p.maxBudget) || p.maxBudget < 0)) ||
                ![p.minimumReserve, p.targetCapacity, p.energyBelow].every(
                    (n) => Number.isSafeInteger(n) && n >= 0
                )
            )
                return 'not-sent';
            if (
                typeof tokenUser !== 'string' ||
                !tokenUser ||
                typeof subject !== 'string' ||
                !subject ||
                typeof userID !== 'number' ||
                !Number.isSafeInteger(userID) ||
                typeof queuedPixelsObjects === 'undefined' ||
                queuedPixelsObjects.size !== 0 ||
                typeof isPlacingRequestInProgress !== 'boolean' ||
                isPlacingRequestInProgress
            )
                return 'not-sent';
            if (
                (c.kind === 'energy-pack' && r.available >= p.energyBelow) ||
                !offerAvailable(c.kind) ||
                (c.kind === 'max-energy' && p.targetCapacity > 0 && r.shop.capacity >= p.targetCapacity) ||
                (c.kind === 'regen-speed' && r.shop.intervalMs <= 15000) ||
                (c.kind === 'color-unlock' &&
                    (!Number.isSafeInteger(c.color) || c.color < 0 || c.color > 0xffffff || r.colors.includes(c.color)))
            )
                return 'not-sent';
            const key = 'geoplacer-purchase-' + c.id,
                budgetKey = 'geoplacer-purchase-budget-' + c.job;
            const spent = Number(sessionStorage.getItem(budgetKey) ?? 0);
            if (
                !Number.isSafeInteger(spent) ||
                spent < 0 ||
                (p.maxBudget !== null && spent + c.cost > p.maxBudget) ||
                r.shop.currency - c.cost < p.minimumReserve ||
                sessionStorage.getItem(key) ||
                !(await allowed(c.id))
            )
                return 'not-sent';
            if (
                !(await GeoPlacerPageReader.unchanged()) ||
                GeoPlacerEnergy.snapshot()?.sequence !== r.sequence ||
                c.catalog !== catalog() ||
                !offerAvailable(c.kind) ||
                Date.now() >= c.deadline ||
                queuedPixelsObjects.size !== 0 ||
                isPlacingRequestInProgress
            )
                return 'not-sent';
            if (
                purchaseSession &&
                (purchaseSession.user !== userID ||
                    purchaseSession.token !== tokenUser ||
                    purchaseSession.subject !== subject)
            )
                return 'not-sent';
            purchaseSession ??= { user: userID, token: tokenUser, subject };
            // Receipt and conservative budget are written BEFORE the sole network call.
            sessionStorage.setItem(key, 'reserved');
            sessionStorage.setItem(budgetKey, String(spent + c.cost));
            controller = new AbortController();
            timer = setTimeout(() => controller?.abort(), 10000);
            GeoPlacerEnergy.spend(0);
            sent = true;
            const res = await fetch('/MakePurchase', {
                method: 'POST',
                redirect: 'error',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    Token: tokenUser,
                    UserId: userID,
                    Subject: subject,
                    type: types[c.kind][0],
                    amount: c.kind === 'color-unlock' ? c.color : 1,
                }),
                signal: controller.signal,
            });
            // HTTP 200 is native acceptance only. The engine requires a subsequent native balance/effect.
            return res.status === 200
                ? 'accepted'
                : res.status === 401 || res.status === 402
                  ? 'not-sent'
                  : 'uncertain';
        } catch {
            return sent ? 'uncertain' : 'not-sent';
        } finally {
            clearTimeout(timer);
            if (sent) GeoPlacerEnergy.settled();
            controller = null;
        }
    }
    return { catalog, colorPrice, execute, stop: () => controller?.abort() };
})();
