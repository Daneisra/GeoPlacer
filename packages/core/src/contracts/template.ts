/**
 * Templates, their persisted metadata (PNG + JSON) and the strategy config.
 * Layer 2.
 */

import type { CoordinateSystem, TemplatePlacement } from './geometry.js';
import type { Palette } from './palette.js';
import type { ProjectId, Rgb, TemplateId, TemplatePixel, Timestamp } from './primitives.js';

/** Row-major, top-down: pixel (ix, iy) is pixels[iy * width + ix] (24-bit RGB or TRANSPARENT_U32). */
export interface TemplateImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint32Array;
}

export interface TemplateImageReader {
  /** Maps TRANSPARENT_U32 to TRANSPARENT. */
  pixelAt(image: TemplateImage, ix: number, iy: number): TemplatePixel;
}

export type DrawingStrategyId =
  | 'top-to-bottom'
  | 'bottom-to-top'
  | 'left-to-right'
  | 'right-to-left'
  | 'color-by-color'
  | 'outline-first'
  | 'center-out'
  | 'random';

export interface StrategyConfig {
  readonly id: DrawingStrategyId;
  /** Seed of the random strategy (deterministic, replayable). */
  readonly seed?: number;
  /** Explicit order for color-by-color. */
  readonly colorOrder?: readonly Rgb[];
}

export type TemplateStatus = 'active' | 'paused' | 'completed' | 'archived';

export interface Template {
  readonly id: TemplateId;
  readonly projectId: ProjectId;
  readonly name: string;
  /** Incremented on every image or placement change; attempts of older revisions are void. */
  readonly revision: number;
  readonly image: TemplateImage;
  readonly placement: TemplatePlacement;
  /**
   * Coordinate system in which `placement` is expressed. The canvas reader's
   * system is the reference; a different one is converted explicitly
   * (geometry/convertPlacement), never implicitly.
   */
  readonly coordinateSystem: CoordinateSystem;
  readonly palette: Palette;
  /** Higher first. */
  readonly priority: number;
  readonly status: TemplateStatus;
  readonly strategy: StrategyConfig;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export type TemplateInput = Pick<Template, 'projectId' | 'name' | 'image' | 'placement' | 'coordinateSystem' | 'palette' | 'priority' | 'strategy'>;
export type TemplatePatch = Partial<Pick<Template, 'name' | 'image' | 'placement' | 'coordinateSystem' | 'palette' | 'priority' | 'strategy'>>;

export interface TemplateManager {
  list(): readonly Template[];
  get(id: TemplateId): Template | undefined;
  create(input: TemplateInput): Template;
  /** Image, placement or coordinate-system changes bump the revision. */
  update(id: TemplateId, patch: TemplatePatch): Template;
  pause(id: TemplateId): Template;
  resume(id: TemplateId): Template;
  /** Forget progress history; the canvas stays the source of truth. */
  reset(id: TemplateId): Template;
}

// ───────────── Persisted metadata (template.json next to template.png) ─────────────

export const TEMPLATE_METADATA_SCHEMA_VERSION = 1;

/** JSON metadata stored next to the template PNG. */
export interface TemplateMetadataV1 {
  readonly schemaVersion: 1;
  readonly projectId: ProjectId;
  readonly templateId: TemplateId;
  readonly name: string;
  readonly revision: number;
  readonly image: {
    readonly width: number;
    readonly height: number;
    /** Lower-case hex SHA-256 of the PNG file; checked on load. */
    readonly pngSha256: string;
  };
  readonly placement: TemplatePlacement;
  /**
   * Coordinate system in which `placement` is expressed. The canvas reader's
   * system is the reference; a different one is converted explicitly
   * (geometry/convertPlacement), never implicitly.
   */
  readonly coordinateSystem: CoordinateSystem;
  readonly palette: Palette;
  readonly strategy: StrategyConfig;
  readonly priority: number;
  readonly status: TemplateStatus;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** Union of every supported schema version; the latest is the working shape. */
export type TemplateMetadata = TemplateMetadataV1;

export type MetadataParseResult =
  | { readonly ok: true; readonly metadata: TemplateMetadata; readonly migratedFrom?: number }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validation and migration of template metadata. Older schema versions are
 * migrated to the latest one; unknown or newer versions are rejected.
 */
export interface TemplateMetadataCodec {
  readonly latestVersion: number;
  parse(json: unknown): MetadataParseResult;
  serialize(metadata: TemplateMetadata): unknown;
}
