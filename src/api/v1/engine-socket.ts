/**
 * Engine WebSocket channel (Phase 1B.9), path /api/v1/ws.
 *
 * - On connection the client receives `hello`: the stream id, the current
 *   sequence number and the full status. It then receives the engine events
 *   (`state`, `status`, `attempts`, `error`, `canvas`, `canvas-resync`,
 *   `notice`), each with its sequence number.
 * - A reconnecting client gets a new `hello`: a consistent state, whatever
 *   it missed (a new `stream` id means the server restarted).
 * - A slow client never blocks the engine: beyond `maxBufferedBytes`
 *   waiting to be sent, its events are dropped and, once its buffer has
 *   drained, it receives `resync` (a new full status) followed by a
 *   `canvas-resync`.
 * - Closing a socket only unsubscribes it: the simulation goes on.
 * The attempt journal never depends on this channel.
 */

import type { EngineApi, EngineEventEnvelopeLike } from './engine-api.js';

export const ENGINE_WS_PATH = '/api/v1/ws';

/** The subset of a `ws` WebSocket used here (tests pass a fake). */
export interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
}

export interface EngineSocketOptions {
  /** Bytes waiting to be sent beyond which events are dropped (default 1 MiB). */
  readonly maxBufferedBytes?: number;
}

const OPEN = 1;

export function attachEngineSocket(ws: SocketLike, api: EngineApi, options: EngineSocketOptions = {}): () => void {
  const limit = options.maxBufferedBytes ?? 1024 * 1024;
  let behind = false;
  let dropped = 0;
  let closed = false;

  const send = (message: unknown): void => {
    if (closed || ws.readyState !== OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // A failing socket is closed by the server's ping loop; the engine goes on.
    }
  };
  const hello = (type: 'hello' | 'resync'): void => {
    const stream = api.stream;
    send({ type, stream: stream.id, seq: stream.seq, status: api.status(), ...(type === 'resync' ? { dropped } : {}) });
  };

  hello('hello');
  const unsubscribe = api.subscribe((e: EngineEventEnvelopeLike) => {
    if (closed || ws.readyState !== OPEN) return;
    if (ws.bufferedAmount > limit) {
      behind = true;
      dropped++;
      return;
    }
    if (behind) {
      // Caught up: everything missed is replaced by a fresh status and a canvas re-read.
      hello('resync');
      send({ type: 'event', stream: e.stream, seq: e.seq, at: e.at, event: { type: 'canvas-resync', reason: `${dropped} event(s) dropped for a slow connection` } });
      behind = false;
      dropped = 0;
      if (e.event.type === 'canvas' || e.event.type === 'status') return;
    }
    send({ type: 'event', stream: e.stream, seq: e.seq, at: e.at, event: e.event });
  });

  ws.on('message', (data: unknown) => {
    let message: unknown;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    const type = (message as { type?: unknown } | null)?.type;
    if (type === 'ping') send({ type: 'pong' });
    else if (type === 'resync') hello('resync');
  });
  const close = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe();
  };
  ws.on('close', close);
  return close;
}
