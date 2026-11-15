import { useCallback, useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '../ui';
import { decodeInt32, engineHttp, formatTime, type CanvasRegion, type EngineStatus } from '../../lib/engine';
import { onCanvas, type CanvasMessage } from '../../hooks/useEngine';
import { BOX, MAX_ZOOM, displayIndex, displayRow, fitView, fitZoom, panBy, scaleFor, visibleRect, wholeAreaVisible, zoomBy, type Rect, type View } from '../../lib/viewport';

type PixelsMessage = Extract<CanvasMessage, { kind: 'pixels' }>;

const EMPTY: [number, number, number] = [30, 30, 46];
const UNKNOWN: [number, number, number] = [70, 20, 20];

function paint(data: Uint8ClampedArray, o: number, value: number): void {
  const [r, g, b] = value === -1 ? EMPTY : value === -2 ? UNKNOWN : [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  data[o] = r;
  data[o + 1] = g;
  data[o + 2] = b;
  data[o + 3] = 255;
}

/** Decoded read as an image, rows flipped when the canvas y axis goes up. */
function toImage(values: Int32Array, width: number, height: number, yAxis: 'down' | 'up', transparentSkip = false): ImageData {
  const image = new ImageData(width, height);
  for (let row = 0; row < height; row++) {
    const target = displayRow(row, height, yAxis) * width;
    for (let x = 0; x < width; x++) {
      const v = values[row * width + x]!;
      if (transparentSkip && v === -1) continue;
      paint(image.data, (target + x) * 4, v);
    }
  }
  return image;
}

/**
 * The simulated canvas over the selected template's area (Phase 1B.10:
 * whole up to 4096 x 4096, zoom and pan). Only the visible part is read, at
 * the scale of the screen (one canvas pixel out of `scale` below one screen
 * pixel per canvas pixel); afterwards the changed pixels arrive grouped
 * over the WebSocket and are drawn at the next animation frame.
 */
export function CanvasView({ status }: { status: EngineStatus | null }) {
  const sim = status?.settings.simulator;
  const selection = status?.selection ?? null;
  const area: Rect | null =
    selection !== null && selection.placement !== null
      ? { minX: selection.placement.x, minY: selection.placement.y, width: selection.width, height: selection.height }
      : sim !== undefined
        ? { minX: 0, minY: 0, width: sim.width, height: sim.height }
        : null;
  if (area === null || status === null) {
    return (
      <Card id="canvasView">
        <CardContent className="p-6 text-muted-foreground">Toile simulée : en attente du moteur…</CardContent>
      </Card>
    );
  }
  // A new area (template, revision, size) starts a new viewport (zoom reset to the whole template).
  const areaKey = `${selection?.templateId ?? 'canvas'}:${selection?.revision ?? 0}:${area.minX}:${area.minY}:${area.width}:${area.height}`;
  return <CanvasViewport key={areaKey} area={area} status={status} />;
}

function CanvasViewport({ area, status }: { area: Rect; status: EngineStatus }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<ImageData | null>(null);
  const regionRef = useRef<CanvasRegion | null>(null);
  const frameRef = useRef<number | null>(null);
  /** Pixel events received while a read loads: replayed on top of it if newer. */
  const bufferRef = useRef<PixelsMessage[] | null>(null);
  const widthRef = useRef(0);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [view, setView] = useState<View>(() => fitView(area));
  const [meta, setMeta] = useState<{ rect: Rect; scale: number; at: number; yAxis: 'down' | 'up' } | null>(null);
  const [overlay, setOverlay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const canvasWidth = status.settings.simulator.width;
  const selection = status.selection;
  const yAxis = meta?.yAxis ?? 'down';
  useEffect(() => {
    widthRef.current = canvasWidth;
  }, [canvasWidth]);

  const visible = visibleRect(area, view);
  const scale = scaleFor(view.zoom);
  const { minX: vx, minY: vy, width: vw, height: vh } = visible;
  const rulesVersion = status.settings.simulator.rulesVersion;
  const stream = status.stream;
  const templateId = selection?.templateId ?? null;
  const revision = selection?.revision ?? 0;

  const draw = useCallback(() => {
    frameRef.current = null;
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx && imageRef.current) ctx.putImageData(imageRef.current, 0, 0);
  }, []);
  const schedule = useCallback(() => {
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(draw);
  }, [draw]);

  /** Applies changed pixels newer than the read; false when the server restarted. */
  const apply = useCallback(
    (m: PixelsMessage): boolean => {
      const region = regionRef.current;
      const image = imageRef.current;
      if (region === null || image === null || widthRef.current === 0) return true;
      if (m.stream !== region.stream) return false;
      if (m.seq <= region.seq) return true;
      for (let k = 0; k < m.pixels.length; k += 2) {
        const i = displayIndex(m.pixels[k]!, widthRef.current, region);
        if (i >= 0) paint(image.data, i * 4, m.pixels[k + 1]!);
      }
      schedule();
      return true;
    },
    [schedule]
  );

  const install = useCallback(
    (region: CanvasRegion) => {
      const image = toImage(decodeInt32(region.data), region.width, region.height, region.yAxis);
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = region.width;
        canvas.height = region.height;
      }
      imageRef.current = image;
      regionRef.current = region;
      setMeta({ rect: region.rect, scale: region.scale, at: region.observedAt, yAxis: region.yAxis });
      setError(null);
      const buffered = bufferRef.current ?? [];
      bufferRef.current = null;
      for (const m of buffered) apply(m);
      schedule();
    },
    [apply, schedule]
  );

  // Reads the visible part at the screen's scale (debounced while zooming or dragging); again on a
  // new world (rules version), a new server (stream) or a resynchronisation request (reloads).
  useEffect(() => {
    const query = `x=${vx}&y=${vy}&w=${vw}&h=${vh}&s=${scale}`;
    let cancelled = false;
    const timer = setTimeout(() => {
      bufferRef.current = [];
      void engineHttp.get<CanvasRegion>(`/simulator/canvas?${query}`).then(
        (r) => {
          if (!cancelled) install(r.data);
          else bufferRef.current = null;
        },
        () => {
          bufferRef.current = null;
          if (!cancelled) setError('Toile simulée indisponible.');
        }
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [vx, vy, vw, vh, scale, rulesVersion, stream, reloads, install]);

  // Changed pixels grouped by the server; a resynchronisation re-reads the visible part.
  useEffect(
    () =>
      onCanvas((m) => {
        if (m.kind === 'resync') {
          setReloads((n) => n + 1);
          return;
        }
        if (bufferRef.current !== null) {
          bufferRef.current.push(m);
          return;
        }
        if (!apply(m)) setReloads((n) => n + 1);
      }),
    [apply]
  );

  // Template overlay: the same rectangle and scale (aligned pixel for pixel).
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!overlay || templateId === null || canvas === null) return;
    let cancelled = false;
    // A new revision (revision in the dependencies) is read again.
    const query = `x=${vx}&y=${vy}&w=${vw}&h=${vh}&s=${scale}`;
    void engineHttp.get<{ outWidth: number; outHeight: number; data: string }>(`/templates/${templateId}/image?${query}`).then((r) => {
      if (cancelled) return;
      canvas.width = r.data.outWidth;
      canvas.height = r.data.outHeight;
      canvas.getContext('2d')?.putImageData(toImage(decodeInt32(r.data.data), r.data.outWidth, r.data.outHeight, yAxis, true), 0, 0);
    });
    return () => {
      cancelled = true;
    };
  }, [overlay, templateId, revision, vx, vy, vw, vh, scale, yAxis]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  // Screen geometry: the visible rectangle at the zoom, centered in the box.
  const cssW = visible.width * view.zoom;
  const cssH = visible.height * view.zoom;
  const left = (BOX - cssW) / 2;
  const top = (BOX - cssH) / 2;
  const toCanvas = (clientX: number, clientY: number, box: DOMRect) => {
    const sx = (clientX - box.left - left) / view.zoom;
    const sy = (clientY - box.top - top) / view.zoom;
    return { x: visible.minX + sx, y: yAxis === 'up' ? visible.minY + visible.height - sy : visible.minY + sy };
  };
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const focus = toCanvas(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
    setView((v) => zoomBy(area, v, e.deltaY < 0 ? 1.25 : 0.8, focus));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    dragRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d === null) return;
    dragRef.current = { x: e.clientX, y: e.clientY };
    setView((v) => panBy(area, v, e.clientX - d.x, e.clientY - d.y, yAxis));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };
  const whole = wholeAreaVisible(area, visible);
  const zoomText = view.zoom >= 1 ? `×${Math.round(view.zoom * 10) / 10}` : `1:${Math.round(10 / view.zoom) / 10}`;

  return (
    <Card id="canvasView">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Toile simulée</CardTitle>
        <p className="text-xs text-muted-foreground" id="canvasInfo">
          {whole
            ? `Modèle entier affiché : ${area.width} × ${area.height} à (${area.minX}, ${area.minY})`
            : `Zone visible : x ${visible.minX} à ${visible.minX + visible.width - 1}, y ${visible.minY} à ${visible.minY + visible.height - 1} sur ${area.width} × ${area.height} (déplacez ou dézoomez pour voir le reste)`}
          {` · zoom ${zoomText}`}
          {meta !== null && meta.scale > 1 ? ` · 1 pixel sur ${meta.scale} affiché` : ''}
          {meta !== null ? ` · lue à ${formatTime(meta.at)} puis mise à jour par lots` : ''}
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {error !== null && <p className="text-sm text-red-300">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setView(fitView(area))} id="zoomFit">
            Ajuster
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setView((v) => zoomBy(area, v, 2))} disabled={view.zoom >= MAX_ZOOM} id="zoomIn">
            Zoom +
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setView((v) => zoomBy(area, v, 0.5))} disabled={view.zoom <= fitZoom(area) + 1e-9} id="zoomOut">
            Zoom −
          </Button>
        </div>
        <div
          id="canvasBox"
          className="relative overflow-hidden rounded border bg-black/40"
          style={{ width: BOX, height: BOX, maxWidth: '100%', touchAction: 'none', cursor: whole ? 'default' : 'grab' }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          <canvas ref={canvasRef} id="simCanvas" style={{ position: 'absolute', left, top, width: cssW, height: cssH, imageRendering: 'pixelated' }} />
          <canvas
            ref={overlayRef}
            style={{ position: 'absolute', left, top, width: cssW, height: cssH, imageRendering: 'pixelated', opacity: 0.35, display: overlay ? 'block' : 'none', pointerEvents: 'none' }}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} disabled={selection === null} />
          Superposer le modèle
        </label>
        <p className="text-xs text-muted-foreground">Molette : zoom · glisser : déplacer · fond sombre : pixel vide · rouge foncé : hors de la toile.</p>
      </CardContent>
    </Card>
  );
}
