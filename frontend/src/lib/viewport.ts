/**
 * Canvas viewer geometry (Phase 1B.10): pure functions, tested apart.
 *
 * The viewer shows the template AREA in a square box of BOX screen pixels.
 * `zoom` = screen pixels per canvas pixel; at `fitZoom` the whole template is
 * visible. Below one screen pixel per canvas pixel the server samples one
 * canvas pixel out of `scale` in each direction (scale = floor(1 / zoom)),
 * so that a 4096 x 4096 template is shown WHOLE with about BOX² pixels.
 */

export interface Rect {
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
}

/** Center of the view (canvas coordinates) and zoom. */
export interface View {
  readonly zoom: number;
  readonly cx: number;
  readonly cy: number;
}

export const BOX = 512;
export const MAX_ZOOM = 16;

export function fitZoom(area: Rect, box = BOX): number {
  return Math.min(box / area.width, box / area.height);
}

export function fitView(area: Rect, box = BOX): View {
  return { zoom: fitZoom(area, box), cx: area.minX + area.width / 2, cy: area.minY + area.height / 2 };
}

/** Zoom within [fit, MAX_ZOOM]; center kept so that the visible part stays inside the area. */
export function clampView(area: Rect, view: View, box = BOX): View {
  const zoom = Math.min(MAX_ZOOM, Math.max(fitZoom(area, box), view.zoom));
  const halfW = Math.min(area.width, box / zoom) / 2;
  const halfH = Math.min(area.height, box / zoom) / 2;
  const cx = Math.min(area.minX + area.width - halfW, Math.max(area.minX + halfW, view.cx));
  const cy = Math.min(area.minY + area.height - halfH, Math.max(area.minY + halfH, view.cy));
  return { zoom, cx, cy };
}

/** The visible canvas rectangle (whole canvas pixels, inside the area). */
export function visibleRect(area: Rect, view: View, box = BOX): Rect {
  const width = Math.min(area.width, Math.ceil(box / view.zoom));
  const height = Math.min(area.height, Math.ceil(box / view.zoom));
  const minX = Math.min(area.minX + area.width - width, Math.max(area.minX, Math.round(view.cx - width / 2)));
  const minY = Math.min(area.minY + area.height - height, Math.max(area.minY, Math.round(view.cy - height / 2)));
  return { minX, minY, width, height };
}

/** Sampling of the server read for this zoom (1: every pixel). */
export function scaleFor(zoom: number): number {
  return zoom >= 1 ? 1 : Math.max(1, Math.floor(1 / zoom));
}

/** Multiplies the zoom, keeping the canvas point `focus` (default: the center) under the same screen point. */
export function zoomBy(area: Rect, view: View, factor: number, focus?: { x: number; y: number }, box = BOX): View {
  const next = clampView(area, { ...view, zoom: view.zoom * factor }, box);
  if (focus === undefined) return next;
  const ratio = view.zoom / next.zoom;
  return clampView(area, { zoom: next.zoom, cx: focus.x + (view.cx - focus.x) * ratio, cy: focus.y + (view.cy - focus.y) * ratio }, box);
}

/** Moves the view by screen pixels (a drag). */
export function panBy(area: Rect, view: View, dxScreen: number, dyScreen: number, yAxis: 'down' | 'up' = 'down', box = BOX): View {
  const dy = (yAxis === 'up' ? -dyScreen : dyScreen) / view.zoom;
  return clampView(area, { ...view, cx: view.cx - dxScreen / view.zoom, cy: view.cy - dy }, box);
}

/** A read (sampled region) as displayed. */
export interface Sampled {
  readonly rect: Rect;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  readonly yAxis: 'down' | 'up';
}

/**
 * Index in the displayed image of a changed canvas pixel (raster index of a
 * canvas `canvasWidth` wide), or -1 when not shown: outside the read, or not
 * one of its samples. Rows are flipped for a canvas whose y axis goes up.
 */
export function displayIndex(canvasIndex: number, canvasWidth: number, s: Sampled): number {
  const dx = (canvasIndex % canvasWidth) - s.rect.minX;
  const dy = Math.floor(canvasIndex / canvasWidth) - s.rect.minY;
  if (dx < 0 || dy < 0 || dx >= s.rect.width || dy >= s.rect.height || dx % s.scale !== 0 || dy % s.scale !== 0) return -1;
  const ox = dx / s.scale;
  const oy = dy / s.scale;
  return (s.yAxis === 'up' ? s.height - 1 - oy : oy) * s.width + ox;
}

/** Displayed row of a read row (flipped when y goes up). */
export function displayRow(row: number, height: number, yAxis: 'down' | 'up'): number {
  return yAxis === 'up' ? height - 1 - row : row;
}

/** True when the visible rectangle is the whole area. */
export function wholeAreaVisible(area: Rect, visible: Rect): boolean {
  return visible.minX === area.minX && visible.minY === area.minY && visible.width === area.width && visible.height === area.height;
}
