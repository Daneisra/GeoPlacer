import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui';
import { decodeInt32, engineHttp, formatTime, type CanvasRegion, type EngineStatus } from '../../lib/engine';
import { onCanvas, type CanvasMessage } from '../../hooks/useEngine';

type PixelsMessage = Extract<CanvasMessage, { kind: 'pixels' }>;

const EMPTY: [number, number, number] = [30, 30, 46];
const UNKNOWN: [number, number, number] = [70, 20, 20];
const DISPLAY = 512;

function paint(data: Uint8ClampedArray, o: number, value: number): void {
  const [r, g, b] = value === -1 ? EMPTY : value === -2 ? UNKNOWN : [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  data[o] = r;
  data[o + 1] = g;
  data[o + 2] = b;
  data[o + 3] = 255;
}

/**
 * The simulated canvas over the selected template's area. One snapshot is
 * read over HTTP (with the sequence number it includes); afterwards only
 * the changed pixels arrive, grouped, over the WebSocket, and are drawn at
 * the next animation frame. Never a full 4096² image per operation.
 */
export function CanvasView({ status }: { status: EngineStatus | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<ImageData | null>(null);
  const regionRef = useRef<CanvasRegion | null>(null);
  const frameRef = useRef<number | null>(null);
  /** Pixel events received while a snapshot loads: replayed on top of it if newer. */
  const bufferRef = useRef<PixelsMessage[] | null>(null);
  const widthRef = useRef(0);
  const [meta, setMeta] = useState<{ rect: CanvasRegion['rect']; at: number; seq: number } | null>(null);
  const [overlay, setOverlay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasWidth = status?.settings.simulator.width ?? 0;
  const selection = status?.selection ?? null;
  useEffect(() => {
    widthRef.current = canvasWidth;
  }, [canvasWidth]);
  const worldKey = `${selection?.templateId ?? ''}:${selection?.revision ?? 0}:${status?.settings.simulator.rulesVersion ?? 0}:${status?.stream ?? ''}`;

  const draw = useCallback(() => {
    frameRef.current = null;
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx && imageRef.current) ctx.putImageData(imageRef.current, 0, 0);
  }, []);

  const schedule = useCallback(() => {
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(draw);
  }, [draw]);

  /** Applies changed pixels newer than the snapshot; false when the server restarted. */
  const apply = useCallback(
    (m: PixelsMessage): boolean => {
      const region = regionRef.current;
      const image = imageRef.current;
      const canvasWidthNow = widthRef.current;
      if (region === null || image === null || canvasWidthNow === 0) return true;
      if (m.stream !== region.stream) return false;
      if (m.seq <= region.seq) return true;
      const { minX, minY, width, height } = region.rect;
      for (let k = 0; k < m.pixels.length; k += 2) {
        const index = m.pixels[k]!;
        const x = (index % canvasWidthNow) - minX;
        const y = Math.floor(index / canvasWidthNow) - minY;
        if (x >= 0 && y >= 0 && x < width && y < height) paint(image.data, (y * width + x) * 4, m.pixels[k + 1]!);
      }
      schedule();
      return true;
    },
    [schedule]
  );

  /** Installs a snapshot, then replays the pixel events received while it loaded. */
  const install = useCallback(
    (region: CanvasRegion) => {
      const values = decodeInt32(region.data);
      const { width, height } = region.rect;
      const image = new ImageData(width, height);
      for (let i = 0; i < values.length; i++) paint(image.data, i * 4, values[i]!);
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = width;
        canvas.height = height;
      }
      imageRef.current = image;
      regionRef.current = region;
      setMeta({ rect: region.rect, at: region.observedAt, seq: region.seq });
      setError(null);
      const buffered = bufferRef.current ?? [];
      bufferRef.current = null;
      for (const m of buffered) apply(m);
      schedule();
    },
    [apply, schedule]
  );

  const load = useCallback((): Promise<void> => {
    if (bufferRef.current !== null) return Promise.resolve();
    bufferRef.current = [];
    return engineHttp.get<CanvasRegion>('/simulator/canvas').then(
      (r) => install(r.data),
      () => {
        bufferRef.current = null;
        setError('Toile simulée indisponible.');
      }
    );
  }, [install]);

  // (Re)load on a new template, revision, world or server.
  useEffect(() => {
    // worldKey: a new template, revision, world or server needs a new snapshot.
    void worldKey;
    if (bufferRef.current !== null) return;
    bufferRef.current = [];
    void engineHttp.get<CanvasRegion>('/simulator/canvas').then(
      (r) => install(r.data),
      () => {
        bufferRef.current = null;
        setError('Toile simulée indisponible.');
      }
    );
  }, [install, worldKey]);

  // Changed pixels, grouped by the server; snapshot-included ones are skipped.
  useEffect(
    () =>
      onCanvas((m) => {
        if (m.kind === 'resync') {
          void load();
          return;
        }
        if (bufferRef.current !== null) {
          bufferRef.current.push(m);
          return;
        }
        if (!apply(m)) void load();
      }),
    [apply, load]
  );

  // Template overlay (quantized image of the current revision).
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!overlay || selection === null || canvas === null) return;
    let cancelled = false;
    void engineHttp.get<{ width: number; height: number; data: string }>(`/templates/${selection.templateId}/image`).then((r) => {
      if (cancelled) return;
      const values = decodeInt32(r.data.data);
      const image = new ImageData(r.data.width, r.data.height);
      for (let i = 0; i < values.length; i++) if (values[i] !== -1) paint(image.data, i * 4, values[i]!);
      canvas.width = r.data.width;
      canvas.height = r.data.height;
      canvas.getContext('2d')?.putImageData(image, 0, 0);
    });
    return () => {
      cancelled = true;
    };
  }, [overlay, selection]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const rect = meta?.rect;
  const scale = rect === undefined ? 1 : Math.max(1, Math.min(8, Math.floor(DISPLAY / Math.max(rect.width, rect.height))));
  const displayWidth = rect === undefined ? DISPLAY : Math.min(DISPLAY, rect.width * scale);
  const displayHeight = rect === undefined ? DISPLAY : (displayWidth / rect.width) * rect.height;
  return (
    <Card id="canvasView">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Toile simulée</CardTitle>
        <p className="text-xs text-muted-foreground">
          {rect === undefined ? '—' : `Zone ${rect.width}×${rect.height} à (${rect.minX}, ${rect.minY}) · lue à ${formatTime(meta!.at)} puis mise à jour par lots`}
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {error !== null && <p className="text-sm text-red-300">{error}</p>}
        <div className="relative" style={{ width: displayWidth, height: displayHeight }}>
          <canvas ref={canvasRef} id="simCanvas" style={{ width: displayWidth, height: displayHeight, imageRendering: 'pixelated' }} className="rounded border" />
          <canvas
            ref={overlayRef}
            style={{ position: 'absolute', inset: 0, width: displayWidth, height: displayHeight, imageRendering: 'pixelated', opacity: 0.35, display: overlay ? 'block' : 'none', pointerEvents: 'none' }}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} disabled={selection === null} />
          Superposer le modèle
        </label>
        <p className="text-xs text-muted-foreground">Fond sombre : pixel vide. Rouge foncé : hors de la toile.</p>
      </CardContent>
    </Card>
  );
}
