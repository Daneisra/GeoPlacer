/**
 * Canvas geometry and the image <-> canvas projection. Layer 1.
 */

export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

/** Axis-aligned rectangle: x in [minX, minX + width), y in [minY, minY + height), whatever the y direction. */
export interface CanvasRect {
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
}

/** Declared by each canvas: GeoPixels userscripts suggest y grows upward, Wplace tiles grow downward. */
export interface CoordinateSystem {
  readonly yAxis: 'down' | 'up';
  readonly bounds?: CanvasRect;
}

/** Image space: top-down, row-major. (0, 0) is the top-left pixel as seen on screen. */
export interface ImagePoint {
  readonly ix: number;
  readonly iy: number;
}

export interface TemplatePlacement {
  /** Canvas position of image pixel (0, 0). */
  readonly topLeft: CanvasPoint;
}

/** The single, tested projection between image space and canvas space. */
export interface Projection {
  imageToCanvas(point: ImagePoint, placement: TemplatePlacement, system: CoordinateSystem): CanvasPoint;
  canvasToImage(point: CanvasPoint, placement: TemplatePlacement, system: CoordinateSystem): ImagePoint;
  /** Canvas rectangle covered by an image of the given size. */
  bounds(size: { readonly width: number; readonly height: number }, placement: TemplatePlacement, system: CoordinateSystem): CanvasRect;
}
