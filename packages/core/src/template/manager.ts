/**
 * TemplateManager: pure orchestration over the storage, hashing, PNG codec,
 * id and clock ports (no Node.js, no filesystem).
 *
 * Write protocol (every mutation):
 *   1. content-addressed blobs (SHA-256 of their bytes) are written first;
 *      an existing blob is re-hashed, a corrupt one is replaced;
 *   2. every blob the new manifest references is read back and re-hashed;
 *   3. the manifest is published by ONE storage call (atomic replace,
 *      compare-and-swap on `generation`): the single commit point.
 * An interruption before 3 leaves the previous manifest untouched (orphan
 * blobs at worst); after 3 the new revision is complete. Blobs and published
 * revision records are never modified or removed.
 *
 * Loading never re-quantizes: it reads the stored quantized image and checks
 * both of its hashes (file bytes and canonical pixels).
 */

import type {
  CreateTemplateInput,
  DecodedImage,
  Hasher,
  IdSource,
  LoadOptions,
  LoadReport,
  LoadedTemplate,
  Palette,
  PngCodec,
  ProjectId,
  QuantizationMethod,
  RevisionChange,
  RevisionCheck,
  RepairOptions,
  RepairReport,
  RevisionReason,
  RevisionRecordV1,
  RevisionResult,
  SettingsPatch,
  StrategyConfig,
  Template,
  TemplateId,
  TemplateImage,
  TemplateListFailure,
  TemplateListing,
  TemplateManager,
  TemplateManifest,
  TemplatePlacement,
  CoordinateSystem,
  TemplateRef,
  TemplateStatus,
  TemplateStorage,
  TemplateSummary,
  TemplateWarning,
  TimeSource,
  VerifyReport,
} from '../contracts/index.js';
import { assertPlacement, checkPlacement, type PlacementPolicy } from '../geometry/projection.js';
import { StorageConflictError, TemplateError } from './errors.js';
import { asProjectId, asTemplateId, normalizeName } from './ids.js';
import { assertValidLimits, assertWithinLimits, DEFAULT_TEMPLATE_LIMITS, type TemplateLimits } from './limits.js';
import { parseManifest, serializeManifest } from './manifest.js';
import { readPngHeader } from './png-header.js';
import { countPaintable, quantizedToRgba, rgbaToQuantized, serializeQuantized } from './pixels.js';
import {
  assertAlphaThresholdValue,
  DEFAULT_ALPHA_THRESHOLD,
  DEFAULT_QUANTIZATION,
  paletteColors,
  quantizeDecoded,
  resolveQuantization,
} from './quantization.js';
import { deepEqual, diffRevision } from './revisions.js';

export interface TemplateManagerDeps {
  readonly storage: TemplateStorage;
  readonly hasher: Hasher;
  readonly codec: PngCodec;
  readonly ids: IdSource;
  readonly clock: TimeSource;
  readonly limits?: TemplateLimits;
  /** Default: partially-outside placements are accepted, fully-outside ones refused. */
  readonly placementPolicy?: PlacementPolicy;
}

const DEFAULT_STRATEGY: StrategyConfig = { id: 'top-to-bottom' };

interface ManifestState {
  readonly manifest: TemplateManifest;
  readonly source: 'current' | 'backup';
  readonly problems: readonly string[];
}

/** Content of a revision, i.e. a record without its history fields. */
type RevisionContent = Omit<RevisionRecordV1, 'revision' | 'createdAt' | 'reasons' | 'basedOn' | 'extensions'>;

