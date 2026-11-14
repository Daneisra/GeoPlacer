/**
 * Infrastructure ports used by the template manager. Layer 1.
 *
 * The core never touches files, Node APIs, crypto or PNG libraries itself:
 * adapters (packages/adapters-node, test doubles) implement these interfaces.
 */

import type { ProjectId, TemplateId, Timestamp } from './primitives.js';

/** SHA-256 provider. Returns 64 lower-case hexadecimal characters. */
export interface Hasher {
  sha256Hex(bytes: Uint8Array): Promise<string>;
}

/** Decoded image: RGBA 8-bit, row-major, top-down. */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array | Uint8ClampedArray;
}

export interface PngCodec {
  /** Library identifier and version (recorded for diagnostics). */
  readonly id: string;
  /** Decodes any valid PNG (palette, grey, 16-bit, interlaced) to RGBA 8-bit. */
  decode(bytes: Uint8Array): Promise<DecodedImage>;
  /** Encodes RGBA 8-bit pixels as a PNG. The bytes need not be deterministic. */
  encode(image: DecodedImage): Promise<Uint8Array>;
}

/** Generates new identifiers (randomness lives in the adapter, never in the core). */
export interface IdSource {
  newTemplateId(): TemplateId;
}

/** Raw manifest file contents: the current version and the previous valid one. */
export interface ManifestRead {
  readonly current: string | null;
  readonly backup: string | null;
}

/**
 * Storage of template manifests and immutable, content-addressed blobs.
 *
 * Publication rule: a new revision becomes visible only through ONE atomic
 * replacement of the manifest (writeManifest). Blobs are written first and
 * never modified afterwards (except to repair a corrupt copy of the same
 * content). An interrupted save therefore leaves either the old or the new
 * manifest, plus at most some orphan blobs.
 */
export interface TemplateStorage {
  readManifest(projectId: ProjectId, templateId: TemplateId): Promise<ManifestRead>;
  /**
   * Atomically replaces the manifest and keeps the previous one as backup.
   * Compare-and-swap: throws StorageConflictError (template module) when the
   * stored manifest's `generation` is not `expectedGeneration` (null = the
   * manifest must not exist yet).
   */
  writeManifest(projectId: ProjectId, templateId: TemplateId, json: string, expectedGeneration: number | null): Promise<void>;
  /**
   * Repair path only. Compare-and-swap on the raw text: throws
   * StorageConflictError unless the stored current manifest is exactly
   * `expectedCurrent` (null = absent). Preserves a copy of that file (when
   * present) under a new name for diagnosis, then atomically replaces the
   * current manifest. The backup is left untouched. Returns the name of the
   * preserved copy (null when there was no current file).
   */
  replaceManifest(projectId: ProjectId, templateId: TemplateId, json: string, expectedCurrent: string | null): Promise<string | null>;
  listTemplates(projectId: ProjectId): Promise<readonly TemplateId[]>;
  readBlob(projectId: ProjectId, address: string): Promise<Uint8Array | null>;
  /** Atomic write of a blob addressed by the SHA-256 of its bytes. */
  writeBlob(projectId: ProjectId, address: string, bytes: Uint8Array): Promise<void>;
}

/** Time source of the template manager. */
export interface TimeSource {
  now(): Timestamp;
}
