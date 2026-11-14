export { GeometryError, type GeometryErrorCode } from './errors.js';
export {
  assertCanvasPoint,
  assertCoordinateSystem,
  assertImagePoint,
  assertRect,
  assertSafeInteger,
  assertSize,
  type ImageSize,
} from './validate.js';
export { rectArea, rectContains, rectContainsRect, rectEquals, rectIntersection, rectMaxX, rectMaxY } from './rect.js';
export {
  assertPlacement,
  canvasToImage,
  canvasXOf,
  canvasYOf,
  checkPlacement,
  imageToCanvas,
  imageXOf,
  imageYOf,
  locateInImage,
  placementTransform,
  projection,
  templateBounds,
  type PlacementCheck,
  type PlacementPolicy,
  type PlacementStatus,
  type PlacementTransform,
} from './projection.js';
export { applyCanvasTransform, canvasSystemTransform, convertPlacement, type CanvasTransform } from './system-transform.js';
