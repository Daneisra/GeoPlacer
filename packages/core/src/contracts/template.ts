/**
 * Templates, their persisted manifest (PNG blobs + JSON) and the template
 * manager API. Layer 2.
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

/** How source pixels were mapped to the palette. Part of a revision's identity. */
export interface QuantizationMethod {
  readonly algorithm: 'nearest-color';
  /** ColorDistance id ('oklab' by default). */
  readonly distance: string;
  readonly version: 1;
}

/** A template revision loaded in memory (image included). */
export interface Template {
  readonly id: TemplateId;
  readonly projectId: ProjectId;
  readonly name: string;
  /** Immutable revision; attempts of older revisions are void. */
  readonly revision: number;
  readonly image: TemplateImage;
  readonly placement: TemplatePlacement;
  /**
   * Coordinate system in which `placement` is expressed. The canvas reader's
   * system is the reference; a different one is converted explicitly
   * (geometry/convertPlacement), never implicitly.
   */
  readonly coordinateSystem: CoordinateSystem;
  /** Reference palette used for quantization (its order breaks ties). */
  readonly palette: Palette;
  readonly alphaThreshold: number;
  readonly quantization: QuantizationMethod;
  /** Higher first. */
  readonly priority: number;
  readonly status: TemplateStatus;
  readonly strategy: StrategyConfig;
  readonly sourceImageHash: string;
  readonly quantizedImageHash: string;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  /** Derived on every load (never persisted): e.g. a placement that crosses the canvas bounds. */
  readonly warnings: readonly TemplateWarning[];
}

/**
 * Non-blocking condition the user must see. Derived from the revision, never
 * stored in the manifest.
 */
export interface TemplateWarning {
  /** The template crosses the canvas bounds: its outside pixels are never painted. */
  readonly code: 'PLACEMENT_PARTIALLY_OUTSIDE';
  /** Template pixels (transparent ones included) outside the canvas bounds. */
  readonly pixelsOutside: number;
  readonly message: string;
}

// ───────────────────────── Persisted manifest (schema v1) ─────────────────────────

export const TEMPLATE_MANIFEST_SCHEMA_VERSION = 1;

/** Why a revision was created (several reasons can apply at once). */
export type RevisionReason =
  | 'created'
  | 'source-image'
  | 'palette'
  | 'alpha-threshold'
  | 'quantization'
  | 'placement'
  | 'coordinate-system'
  | 'restored'
  | 'duplicated';

export interface QuantizationStats {
  readonly pixels: number;
  readonly transparent: number;
  readonly exact: number;
  readonly approximated: number;
}

/** Immutable once published: never rewritten, never removed automatically. */
export interface RevisionRecordV1 {
  readonly revision: number;
  readonly createdAt: Timestamp;
  readonly reasons: readonly RevisionReason[];
  /** Revision this one was derived from (null for the first revision). */
  readonly basedOn: number | null;
  readonly width: number;
  readonly height: number;
  readonly placement: TemplatePlacement;
  readonly coordinateSystem: CoordinateSystem;
  readonly palette: Palette;
  readonly alphaThreshold: number;
  readonly quantizationMethod: QuantizationMethod;
  /** SHA-256 of the source PNG bytes; also the address of the source blob. */
  readonly sourceImageHash: string;
  /** SHA-256 of the canonical serialization of the quantized pixels (see template/pixels). */
  readonly quantizedImageHash: string;
  /** SHA-256 of the stored quantized PNG bytes; the address of that blob. */
  readonly quantizedFileHash: string;
  readonly stats: QuantizationStats;
  /** Forward-compatible data of future v1 code, preserved verbatim; empty for new revisions. */
  readonly extensions: Readonly<Record<string, unknown>>;
}

/**
 * One JSON file per template. Mutable settings (name, strategy, priority,
 * status) live at the top level; revisions are append-only records.
 * Forward compatibility: optional data added by future v1 code goes into
 * `extensions` (manifest or revision), which readers preserve verbatim; any
 * other unknown field is rejected (a newer layout needs schemaVersion 2).
 */
export interface TemplateManifestV1 {
  readonly schemaVersion: 1;
  readonly projectId: ProjectId;
  readonly templateId: TemplateId;
  /** Incremented on every write; checked by the storage (compare-and-swap). */
  readonly generation: number;
  readonly name: string;
  readonly drawingStrategy: StrategyConfig;
  readonly priority: number;
  readonly status: TemplateStatus;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  /** Controlled deletion: a tombstone, files are kept. */
  readonly deletedAt: Timestamp | null;
  readonly currentRevision: number;
  readonly revisions: readonly RevisionRecordV1[];
  readonly extensions: Readonly<Record<string, unknown>>;
}

/** Union of supported schema versions; the latest is the working shape. */
export type TemplateManifest = TemplateManifestV1;

// ───────────────────────── Template manager API ─────────────────────────

export interface TemplateRef {
  readonly projectId: ProjectId;
  readonly templateId: TemplateId;
}

export interface CreateTemplateInput {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly sourcePng: Uint8Array;
  readonly palette: Palette;
  readonly placement: TemplatePlacement;
  readonly coordinateSystem: CoordinateSystem;
  /** Default 128: alpha < threshold is transparent. */
  readonly alphaThreshold?: number;
  /** Default: nearest color in OKLab. */
  readonly quantization?: QuantizationMethod;
  /** Default: top-to-bottom. */
  readonly strategy?: StrategyConfig;
  /** Default 0. */
  readonly priority?: number;
}

