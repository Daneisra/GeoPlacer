/** Real loopback HTTP/security tests. No request to GeoPixels or account/session credential. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
import { ConnectorPairing, ConnectorHttpChannel, GeoPixelsProvider } from '@geoplacer/engine-service';
import { createPrivilegedReaderRouter } from '../src/api/v1/connector-http.ts';
import { createConnectorRouter } from '../src/api/v1/connector-router.ts';
import { applyBaseProtections } from '../src/app-base.ts';
const pairing = new ConnectorPairing(),
  connector = new GeoPixelsProvider(),
  key = '1'.repeat(64);
const channel = new ConnectorHttpChannel(pairing, connector, key);
const app = express();
app.use('/api/v1/connector/privileged', createPrivilegedReaderRouter(channel));
applyBaseProtections(app, {
  policy: { allowedHostnames: new Set(['127.0.0.1']), originPatterns: [] },
  rateLimitWindowMs: 60_000,
  rateLimitMax: 1000,
  jsonLimit: '1mb',
});
app.use(
  '/api/v1/connector',
  createConnectorRouter({ pairing, connector, connectorView: async () => connector.status() }, channel)
);
const server = createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`,
  control = '/api/v1/connector/http',
  reader = '/api/v1/connector/privileged';
const results = [],
  json = { 'Content-Type': 'application/json' };
const post = (path, body, headers = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const check = async (name, fn) => {
  await fn();
  results.push({ name, ok: true });
};
let capability;
try {
  await check('forged local management headers still require the private approval key', async () => {
    assert.equal(
      (
        await post(
          control + '/pair',
          { origin: 'https://geopixels.net' },
          { Origin: base, 'Sec-Fetch-Site': 'same-origin' }
        )
      ).status,
      409
    );
  });
  const code = await (
    await post(control + '/pair', { origin: 'https://geopixels.net' }, { Origin: base, 'X-GeoPlacer-Approval': key })
  ).json();
  const claim = await (
    await post(
      reader + '/claim',
      { protocol: 1, origin: 'https://geopixels.net', code: code.token },
      { Origin: 'chrome-extension://' + 'a'.repeat(32) }
    )
  ).json();
  capability = claim.capability;
  assert.match(capability, /^[a-f0-9]{64}$/);
  const auth = { Authorization: 'Bearer ' + capability };
  await check('claim is pending until explicit dashboard confirmation', async () => {
    assert.equal(connector.status().connected, false);
    assert.equal((await (await post(reader + '/status', { protocol: 1 }, auth)).json()).approved, false);
    assert.equal(
      (await post(control + '/approve', { requestId: claim.requestId }, { Origin: base, 'X-GeoPlacer-Approval': key }))
        .status,
      200
    );
    assert.equal(connector.status().mode, 'read-only');
  });
  await check('extension Origin exception is limited to the dedicated ingress', async () => {
    assert.equal(
      (
        await post(
          control + '/pair',
          { origin: 'https://geopixels.net' },
          { Origin: 'chrome-extension://' + 'a'.repeat(32), 'X-GeoPlacer-Approval': key }
        )
      ).status,
      403
    );
    assert.equal(
      (await post(reader + '/status', { protocol: 1 }, { ...auth, Origin: 'https://evil.example' })).status,
      403
    );
    assert.equal((await post(reader + '/status', { protocol: 1 }, auth)).status, 200);
    assert.equal((await post(reader + '/status', { protocol: 1 }, { ...auth, Origin: 'null' })).status, 200);
  });
  await check('no CORS permission, preflight, simple form, or unauthenticated reader access', async () => {
    const options = await fetch(base + reader + '/observations', {
      method: 'OPTIONS',
      headers: { Origin: 'https://geopixels.net' },
    });
    assert.equal(options.status, 405);
    assert.equal(options.headers.get('access-control-allow-origin'), null);
    assert.equal(
      (await fetch(base + reader + '/claim', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }))
        .status,
      415
    );
    assert.equal((await post(reader + '/status', { protocol: 1 })).status, 403);
  });
  const observation = {
    type: 'observation',
    sequence: 1,
    session: 'fixture',
    project: { id: 'fixture', generation: '0', width: 64, height: 64, gridX: 999, gridY: 1001, layer: 'base' },
    capturedAt: Date.now(),
    observedAt: null,
    rect: { x: 999, y: 938, width: 64, height: 64 },
    pixels: new Array(4096).fill(0),
    resources: null,
  };
  await check('unknown commands, site secrets and oversized bodies are refused', async () => {
    assert.equal(
      (await post(reader + '/observations', { protocol: 1, observations: [observation], tokenUser: 'forbidden' }, auth))
        .status,
      409
    );
    assert.equal(
      (
        await post(
          reader + '/observations',
          { protocol: 1, observations: [{ ...observation, cookie: 'forbidden' }] },
          auth
        )
      ).status,
      409
    );
    assert.equal((await post(reader + '/fetch', { url: 'https://evil.example' }, auth)).status, 404);
    assert.equal((await post(reader + '/observations', '{"huge":"' + 'x'.repeat(800_000) + '"}', auth)).status, 413);
  });
  let elapsedMs;
  await check('structured observations and identical acknowledgement retry', async () => {
    const before = performance.now(),
      body = { protocol: 1, observations: [observation] };
    const first = await (await post(reader + '/observations', body, auth)).json();
    elapsedMs = performance.now() - before;
    assert.equal(first.accepted, true);
    assert.equal(first.sequence, 1);
    assert.equal((await (await post(reader + '/observations', body, auth)).json()).duplicate, true);
    assert.equal((await (await post(reader + '/status', { protocol: 1 }, auth)).json()).lastSequence, 1);
  });
  await check('revocation rejects the former capability', async () => {
    await post('/api/v1/connector/revoke', {}, { Origin: base });
    assert.equal((await post(reader + '/status', { protocol: 1 }, auth)).status, 403);
    assert.equal(connector.status().connected, false);
  });
  const throughput = [];
  await check('large synthetic observations use the actual throttled GM transport contract', async () => {
    const context = vm.createContext({ URL, TextEncoder, performance, setTimeout, clearTimeout });
    vm.runInContext(
      readFileSync(new URL('../browser/geopixels-http-transport.js', import.meta.url), 'utf8') +
        '\nglobalThis.factory = GeoPlacerHttpTransport;',
      context
    );
    const code = channel.issue(key, 'https://geopixels.net');
    const transport = context.factory(base, (o) => {
      let aborted = false;
      fetch(o.url, { method: o.method, headers: o.headers, body: o.data, redirect: 'error' })
        .then(async (r) => {
          const responseText = await r.text();
          if (!aborted) o.onload({ status: r.status, finalUrl: r.url, responseText });
        })
        .catch(() => {
          if (!aborted) o.onerror();
        });
      return {
        abort() {
          aborted = true;
          o.onabort();
        },
      };
    });
    await transport.pair(code.token, 'https://geopixels.net', () =>
      channel.approve(key, channel.info().pending.requestId)
    );
    for (const [width, height] of [
      [64, 64],
      [595, 894],
      [2000, 2000],
    ]) {
      const before = performance.now();
      let batches = 0,
        bytes = 0;
      for (let row = 0; row < height;) {
        const rows = Math.min(height - row, Math.max(1, Math.floor(16384 / width)));
        const o = {
          type: 'observation',
          session: 'large-fixture',
          project: {
            id: `size-${width}-${height}`,
            generation: '0',
            width,
            height,
            gridX: 999,
            gridY: 1001,
            layer: 'base',
          },
          capturedAt: Date.now(),
          observedAt: null,
          rect: { x: 999, y: 1001 - row - rows + 1, width, height: rows },
          pixels: new Array(width * rows).fill(-2),
          resources: null,
        };
        bytes += Buffer.byteLength(JSON.stringify(o));
        await transport.send(o);
        row += rows;
        batches++;
      }
      throughput.push({
        width,
        height,
        pixels: width * height,
        batches,
        encodedObservationBytes: bytes,
        elapsedMs: performance.now() - before,
        synthetic: true,
      });
    }
    await transport.disconnect();
  });
  console.log(
    JSON.stringify({
      passed: results.length,
      results,
      loopbackObservationPixels: 4096,
      roundTripMs: elapsedMs,
      throughput,
    })
  );
} finally {
  pairing.revoke();
  connector.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
