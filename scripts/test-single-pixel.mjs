/** Full local HTTP + browser writer flow. The only site fetch is a VM stub. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import vm from 'node:vm';
import express from 'express';
import { EngineService, ConnectorHttpChannel } from '@geoplacer/engine-service';
import { pngjsCodec } from '@geoplacer/adapters-node';
import { createPrivilegedReaderRouter } from '../src/api/v1/connector-http.ts';
import { createConnectorRouter } from '../src/api/v1/connector-router.ts';
const dir = await mkdtemp(path.join(tmpdir(), 'gp-single-pixel-http-'));
const s = await EngineService.open({ dataDir: dir });
const key = randomBytes(32).toString('hex');
const channel = new ConnectorHttpChannel(s.pairing, s.connector, key, Date.now, s.singlePixelWriter);
const app = express();
app.use('/api/v1/connector/privileged', createPrivilegedReaderRouter(channel));
app.use(express.json());
app.use('/api/v1/connector', createConnectorRouter(s, channel));
const server = createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/api/v1/connector`;
const sent = [];
let capability;
const post = (route, body, headers = {}) => {
    sent.push(JSON.stringify(body));
    return fetch(base + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
};
const management = { Origin: new URL(base).origin, 'X-GeoPlacer-Approval': key };
const ingress = () => ({ Authorization: 'Bearer ' + capability });
const passed = [];
try {
    const rgba = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const t = await s.importTemplate({
        name: 'HTTP single-pixel fixture',
        png: await pngjsCodec.encode({ width: 2, height: 2, rgba }),
        x: 0,
        y: 0,
        strategy: 'top-to-bottom',
    });
    await s.selectTemplate(t.templateId);
    await s.selectSource('geopixels');
    assert.equal((await post('/pixel/prepare', { mode: 'real' })).status, 409);
    passed.push('dashboard private approval required');
    const issued = await (await post('/http/pair', { origin: 'https://geopixels.net' }, management)).json();
    const claim = await (
        await post('/privileged/claim', { protocol: 1, origin: 'https://geopixels.net', code: issued.token })
    ).json();
    capability = claim.capability;
    assert.equal((await post('/privileged/pixel-claim', { protocol: 1 }, ingress())).status, 409);
    await post('/http/approve', { requestId: claim.requestId }, management);
    passed.push('browser approval required');
    const project = {
        id: 'verified-HTTP-fixture',
        generation: '1',
        width: 2,
        height: 2,
        gridX: -1001,
        gridY: 1001,
        layer: 'base',
    };
    let sequence = 0;
    async function observe(pixels) {
        const now = Date.now();
        assert.equal(
            (
                await post(
                    '/privileged/observations',
                    {
                        protocol: 1,
                        observations: [
                            {
                                type: 'observation',
                                sequence: ++sequence,
                                session: 'synthetic-browser-context',
                                project,
                                capturedAt: now,
                                observedAt: null,
                                rect: { x: -1001, y: 1000, width: 2, height: 2 },
                                pixels,
                                resources: null,
                            },
                        ],
                    },
                    ingress()
                )
            ).status,
            200
        );
    }
    await observe([-1, -1, -1, -1]);
    await post('/bind', {}, management);
    const prepared = await (await post('/pixel/prepare', { mode: 'real' }, management)).json();
    const c = prepared.destination;
    assert.equal(prepared.state, 'leased');
    assert.equal(c.gridY, 1001);
    assert.equal(
        (
            await post(
                '/pixel/confirm',
                { attemptId: c.attemptId, gridX: c.gridX, gridY: 1002, color: c.color, approved: true },
                management
            )
        ).status,
        409
    );
    assert.equal(
        (
            await post(
                '/pixel/confirm',
                { attemptId: c.attemptId, gridX: c.gridX, gridY: c.gridY, color: c.color, approved: true },
                management
            )
        ).status,
        200
    );
    passed.push('durable preparation and exact destination approval');
    assert.equal((await post('/privileged/pixel-claim', { protocol: 1, extra: 'refused' }, ingress())).status, 409);
    assert.equal((await post('/privileged/pixel-claim', { protocol: 1 })).status, 403);
    assert.equal(
        (await post('/privileged/pixel-claim', { protocol: 1 }, { ...ingress(), Origin: 'https://evil.example' }))
            .status,
        403
    );
    passed.push('strict schema, capability and origin checks');
    const command = (await (await post('/privileged/pixel-claim', { protocol: 1 }, ingress())).json()).command;
    assert.deepEqual(command, c);
    assert.equal((await (await post('/privileged/pixel-claim', { protocol: 1 }, ingress())).json()).command, null);
    passed.push('command is delivered at most once');
    const browserStore = new Map();
    let siteCalls = 0;
    const context = vm.createContext({
        Date,
        setTimeout,
        clearTimeout,
        AbortController,
        location: { origin: 'https://geopixels.net' },
        confirm: () => true,
        GeoPlacerPageReader: {
            project: () => project,
            unchanged: async () => true,
            contract: async () => ({ layer: 'base', id: 'base-only-8367389' }),
        },
        tokenUser: 'synthetic-site-secret-NEVER-loopback',
        subject: 'synthetic-site-subject',
        userID: 7,
        userData: { colors: [c.color] },
        currentEnergy: 1,
        queuedPixelsObjects: new Map(),
        isPlacingRequestInProgress: false,
        sessionStorage: { getItem: (k) => browserStore.get(k), setItem: (k, v) => browserStore.set(k, v) },
        fetch: async (url, options) => {
            siteCalls++;
            assert.equal(url, 'https://geopixels.net/PlacePixels');
            assert.equal(JSON.parse(options.body).Pixels.length, 1);
            return { ok: true, text: async () => 'Ok' };
        },
    });
    vm.runInContext(
        (await readFile(new URL('../browser/geopixels-writer.js', import.meta.url), 'utf8')) +
            '\nglobalThis.writer=GeoPlacerPageWriter;',
        context
    );
    const allowed = async (attemptId) =>
        (await (await post('/privileged/pixel-check', { protocol: 1, attemptId }, ingress())).json()).allowed;
    const result = await context.writer.execute(command, allowed, true);
    assert.equal(result, 'confirmed');
    assert.equal(siteCalls, 1);
    assert.equal(
        (await post('/privileged/pixel-result', { protocol: 1, attemptId: c.attemptId, result }, ingress())).status,
        200
    );
    assert.equal(s.singlePixelWriter.view().state, 'finished');
    assert.equal((await s.connectorView()).progress.correct, 0);
    await observe([-1, -1, c.color, -1]);
    assert.equal((await s.connectorView()).progress.correct, 1);
    passed.push('browser-only mock execution, durable result and independently observed progress');
    assert.equal(sent.join('').includes('synthetic-site-'), false);
    passed.push('site credentials never sent to local server');
    const second = (await (await post('/pixel/prepare', { mode: 'real' }, management)).json()).destination;
    await post(
        '/pixel/confirm',
        { attemptId: second.attemptId, gridX: second.gridX, gridY: second.gridY, color: second.color, approved: true },
        management
    );
    await post('/privileged/pixel-claim', { protocol: 1 }, ingress()); // discard reply: no execution or result
    await post('/pixel/stop', {}, management);
    await post(
        '/privileged/pixel-result',
        { protocol: 1, attemptId: second.attemptId, result: 'confirmed' },
        ingress()
    );
    assert.equal(s.singlePixelWriter.view().state, 'needs-reconciliation');
    channel.revoke();
    assert.equal(
        (await post('/privileged/pixel-check', { protocol: 1, attemptId: second.attemptId }, ingress())).status,
        403
    );
    passed.push('lost response, immediate stop, late result and revocation');
    console.log(JSON.stringify({ passed: passed.length, scenarios: passed, realPlacements: 0 }));
} finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    await s.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}