/** Changes that create a new revision when they differ from the current one. */
export interface RevisionChange {
  readonly sourcePng?: Uint8Array;
  readonly palette?: Palette;
  readonly alphaThreshold?: number;
  readonly quantization?: QuantizationMethod;
  readonly placement?: TemplatePlacement;
  readonly coordinateSystem?: CoordinateSystem;
}

/** Changes that never create a revision. */
export interface SettingsPatch {
  readonly name?: string;
  readonly strategy?: StrategyConfig;
  readonly priority?: number;
}

export interface TemplateSummary {
  readonly projectId: ProjectId;
  readonly templateId: TemplateId;
  readonly name: string;
  readonly currentRevision: number;
  readonly revisionCount: number;
  readonly width: number;
  readonly height: number;
  /** Non-transparent pixels of the current revision (0 for a fully transparent image). */
  readonly paintablePixels: number;
  readonly status: TemplateStatus;
  readonly priority: number;
  readonly strategy: StrategyConfig;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  /** 'backup' when the current manifest was unreadable and the previous generation was listed instead. */
  readonly manifestSource: 'current' | 'backup';
  readonly warnings: readonly TemplateWarning[];
}

/**
 * A template that could not be listed. Identifies the template without
 * exposing its content: fixed message, no file path, no manifest data.
 */
export interface TemplateListFailure {
  readonly templateId: TemplateId;
  /**
   * INVALID_MANIFEST: neither the manifest nor its backup is valid;
   * UNSUPPORTED_SCHEMA: written by a newer GeoPlacer; READ_ERROR: the storage failed.
   */
  readonly code: 'INVALID_MANIFEST' | 'UNSUPPORTED_SCHEMA' | 'READ_ERROR';
  readonly message: string;
}

/** One unreadable template never hides the others. */
export interface TemplateListing {
  readonly templates: readonly TemplateSummary[];
  readonly failures: readonly TemplateListFailure[];
}

export interface RepairOptions {
  /** false: diagnosis only, nothing is written. true: performs the repair. */
  readonly apply: boolean;
}

export interface RepairReport {
  /**
   * 'none': the current manifest is valid, nothing to repair.
   * 'restore-backup': the missing or malformed current manifest is (or would
   * be) replaced by the valid backup.
   */
  readonly action: 'none' | 'restore-backup';
  readonly applied: boolean;
  /** Fixed description of the problem found (no manifest content). */
  readonly problem: string | null;
  /** Generation and current revision of the repaired (or proposed) manifest. */
  readonly generation: number;
  readonly currentRevision: number;
  /** Storage name of the preserved corrupt manifest (null: nothing to preserve, or not applied). */
  readonly preservedAs: string | null;
}

export interface LoadOptions {
  /** Load this revision exactly; an invalid one is an error, never a fallback. */
  readonly revision?: number;
  /**
   * When loading the current revision: fall back to the latest revision that
   * verifies (and to the backup manifest). Read-only: nothing is rewritten.
   */
  readonly recover?: boolean;
}

export interface LoadReport {
  readonly requestedRevision: number | 'current';
  readonly loadedRevision: number;
  readonly manifestSource: 'current' | 'backup';
  /** What failed before the loaded revision was found (empty when nothing failed). */
  readonly problems: readonly string[];
}

export interface LoadedTemplate {
  readonly template: Template;
  readonly report: LoadReport;
}

export interface RevisionResult {
  readonly template: Template;
  /** False when the change was a no-op (nothing differs): no revision is created. */
  readonly created: boolean;
  readonly reasons: readonly RevisionReason[];
}

export interface RevisionCheck {
  readonly revision: number;
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export interface VerifyReport {
  readonly manifestSource: 'current' | 'backup';
  readonly currentRevision: number;
  readonly revisions: readonly RevisionCheck[];
}

export interface TemplateManager {
  create(input: CreateTemplateInput): Promise<Template>;
  load(ref: TemplateRef, options?: LoadOptions): Promise<LoadedTemplate>;
  /** Validated metadata of a template (no image decoding). */
  manifest(ref: TemplateRef): Promise<TemplateManifest>;
  /** Templates of one project (deleted ones excluded); unreadable ones are reported apart. */
  list(projectId: ProjectId): Promise<TemplateListing>;
  /** New revision for content changes; a no-op change creates nothing. */
  revise(ref: TemplateRef, change: RevisionChange): Promise<RevisionResult>;
  /** New revision whose content copies an older one (history is never rewritten). */
  restoreRevision(ref: TemplateRef, revision: number): Promise<RevisionResult>;
  /** Name, strategy, priority: no new revision. */
  updateSettings(ref: TemplateRef, patch: SettingsPatch): Promise<TemplateSummary>;
  setStatus(ref: TemplateRef, status: TemplateStatus): Promise<TemplateSummary>;
  /** Copy of the current revision under a new id (optionally in another project). */
  duplicate(ref: TemplateRef, options: { readonly name: string; readonly projectId?: ProjectId }): Promise<Template>;
  /** Controlled deletion: requires the template name; files are kept (tombstone). */
  delete(ref: TemplateRef, options: { readonly confirmName: string }): Promise<void>;
  /** Re-reads and re-hashes every blob of every revision (read-only). */
  verify(ref: TemplateRef): Promise<VerifyReport>;
  /**
   * Explicit repair of a missing or malformed current manifest from its valid
   * backup. Never touches a manifest of a newer schema; preserves the corrupt
   * file for diagnosis; leaves the backup untouched. `apply: false` only
   * reports what would be done.
   */
  repair(ref: TemplateRef, options: RepairOptions): Promise<RepairReport>;
}
