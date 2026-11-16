import type { WebSocket } from 'ws';
import type { EngineApi } from './engine-api.js';

/** A single-purpose authenticated channel, isolated from dashboard controls and log sockets. */
export function attachConnectorSocket(ws: WebSocket, origin: string, engine: EngineApi): void {
  let authenticated = false;
  let owned = false;
  let epoch = -1;
  let messages = 0;
  const deadline = setTimeout(() => ws.close(1008, 'pairing expired'), 5_000);
  const rate = setInterval(() => {
    messages = 0;
  }, 1_000);
  const heartbeat = setInterval(() => {
    if (authenticated && !engine.connector!.status().connected) ws.close(1008, 'heartbeat expired');
  }, 5_000);
  ws.on('message', (bytes) => {
    try {
      if (Buffer.byteLength(bytes.toString()) > 1_000_000 || ++messages > 80) throw new Error('message limit');
      const value = JSON.parse(bytes.toString()) as Record<string, unknown>;
      if (!authenticated) {
        if (value.type !== 'pair' || value.protocol !== 1 || typeof value.token !== 'string' || Object.keys(value).length !== 3)
          throw new Error('pairing required');
        const mode = engine.pairing!.redeem(origin, value.token, () => ws.close(1008, 'revoked'));
        engine.connector!.connect(mode, (command) => {
          if (ws.readyState !== 1 || ws.bufferedAmount > 1_000_000) throw new Error('channel unavailable');
          ws.send(JSON.stringify(command));
        });
        epoch = engine.connector!.channelEpoch;
        authenticated = true;
        owned = true;
        clearTimeout(deadline);
        ws.send(JSON.stringify({ type: 'paired', protocol: 1, mode }));
      } else if (epoch !== engine.connector!.channelEpoch) throw new Error('replaced channel');
      else if (value.type === 'observation') {
        engine.connector!.observe(value);
        ws.send(JSON.stringify({ type: 'observed', sequence: value.sequence }));
      } else if (value.type === 'result') engine.connector!.result(value);
      else if (value.type === 'heartbeat' && Object.keys(value).length === 1) engine.connector!.heartbeat();
      else throw new Error('operation not allowed');
    } catch {
      ws.close(1008, 'invalid connector message');
    }
  });
  const cleanup = () => {
    clearTimeout(deadline);
    clearInterval(rate);
    clearInterval(heartbeat);
    if (owned) {
      owned = false;
      if (epoch === engine.connector!.channelEpoch) engine.connector!.disconnect('browser channel closed');
    }
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}
