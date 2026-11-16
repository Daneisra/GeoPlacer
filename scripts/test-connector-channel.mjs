/** Real local HTTP/WebSocket transport tests, executed with node --import tsx. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { ConnectorPairing, GeoPixelsProvider } from '@geoplacer/engine-service';
import { createConnectorRouter, isLoopbackChannel } from '../src/api/v1/connector-router.ts';
import { attachConnectorSocket } from '../src/api/v1/connector-socket.ts';
const results = [];
async function run(name, test) {
  const pairing = new ConnectorPairing(),
    connector = new GeoPixelsProvider(),
    clients = [];
  const api = {
    pairing,
    connector,
    connectorView: async () => connector.status(),
    bindConnector: async () => {
      throw new Error('private filesystem details');
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1/connector', createConnectorRouter(api));
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`,
    base = origin + '/api/v1/connector';
  const wss = new WebSocketServer({
    server,
    maxPayload: 1_000_000,
    verifyClient: (info) => isLoopbackChannel(info.req) && pairing.acceptsOrigin(info.origin),
  });
  wss.on('connection', (ws, req) => attachConnectorSocket(ws, req.headers.origin ?? '', api));
  const connect = async (token, from = origin) => {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/v1/connector/channel', { origin: from });
    clients.push(ws);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'pair', protocol: 1, token }));
    return ws;
  };
  const message = async (ws) => JSON.parse((await once(ws, 'message'))[0].toString());
  try {
    await test({ pairing, connector, origin, base, connect, message });
    results.push({ name, ok: true });
  } finally {
    pairing.revoke();
    connector.close();
    for (const c of clients) c.terminate();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(r));
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
await run('exact origin, loopback and authenticated handshake', async ({ pairing, connector, origin, connect, message }) => {
  const p = pairing.issue('local-fake', origin);
  await assert.rejects(connect(p.token, 'https://evil.example'), /40[13]/);
  assert.equal(isLoopbackChannel({ headers: { host: 'evil.example' }, socket: { remoteAddress: '127.0.0.1' } }), false);
  assert.equal(isLoopbackChannel({ headers: { host: 'localhost' }, socket: { remoteAddress: '192.168.1.5' } }), false);
  const ws = await connect(p.token);
  assert.equal((await message(ws)).type, 'paired');
  assert.equal(connector.status().connected, true);
});
await run('incorrect capability', async ({ pairing, connector, origin, connect }) => {
  pairing.issue('local-fake', origin);
  const ws = await connect('0'.repeat(64));
  assert.equal((await once(ws, 'close'))[0], 1008);
  assert.equal(connector.status().connected, false);
});
for (const payload of [
  { type: 'fetch', url: 'https://evil.example' },
  { type: 'purchase', amount: 1 },
  { type: 'heartbeat', tokenUser: 'synthetic-secret' },
  { type: 'pair', protocol: 1, token: 'again' },
])
  await run('forbidden ' + payload.type + JSON.stringify(Object.keys(payload)), async ({ pairing, origin, connect, message }) => {
    const p = pairing.issue('local-fake', origin),
      ws = await connect(p.token);
    await message(ws);
    const closed = once(ws, 'close');
    ws.send(JSON.stringify(payload));
    assert.equal((await closed)[0], 1008);
  });
await run('one-use capability and live revocation', async ({ pairing, origin, connect, message }) => {
  const p = pairing.issue('local-fake', origin),
    ws = await connect(p.token);
  await message(ws);
  const closed = once(ws, 'close');
  pairing.revoke();
  assert.equal((await closed)[0], 1008);
  await assert.rejects(connect(p.token), /40[13]/);
});
await run('HTTP control origin, strict schema and secret-free status', async ({ base, origin }) => {
  const request = (body, headers = {}) =>
    fetch(base + '/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await request({ mode: 'local-fake', origin }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request({ mode: 'local-fake', origin, token: 'synthetic-secret' })).status, 400);
  assert.equal((await request({ mode: 'local-fake', origin: 'https://www.geopixels.net' })).status, 409);
  assert.equal((await request({ mode: 'local-fake', origin })).status, 200);
  const status = await (await fetch(base + '/status')).text();
  assert.doesNotMatch(status, /synthetic-secret|tokenUser|"token"/);
  const failed = await fetch(base + '/bind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /private filesystem/);
});
console.log(JSON.stringify({ passed: results.length, results }));
