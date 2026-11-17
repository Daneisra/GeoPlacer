/**
 * Shared engine state (Phase 1B.9), fed by the WebSocket /api/v1/ws:
 * one connection for the whole page, reconnected automatically.
 *
 * - `hello` / `resync` replace the status (a consistent state after a
 *   (re)connection or a slow period); events update it in order.
 * - Canvas events go to the canvas view's listeners (it keeps its own image).
 * - Attempts are de-duplicated by id and state (no visual duplicate).
 */

import { useSyncExternalStore } from 'react';
import type { AttemptSummary, EngineStatus, SchedulerState } from '../lib/engine';

type WsEvent =
  | { type: 'connector' }
  | { type: 'status'; status: EngineStatus }
  | { type: 'state'; from: SchedulerState; to: SchedulerState; reason: string | null }
  | { type: 'attempts'; attempts: AttemptSummary[]; dropped: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'notice'; level: string; message: string }
  | { type: 'canvas'; pixels: number[] }
  | { type: 'canvas-resync'; reason: string };

interface WsMessage {
  type: 'hello' | 'resync' | 'event' | 'pong';
  stream: string;
  seq: number;
  at: number;
  status: EngineStatus;
  event: WsEvent;
}

export type Connection = 'connecting' | 'open' | 'closed';

export interface EngineStore {
  readonly connection: Connection;
  readonly status: EngineStatus | null;
  readonly stream: string | null;
  readonly seq: number;
  readonly attempts: readonly AttemptSummary[];
  readonly errors: readonly { at: number; code: string; message: string }[];
  readonly notices: readonly { at: number; level: string; message: string }[];
}

export type CanvasMessage = { kind: 'pixels'; seq: number; stream: string; pixels: number[] } | { kind: 'resync'; reason: string };

let store: EngineStore = { connection: 'connecting', status: null, stream: null, seq: 0, attempts: [], errors: [], notices: [] };
const listeners = new Set<() => void>();
const canvasListeners = new Set<(m: CanvasMessage) => void>();
const connectorListeners = new Set<() => void>();
let socket: WebSocket | null = null;
let retryMs = 1000;
let started = false;

function set(next: Partial<EngineStore>): void {
  store = { ...store, ...next };
  for (const l of listeners) l();
}

function toCanvas(m: CanvasMessage): void {
  for (const l of canvasListeners) l(m);
}

function handle(message: WsMessage): void {
  if (message.type === 'hello' || message.type === 'resync') {
    const changedStream = store.stream !== null && store.stream !== message.stream;
    set({ status: message.status, stream: message.stream, seq: message.seq });
    if (message.type === 'resync' || changedStream) toCanvas({ kind: 'resync', reason: message.type === 'resync' ? 'resynchronisation' : 'server restarted' });
    return;
  }
  if (message.type !== 'event') return;
  const e = message.event;
  set({ seq: Math.max(store.seq, message.seq) });
  switch (e.type) {
    case 'connector':
      for (const listener of connectorListeners) listener();
      break;
    case 'status':
      set({ status: e.status });
      break;
    case 'state':
      if (store.status !== null) set({ status: { ...store.status, state: e.to, reason: e.reason } });
      break;
    case 'attempts': {
      const seen = new Set(store.attempts.map((a) => `${a.attemptId}:${a.state}`));
      const fresh = e.attempts.filter((a) => !seen.has(`${a.attemptId}:${a.state}`));
      set({ attempts: [...fresh.reverse(), ...store.attempts].slice(0, 50) });
      break;
    }
    case 'error':
      set({ errors: [{ at: message.at, code: e.code, message: e.message }, ...store.errors].slice(0, 20) });
      break;
    case 'notice':
      set({ notices: [{ at: message.at, level: e.level, message: e.message }, ...store.notices].slice(0, 20) });
      break;
    case 'canvas':
      toCanvas({ kind: 'pixels', seq: message.seq, stream: message.stream, pixels: e.pixels });
      break;
    case 'canvas-resync':
      toCanvas({ kind: 'resync', reason: e.reason });
      break;
  }
}

function connect(): void {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  set({ connection: 'connecting' });
  const ws = new WebSocket(`${protocol}://${window.location.host}/api/v1/ws`);
  socket = ws;
  ws.onopen = () => {
    retryMs = 1000;
    set({ connection: 'open' });
  };
  ws.onmessage = (ev) => {
    try {
      handle(JSON.parse(String(ev.data)));
    } catch {
      // ignore a malformed message
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    set({ connection: 'closed' });
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 10_000);
  };
}

function subscribe(listener: () => void): () => void {
  if (!started) {
    started = true;
    connect();
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = (): EngineStore => store;

export function useEngine(): EngineStore {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Canvas events (changed pixels, resynchronisation requests). */
export function onCanvas(listener: (m: CanvasMessage) => void): () => void {
  canvasListeners.add(listener);
  return () => canvasListeners.delete(listener);
}
export function onConnectorChange(listener: () => void): () => void {
  if (!started) { started = true; connect(); }
  connectorListeners.add(listener);
  return () => { connectorListeners.delete(listener); };
}

/**
 * Replaces the status after a command answered, unless the WebSocket
 * already delivered a newer one (sequence number): never a step back.
 */
export function applyStatus(status: EngineStatus): void {
  const current = store.status;
  if (current !== null && current.stream === status.stream && status.seq < current.seq) return;
  set({ status });
}