interface Imported {
  readonly content: RevisionContent;
  readonly image: TemplateImage;
  readonly sourceBytes: Uint8Array;
  readonly quantizedBytes: Uint8Array;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contentOf(record: RevisionRecordV1): RevisionContent {
  return {
    width: record.width,
    height: record.height,
    placement: record.placement,
    coordinateSystem: record.coordinateSystem,
    palette: record.palette,
    alphaThreshold: record.alphaThreshold,
    quantizationMethod: record.quantizationMethod,
    sourceImageHash: record.sourceImageHash,
    quantizedImageHash: record.quantizedImageHash,
    quantizedFileHash: record.quantizedFileHash,
    stats: record.stats,
  };
}

function revisionOf(manifest: TemplateManifest, revision: number): RevisionRecordV1 {
  const record = manifest.revisions[revision - 1];
  if (record === undefined) {
    throw new TemplateError('REVISION_NOT_FOUND', `template ${manifest.templateId} has no revision ${revision}`);
  }
  return record;
}

/** Derived, never stored: the user must see that part of the template cannot be painted. */
export function placementWarnings(record: Pick<RevisionRecordV1, 'width' | 'height' | 'placement' | 'coordinateSystem'>): TemplateWarning[] {
  const check = checkPlacement(record, record.placement, record.coordinateSystem);
  if (check.status !== 'partially-outside') return [];
  return [
    {
      code: 'PLACEMENT_PARTIALLY_OUTSIDE',
      pixelsOutside: check.pixelsOutside,
      message: `${check.pixelsOutside} of ${record.width * record.height} template pixels lie outside the canvas bounds and will never be painted`,
    },
  ];
}

const LIST_FAILURE_MESSAGES: Readonly<Record<TemplateListFailure['code'], string>> = {
  INVALID_MANIFEST: 'the manifest and its backup are missing or invalid',
  UNSUPPORTED_SCHEMA: 'the manifest was written by a newer version of GeoPlacer',
  READ_ERROR: 'the storage could not read the manifest',
};

function toTemplate(manifest: TemplateManifest, record: RevisionRecordV1, image: TemplateImage): Template {
  return {
    id: manifest.templateId,
    projectId: manifest.projectId,
    name: manifest.name,
    revision: record.revision,
    image,
    placement: record.placement,
    coordinateSystem: record.coordinateSystem,
    palette: record.palette,
    alphaThreshold: record.alphaThreshold,
    quantization: record.quantizationMethod,
    priority: manifest.priority,
    status: manifest.status,
    strategy: manifest.drawingStrategy,
    sourceImageHash: record.sourceImageHash,
    quantizedImageHash: record.quantizedImageHash,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    warnings: placementWarnings(record),
  };
}

function toSummary(manifest: TemplateManifest, source: 'current' | 'backup'): TemplateSummary {
  const current = revisionOf(manifest, manifest.currentRevision);
  return {
    projectId: manifest.projectId,
    templateId: manifest.templateId,
    name: manifest.name,
    currentRevision: manifest.currentRevision,
    revisionCount: manifest.revisions.length,
    width: current.width,
    height: current.height,
    paintablePixels: current.stats.pixels - current.stats.transparent,
    status: manifest.status,
    priority: manifest.priority,
    strategy: manifest.drawingStrategy,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    manifestSource: source,
    warnings: placementWarnings(current),
  };
}

function assertPriority(priority: number): void {
  if (!Number.isSafeInteger(priority)) throw new TemplateError('INVALID_INPUT', `priority must be a safe integer, got ${String(priority)}`);
}

function sameImage(a: TemplateImage, b: TemplateImage): boolean {
  if (a.width !== b.width || a.height !== b.height || a.pixels.length !== b.pixels.length) return false;
  for (let i = 0; i < a.pixels.length; i++) if (a.pixels[i] !== b.pixels[i]) return false;
  return true;
}

export function createTemplateManager(deps: TemplateManagerDeps): TemplateManager {
  const { storage, hasher, codec, ids, clock } = deps;
  const limits = deps.limits ?? DEFAULT_TEMPLATE_LIMITS;
  assertValidLimits(limits);
  const placementPolicy = deps.placementPolicy ?? { allowPartial: true };
  const locks = new Map<string, Promise<unknown>>();

  /** Serializes the mutations of one template inside this process (the storage CAS covers other writers). */
  function exclusive<T>(ref: TemplateRef, fn: () => Promise<T>): Promise<T> {
    const key = `${ref.projectId}/${ref.templateId}`;
    const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  }

  function checkRef(ref: TemplateRef): TemplateRef {
    return { projectId: asProjectId(ref.projectId), templateId: asTemplateId(ref.templateId) };
  }

  // ───────────── manifests ─────────────

  function parseFor(ref: TemplateRef, json: string): TemplateManifest {
    const manifest = parseManifest(json);
    if (manifest.projectId !== ref.projectId || manifest.templateId !== ref.templateId) {
      throw new TemplateError('INVALID_MANIFEST', `manifest belongs to ${manifest.projectId}/${manifest.templateId}, not ${ref.projectId}/${ref.templateId}`);
    }
    return manifest;
  }

  /** Current manifest; with `allowBackup`, the backup when the current one is missing or invalid. */
  async function readState(ref: TemplateRef, allowBackup: boolean): Promise<ManifestState> {
    const read = await storage.readManifest(ref.projectId, ref.templateId);
    if (read.current === null && read.backup === null) {
      throw new TemplateError('NOT_FOUND', `template ${ref.projectId}/${ref.templateId} does not exist`);
    }
    let failure: unknown = new TemplateError('INVALID_MANIFEST', 'the current manifest is missing');
    if (read.current !== null) {
      try {
        return { manifest: parseFor(ref, read.current), source: 'current', problems: [] };
      } catch (error) {
        failure = error;
      }
    }
    // Only a missing or malformed manifest falls back: a newer schema is never
    // silently replaced by the older backup.
    const malformed = failure instanceof TemplateError && failure.code === 'INVALID_MANIFEST';
    if (!allowBackup || read.backup === null || !malformed) throw failure;
    try {
      return { manifest: parseFor(ref, read.backup), source: 'backup', problems: [`current manifest: ${message(failure)}`] };
    } catch (error) {
      throw new TemplateError('INVALID_MANIFEST', `current manifest: ${message(failure)}; backup manifest: ${message(error)}`);
    }
  }

  async function writable(ref: TemplateRef): Promise<TemplateManifest> {
    const { manifest } = await readState(ref, false);
    if (manifest.deletedAt !== null) throw new TemplateError('DELETED', `template ${ref.templateId} has been deleted`);
    return manifest;
  }

  /** The single commit point. Returns the manifest as it will be read back. */
  async function publish(next: TemplateManifest, expected: number | null): Promise<TemplateManifest> {
    let json: string;
    let published: TemplateManifest;
    try {
      json = serializeManifest(next);
      published = parseManifest(json);
    } catch (error) {
      if (error instanceof TemplateError && error.code === 'INVALID_MANIFEST') throw new TemplateError('INVALID_INPUT', error.message);
      throw error;
    }
    try {
      await storage.writeManifest(next.projectId, next.templateId, json, expected);
    } catch (error) {
      if (error instanceof StorageConflictError) {
        throw new TemplateError('CONFLICT', `template ${next.templateId} was changed by another writer (${error.message})`);
      }
      throw error;
    }
    return published;
  }

  // ───────────── blobs ─────────────

  async function hashOf(bytes: Uint8Array): Promise<string> {
    return hasher.sha256Hex(bytes);
  }

  /** Reads a blob and checks its address; INTEGRITY_ERROR when missing or altered. */
  async function readVerified(projectId: ProjectId, address: string, what: string): Promise<Uint8Array> {
    const bytes = await storage.readBlob(projectId, address);
    if (bytes === null) throw new TemplateError('INTEGRITY_ERROR', `${what} blob ${address} is missing`);
    const actual = await hashOf(bytes);
    if (actual !== address) throw new TemplateError('INTEGRITY_ERROR', `${what} blob ${address} does not match its hash (found ${actual})`);
    return bytes;
  }

  /** Stores a blob (unless a valid copy exists) and verifies it by reading it back. */
  async function putBlob(projectId: ProjectId, address: string, bytes: Uint8Array, what: string): Promise<void> {
    const existing = await storage.readBlob(projectId, address);
    if (existing === null || (await hashOf(existing)) !== address) await storage.writeBlob(projectId, address, bytes);
    await readVerified(projectId, address, what);
  }

  // ───────────── import (source PNG -> quantized revision content) ─────────────

  async function decodeChecked(bytes: Uint8Array, expected?: { width: number; height: number }): Promise<DecodedImage> {
    const header = readPngHeader(bytes);
    assertWithinLimits(header.width, header.height, limits);
    if (expected !== undefined && (header.width !== expected.width || header.height !== expected.height)) {
      throw new TemplateError('DECODE_MISMATCH', `PNG is ${header.width}x${header.height}, expected ${expected.width}x${expected.height}`);
    }
    let decoded: DecodedImage;
    try {
      decoded = await codec.decode(bytes);
    } catch (error) {
      throw new TemplateError('INVALID_PNG', `PNG decoding failed (${codec.id}): ${message(error)}`);
    }
    if (decoded.width !== header.width || decoded.height !== header.height || decoded.rgba.length !== header.width * header.height * 4) {
      throw new TemplateError('DECODE_MISMATCH', `decoder returned ${decoded.width}x${decoded.height} (${decoded.rgba.length} bytes) for a ${header.width}x${header.height} PNG`);
    }
    return decoded;
  }

  async function importSource(
    sourceBytes: Uint8Array,
    palette: Palette,
    alphaThreshold: number,
    method: QuantizationMethod,
    placement: TemplatePlacement,
    system: CoordinateSystem
  ): Promise<Imported> {
    const header = readPngHeader(sourceBytes);
    assertWithinLimits(header.width, header.height, limits);
    assertPlacement(header, placement, system, placementPolicy);
    const decoded = await decodeChecked(sourceBytes);
    const { image, stats } = quantizeDecoded(decoded, palette, alphaThreshold, method);
    const quantizedBytes = await codec.encode({ width: image.width, height: image.height, rgba: quantizedToRgba(image) });
    // The stored file must decode back to exactly these pixels, or loading would fail later.
    const roundTrip = rgbaToQuantized(image.width, image.height, (await decodeChecked(quantizedBytes, image)).rgba);
    if (!sameImage(roundTrip, image)) throw new TemplateError('DECODE_MISMATCH', `codec ${codec.id} does not round-trip the quantized image`);
    return {
      content: {
        width: image.width,
        height: image.height,
        placement,
        coordinateSystem: system,
        palette,
        alphaThreshold,
        quantizationMethod: method,
        sourceImageHash: await hashOf(sourceBytes),
        quantizedImageHash: await hashOf(serializeQuantized(image)),
        quantizedFileHash: await hashOf(quantizedBytes),
        stats,
      },
      image,
      sourceBytes,
      quantizedBytes,
    };
  }

  async function storeImported(projectId: ProjectId, imported: Imported): Promise<void> {
    await putBlob(projectId, imported.content.sourceImageHash, imported.sourceBytes, 'source');
    await putBlob(projectId, imported.content.quantizedFileHash, imported.quantizedBytes, 'quantized');
  }

  // ───────────── loading (never re-quantizes) ─────────────

  async function loadImage(projectId: ProjectId, record: RevisionContent): Promise<TemplateImage> {
    await readVerified(projectId, record.sourceImageHash, 'source');
    const bytes = await readVerified(projectId, record.quantizedFileHash, 'quantized');
    let image: TemplateImage;
    try {
      const decoded = await decodeChecked(bytes, record);
      image = rgbaToQuantized(record.width, record.height, decoded.rgba);
    } catch (error) {
      throw new TemplateError('INTEGRITY_ERROR', `quantized image unreadable: ${message(error)}`);
    }
    if ((await hashOf(serializeQuantized(image))) !== record.quantizedImageHash) {
      throw new TemplateError('INTEGRITY_ERROR', 'quantized pixels do not match quantizedImageHash');
    }
    if (countPaintable(image) !== record.stats.pixels - record.stats.transparent) {
      throw new TemplateError('INTEGRITY_ERROR', 'quantized pixels do not match the recorded statistics');
    }
    return image;
  }

  async function loadRevisionStrict(manifest: TemplateManifest, revision: number): Promise<TemplateImage> {
    const record = revisionOf(manifest, revision);
    try {
      return await loadImage(manifest.projectId, record);
    } catch (error) {
      if (error instanceof TemplateError && error.code === 'INTEGRITY_ERROR') {
        throw new TemplateError('INTEGRITY_ERROR', `revision ${revision}: ${error.message}`);
      }
      throw new TemplateError('INTEGRITY_ERROR', `revision ${revision}: ${message(error)}`);
    }
  }

  // ───────────── revisions ─────────────

  async function appendRevision(
    manifest: TemplateManifest,
    content: RevisionContent,
    reasons: readonly RevisionReason[],
    basedOn: number
  ): Promise<TemplateManifest> {
    const now = clock.now();
    const record: RevisionRecordV1 = {
      revision: manifest.revisions.length + 1,
      createdAt: now,
      reasons,
      basedOn,
      ...content,
      extensions: {},
    };
    return publish(
      {
        ...manifest,
        generation: manifest.generation + 1,
        updatedAt: now,
        currentRevision: record.revision,
        revisions: [...manifest.revisions, record],
      },
      manifest.generation
    );
  }

  async function updateManifest(ref: TemplateRef, edit: (m: TemplateManifest) => Partial<TemplateManifest> | null): Promise<TemplateSummary> {
    return exclusive(ref, async () => {
      const manifest = await writable(ref);
      const changes = edit(manifest);
      if (changes === null) return toSummary(manifest, 'current');
      const published = await publish({ ...manifest, ...changes, generation: manifest.generation + 1, updatedAt: clock.now() }, manifest.generation);
      return toSummary(published, 'current');
    });
  }

  // ───────────── API ─────────────

  const manager: TemplateManager = {
    async create(input: CreateTemplateInput): Promise<Template> {
      const projectId = asProjectId(input.projectId);
      const name = normalizeName(input.name);
      const alphaThreshold = input.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
      const method = input.quantization ?? DEFAULT_QUANTIZATION;
      const priority = input.priority ?? 0;
      assertAlphaThresholdValue(alphaThreshold);
      resolveQuantization(method);
      paletteColors(input.palette);
      assertPriority(priority);

      const templateId = asTemplateId(ids.newTemplateId());
      const imported = await importSource(input.sourcePng, input.palette, alphaThreshold, method, input.placement, input.coordinateSystem);
      await storeImported(projectId, imported);
      const now = clock.now();
      const published = await publish(
        {
          schemaVersion: 1,
          projectId,
          templateId,
          generation: 1,
          name,
          drawingStrategy: input.strategy ?? DEFAULT_STRATEGY,
          priority,
          status: 'active',
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          currentRevision: 1,
          revisions: [{ revision: 1, createdAt: now, reasons: ['created'], basedOn: null, ...imported.content, extensions: {} }],
          extensions: {},
        },
        null
      );
      return toTemplate(published, revisionOf(published, 1), imported.image);
    },

    async load(rawRef, options: LoadOptions = {}): Promise<LoadedTemplate> {
      const ref = checkRef(rawRef);
      const recover = options.recover === true;
      const state = await readState(ref, recover);
      const { manifest } = state;
      if (manifest.deletedAt !== null) throw new TemplateError('DELETED', `template ${ref.templateId} has been deleted`);
      const problems = [...state.problems];
      const report = (requested: number | 'current', loaded: number): LoadReport => ({
        requestedRevision: requested,
        loadedRevision: loaded,
        manifestSource: state.source,
        problems,
      });

      if (options.revision !== undefined) {
        // An explicit revision is loaded exactly or not at all.
        const image = await loadRevisionStrict(manifest, options.revision);
        return { template: toTemplate(manifest, revisionOf(manifest, options.revision), image), report: report(options.revision, options.revision) };
      }
      if (!recover) {
        const image = await loadRevisionStrict(manifest, manifest.currentRevision);
        return { template: toTemplate(manifest, revisionOf(manifest, manifest.currentRevision), image), report: report('current', manifest.currentRevision) };
      }
      const order = [manifest.currentRevision, ...manifest.revisions.map((r) => r.revision).filter((n) => n !== manifest.currentRevision).reverse()];
      for (const revision of order) {
        try {
          const image = await loadRevisionStrict(manifest, revision);
          return { template: toTemplate(manifest, revisionOf(manifest, revision), image), report: report('current', revision) };
        } catch (error) {
          problems.push(message(error));
        }
      }
      throw new TemplateError('INTEGRITY_ERROR', `no revision of ${ref.templateId} verifies: ${problems.join('; ')}`);
    },

    async manifest(rawRef): Promise<TemplateManifest> {
      return (await readState(checkRef(rawRef), false)).manifest;
    },

    async list(rawProjectId): Promise<TemplateListing> {
      const projectId = asProjectId(rawProjectId);
      const templates: TemplateSummary[] = [];
      const failures: TemplateListFailure[] = [];
      for (const templateId of await storage.listTemplates(projectId)) {
        try {
          const state = await readState({ projectId, templateId: asTemplateId(templateId) }, true);
          if (state.manifest.deletedAt === null) templates.push(toSummary(state.manifest, state.source));
        } catch (error) {
          // Isolated: one unreadable template never hides the others. Fixed
          // messages only (no manifest content, no storage path).
          const code = error instanceof TemplateError ? error.code : 'READ_ERROR';
          if (code === 'NOT_FOUND') continue; // removed while listing
          const failureCode: TemplateListFailure['code'] = code === 'UNSUPPORTED_SCHEMA' || code === 'INVALID_MANIFEST' ? code : 'READ_ERROR';
          failures.push({ templateId, code: failureCode, message: LIST_FAILURE_MESSAGES[failureCode] });
        }
      }
      templates.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt || (a.templateId < b.templateId ? -1 : 1));
      return { templates, failures };
    },

    revise(rawRef, change: RevisionChange): Promise<RevisionResult> {
      const ref = checkRef(rawRef);
      return exclusive(ref, async () => {
        const manifest = await writable(ref);
        const current = revisionOf(manifest, manifest.currentRevision);
        if (change.alphaThreshold !== undefined) assertAlphaThresholdValue(change.alphaThreshold);
        if (change.quantization !== undefined) resolveQuantization(change.quantization);
        if (change.palette !== undefined) paletteColors(change.palette);
        const newSourceHash = change.sourcePng === undefined ? undefined : await hashOf(change.sourcePng);
        const diff = diffRevision(current, change, newSourceHash);
        if (diff.reasons.length === 0) {
          const image = await loadRevisionStrict(manifest, current.revision);
          return { template: toTemplate(manifest, current, image), created: false, reasons: [] };
        }

        const palette = change.palette ?? current.palette;
        const placement = change.placement ?? current.placement;
        const system = change.coordinateSystem ?? current.coordinateSystem;
        let content: RevisionContent;
        let image: TemplateImage;
        if (diff.requantize) {
          const source =
            change.sourcePng !== undefined && newSourceHash !== current.sourceImageHash
              ? change.sourcePng
              : await readVerified(manifest.projectId, current.sourceImageHash, 'source');
          const imported = await importSource(
            source,
            palette,
            change.alphaThreshold ?? current.alphaThreshold,
            change.quantization ?? current.quantizationMethod,
            placement,
            system
          );
          await storeImported(manifest.projectId, imported);
          content = imported.content;
          image = imported.image;
        } else {
          // Same pixels: the stored blobs are reused after a full verification.
          assertPlacement(current, placement, system, placementPolicy);
          image = await loadRevisionStrict(manifest, current.revision);
          content = { ...contentOf(current), palette, placement, coordinateSystem: system };
        }
        const published = await appendRevision(manifest, content, diff.reasons, current.revision);
        return { template: toTemplate(published, revisionOf(published, published.currentRevision), image), created: true, reasons: diff.reasons };
      });
    },

    restoreRevision(rawRef, revision: number): Promise<RevisionResult> {
      const ref = checkRef(rawRef);
      return exclusive(ref, async () => {
        const manifest = await writable(ref);
        const target = revisionOf(manifest, revision);
        const current = revisionOf(manifest, manifest.currentRevision);
        const image = await loadRevisionStrict(manifest, revision);
        if (deepEqual(contentOf(target), contentOf(current))) {
          return { template: toTemplate(manifest, current, image), created: false, reasons: [] };
        }
        const published = await appendRevision(manifest, contentOf(target), ['restored'], revision);
        return { template: toTemplate(published, revisionOf(published, published.currentRevision), image), created: true, reasons: ['restored'] };
      });
    },

    updateSettings(rawRef, patch: SettingsPatch): Promise<TemplateSummary> {
      const ref = checkRef(rawRef);
      const name = patch.name === undefined ? undefined : normalizeName(patch.name);
      if (patch.priority !== undefined) assertPriority(patch.priority);
      return updateManifest(ref, (m) => {
        const next = {
          name: name ?? m.name,
          drawingStrategy: patch.strategy ?? m.drawingStrategy,
          priority: patch.priority ?? m.priority,
        };
        const unchanged = next.name === m.name && deepEqual(next.drawingStrategy, m.drawingStrategy) && next.priority === m.priority;
        return unchanged ? null : next;
      });
    },

    setStatus(rawRef, status: TemplateStatus): Promise<TemplateSummary> {
      return updateManifest(checkRef(rawRef), (m) => (m.status === status ? null : { status }));
    },

    async duplicate(rawRef, options): Promise<Template> {
      const ref = checkRef(rawRef);
      const name = normalizeName(options.name);
      const projectId = asProjectId(options.projectId ?? ref.projectId);
      const source = await writable(ref);
      const record = revisionOf(source, source.currentRevision);
      const image = await loadRevisionStrict(source, record.revision);
      for (const [address, what] of [
        [record.sourceImageHash, 'source'],
        [record.quantizedFileHash, 'quantized'],
      ] as const) {
        await putBlob(projectId, address, await readVerified(source.projectId, address, what), what);
      }
      const templateId: TemplateId = asTemplateId(ids.newTemplateId());
      const now = clock.now();
      const published = await publish(
        {
          schemaVersion: 1,
          projectId,
          templateId,
          generation: 1,
          name,
          drawingStrategy: source.drawingStrategy,
          priority: source.priority,
          // A copy never starts painting by itself.
          status: 'paused',
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          currentRevision: 1,
          revisions: [{ revision: 1, createdAt: now, reasons: ['duplicated'], basedOn: null, ...contentOf(record), extensions: {} }],
          extensions: {},
        },
        null
      );
      return toTemplate(published, revisionOf(published, 1), image);
    },

    async delete(rawRef, options): Promise<void> {
      const ref = checkRef(rawRef);
      await exclusive(ref, async () => {
        const manifest = await writable(ref);
        if (options.confirmName !== manifest.name) {
          throw new TemplateError('CONFIRMATION_REQUIRED', 'deleting a template requires its exact name as confirmation');
        }
        const now = clock.now();
        await publish({ ...manifest, generation: manifest.generation + 1, updatedAt: now, deletedAt: now }, manifest.generation);
      });
    },

    async verify(rawRef): Promise<VerifyReport> {
      const ref = checkRef(rawRef);
      const state = await readState(ref, true);
      const revisions: RevisionCheck[] = [];
      for (const record of state.manifest.revisions) {
        const problems: string[] = [];
        try {
          await loadImage(state.manifest.projectId, record);
        } catch (error) {
          problems.push(message(error));
        }
        revisions.push({ revision: record.revision, ok: problems.length === 0, problems });
      }
      return { manifestSource: state.source, currentRevision: state.manifest.currentRevision, revisions };
    },

    repair(rawRef, options: RepairOptions): Promise<RepairReport> {
      const ref = checkRef(rawRef);
      return exclusive(ref, async () => {
        const read = await storage.readManifest(ref.projectId, ref.templateId);
        if (read.current === null && read.backup === null) {
          throw new TemplateError('NOT_FOUND', `template ${ref.projectId}/${ref.templateId} does not exist`);
        }
        let problem = 'the current manifest is missing';
        if (read.current !== null) {
          try {
            const current = parseFor(ref, read.current);
            return { action: 'none', applied: false, problem: null, generation: current.generation, currentRevision: current.currentRevision, preservedAs: null };
          } catch (error) {
            // A newer schema is never replaced by an older backup; any other
            // failure than a malformed manifest is not a repair case either.
            if (!(error instanceof TemplateError) || error.code !== 'INVALID_MANIFEST') throw error;
            problem = 'the current manifest is malformed';
          }
        }
        if (read.backup === null) throw new TemplateError('INVALID_MANIFEST', `${problem} and there is no backup to repair from`);
        let backup: TemplateManifest;
        try {
          backup = parseFor(ref, read.backup);
        } catch (error) {
          if (error instanceof TemplateError && error.code === 'UNSUPPORTED_SCHEMA') throw error;
          throw new TemplateError('INVALID_MANIFEST', `${problem} and the backup is invalid too`);
        }
        // The state we go back to must be usable: its current revision must verify.
        try {
          await loadRevisionStrict(backup, backup.currentRevision);
        } catch (error) {
          throw new TemplateError('INTEGRITY_ERROR', `${problem}; the backup's current revision does not verify (${message(error)})`);
        }
        // +2: strictly above the lost generation (backup + 1) a stale writer may remember.
        const repaired: TemplateManifest = { ...backup, generation: backup.generation + 2, updatedAt: clock.now() };
        const report = { action: 'restore-backup', problem, generation: repaired.generation, currentRevision: repaired.currentRevision } as const;
        if (!options.apply) return { ...report, applied: false, preservedAs: null };
        const json = serializeManifest(repaired);
        parseFor(ref, json);
        let preservedAs: string | null;
        try {
          preservedAs = await storage.replaceManifest(ref.projectId, ref.templateId, json, read.current);
        } catch (error) {
          if (error instanceof StorageConflictError) {
            throw new TemplateError('CONFLICT', `template ${ref.templateId} changed during the repair; nothing was written`);
          }
          throw error;
        }
        return { ...report, applied: true, preservedAs };
      });
    },
  };
  return manager;
}

