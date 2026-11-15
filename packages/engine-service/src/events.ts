/**
 * Event stream of the service (Phase 1B.9), for the WebSocket and any
 * other transport. Independent of the attempt journal: losing an event
 * never loses a state, a client resynchronises from `status()` and a
 * canvas snapshot.
 *
 * - Every event carries a sequence number (increasing, per process; a new
 *   process starts a new `stream` id).
 * - `state` and `error` are sent at once; attempts are grouped; the status
 *   (progress, energy, ETA) is sent at most every `intervalMs`.
 * - Canvas changes are accumulated (last value per pixel) and sent as one
 *   `canvas` event per interval. Beyond `maxCanvasPixels` changed pixels,
 *   a `canvas-resync` asks the clients to read a snapshot instead: never one
 *   message per pixel.
 * - A listener that throws is ignored (it never stops the engine).
 */

import { randomUUID } from 'node:crypto';

export interface EngineEventEnvelope {
  readonly stream: string;
  readonly seq: number;
  readonly at: number;
  readonly event: EngineEvent;
}

export type EngineEvent =
  | { readonly type: 'state'; readonly from: string; readonly to: string; readonly reason: string | null }
  | { readonly type: 'status'; readonly status: unknown }
  | { readonly type: 'attempts'; readonly attempts: readonly AttemptEventSummary[]; readonly dropped: number }
  | { readonly type: 'error'; readonly code: string; readonly message: string }
  | { readonly type: 'canvas'; readonly pixels: readonly number[] }
  | { readonly type: 'canvas-resync'; readonly reason: string }
  | { readonly type: 'notice'; readonly level: 'info' | 'warning'; readonly message: string };

export interface AttemptEventSummary {
  readonly attemptId: string;
  readonly state: string;
  readonly pixels: number;
  readonly applied: number;
  readonly at: number;
}

export interface EventHubOptions {
  readonly intervalMs?: number;
  readonly maxCanvasPixels?: number;
  readonly maxAttemptsPerEvent?: number;
  readonly now?: () => number;
}

export class EngineEventHub {
  readonly stream = randomUUID();
  private seqValue = 0;
  private readonly listeners = new Set<(e: EngineEventEnvelope) => void>();
  private readonly intervalMs: number;
  private readonly maxCanvasPixels: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;
  private pendingStatus: unknown = undefined;
  private pendingAttempts: AttemptEventSummary[] = [];
  private droppedAttempts = 0;
  private readonly pendingCanvas = new Map<number, number>();
  private canvasOverflow = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(options: EventHubOptions = {}) {
    this.intervalMs = options.intervalMs ?? 250;
    this.maxCanvasPixels = options.maxCanvasPixels ?? 20_000;
    this.maxAttempts = options.maxAttemptsPerEvent ?? 50;
    this.now = options.now ?? Date.now;
  }

  /** Last sequence number sent (a snapshot taken now is at least this recent). */
  get seq(): number {
    return this.seqValue;
  }

  subscribe(listener: (e: EngineEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get subscribers(): number {
    return this.listeners.size;
  }

  private emit(event: EngineEvent): void {
    if (this.closed) return;
    const envelope: EngineEventEnvelope = { stream: this.stream, seq: ++this.seqValue, at: this.now(), event };
    for (const l of this.listeners) {
      try {
        l(envelope);
      } catch {
        // A failing listener never stops the engine.
      }
    }
  }

  private schedule(): void {
    if (this.timer !== null || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Sends what is pending now (grouped attempts, canvas changes, latest status). */
  flush(): void {
    if (this.pendingAttempts.length > 0 || this.droppedAttempts > 0) {
      this.emit({ type: 'attempts', attempts: this.pendingAttempts, dropped: this.droppedAttempts });
      this.pendingAttempts = [];
      this.droppedAttempts = 0;
    }
    if (this.canvasOverflow) {
      this.emit({ type: 'canvas-resync', reason: `more than ${this.maxCanvasPixels} pixels changed in ${this.intervalMs} ms` });
      this.canvasOverflow = false;
      this.pendingCanvas.clear();
    } else if (this.pendingCanvas.size > 0) {
      const pixels: number[] = [];
      for (const [index, color] of this.pendingCanvas) pixels.push(index, color);
      this.pendingCanvas.clear();
      this.emit({ type: 'canvas', pixels });
    }
    if (this.pendingStatus !== undefined) {
      const status = this.pendingStatus;
      this.pendingStatus = undefined;
      this.emit({ type: 'status', status });
    }
  }

  state(from: string, to: string, reason: string | null): void {
    // A state change carries the status right after it: send what is pending first, in order.
    this.flush();
    this.emit({ type: 'state', from, to, reason });
  }

  error(code: string, message: string): void {
    this.emit({ type: 'error', code, message });
  }

  notice(level: 'info' | 'warning', message: string): void {
    this.emit({ type: 'notice', level, message });
  }

  status(status: unknown): void {
    this.pendingStatus = status;
    this.schedule();
  }

  attempt(summary: AttemptEventSummary): void {
    if (this.pendingAttempts.length < this.maxAttempts) this.pendingAttempts.push(summary);
    else this.droppedAttempts++;
    this.schedule();
  }

  /** Changed pixels as raster indices (last value wins). */
  canvas(pixels: readonly { readonly index: number; readonly color: number }[]): void {
    if (this.canvasOverflow) return;
    for (const p of pixels) this.pendingCanvas.set(p.index, p.color);
    if (this.pendingCanvas.size > this.maxCanvasPixels) {
      this.canvasOverflow = true;
      this.pendingCanvas.clear();
    }
    this.schedule();
  }

  /** Asks the clients to read a snapshot (world reset, restored world). */
  canvasResync(reason: string): void {
    this.pendingCanvas.clear();
    this.canvasOverflow = false;
    this.emit({ type: 'canvas-resync', reason });
  }

  close(): void {
    this.flush();
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}
