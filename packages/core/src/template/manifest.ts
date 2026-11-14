/**
 * Template manifest (schema v1): strict validation, stable serialization,
 * migration registry.
 *
 * Compatibility rules:
 * - New optional data written by future v1 code goes into `extensions`
 *   (top level), which is preserved verbatim on every rewrite.
 * - Any other unknown key is rejected: the manifest is the integrity anchor,
 *   so it is never half-understood.
 * - An incompatible change requires schemaVersion 2 and a migration from 1;
 *   a manifest newer than this code is rejected (UNSUPPORTED_SCHEMA).
 */

import type {
  CoordinateSystem,
  Palette,
  QuantizationMethod,
  QuantizationStats,
  RevisionReason,
  RevisionRecordV1,
  StrategyConfig,
  TemplateManifest,
  TemplatePlacement,
  TemplateStatus,
} from '../contracts/index.js';
import { TEMPLATE_MANIFEST_SCHEMA_VERSION } from '../contracts/index.js';
import { isRgb } from '../color/rgb.js';
import { TemplateError } from './errors.js';
import { asProjectId, asTemplateId, MAX_NAME_LENGTH } from './ids.js';

type Json = Record<string, unknown>;

/** Migrations from an older schema version to the next one (none yet). */
const MIGRATIONS: Readonly<Record<number, (manifest: Json) => Json>> = {};

const STATUSES: readonly TemplateStatus[] = ['active', 'paused', 'completed', 'archived'];
const STRATEGIES: readonly StrategyConfig['id'][] = [
  'top-to-bottom',
  'bottom-to-top',
  'left-to-right',
  'right-to-left',
  'color-by-color',
  'outline-first',
  'center-out',
  'random',
];
const REASONS: readonly RevisionReason[] = [
  'created',
  'source-image',
  'palette',
  'alpha-threshold',
  'quantization',
  'placement',
  'coordinate-system',
  'restored',
  'duplicated',
];
const HASH = /^[0-9a-f]{64}$/;

function bad(path: string, message: string): never {
  throw new TemplateError('INVALID_MANIFEST', `${path}: ${message}`);
}

function object(value: unknown, path: string, allowed: readonly string[]): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) bad(path, 'expected an object');
  const record = value as Json;
  for (const key of Object.keys(record)) if (!allowed.includes(key)) bad(`${path}.${key}`, 'unknown field (use extensions)');
  return record;
}

function int(value: unknown, path: string, min = Number.MIN_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) bad(path, `expected an integer >= ${min}`);
  return value;
}

function str(value: unknown, path: string, max = 1000): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) bad(path, `expected a non-empty string (max ${max})`);
  return value;
}

function hash(value: unknown, path: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) bad(path, 'expected a lower-case hex SHA-256');
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) bad(path, `expected one of ${options.join(', ')}`);
  return value as T;
}

function placementOf(value: unknown, path: string): TemplatePlacement {
  const p = object(value, path, ['topLeft']);
  const t = object(p.topLeft, `${path}.topLeft`, ['x', 'y']);
  return { topLeft: { x: int(t.x, `${path}.topLeft.x`), y: int(t.y, `${path}.topLeft.y`) } };
}

function systemOf(value: unknown, path: string): CoordinateSystem {
  const s = object(value, path, ['yAxis', 'bounds']);
  const yAxis = oneOf(s.yAxis, `${path}.yAxis`, ['down', 'up'] as const);
  if (s.bounds === undefined) return { yAxis };
  const b = object(s.bounds, `${path}.bounds`, ['minX', 'minY', 'width', 'height']);
  return {
    yAxis,
    bounds: {
      minX: int(b.minX, `${path}.bounds.minX`),
      minY: int(b.minY, `${path}.bounds.minY`),
      width: int(b.width, `${path}.bounds.width`, 1),
      height: int(b.height, `${path}.bounds.height`, 1),
    },
  };
}

function paletteOf(value: unknown, path: string): Palette {
  const p = object(value, path, ['id', 'colors']);
  if (!Array.isArray(p.colors) || p.colors.length === 0) bad(`${path}.colors`, 'expected a non-empty array');
  return {
    id: str(p.id, `${path}.id`, 200),
    colors: p.colors.map((entry, i) => {
      const c = object(entry, `${path}.colors[${i}]`, ['rgb', 'name', 'unlockCost']);
      if (typeof c.rgb !== 'number' || !isRgb(c.rgb)) bad(`${path}.colors[${i}].rgb`, 'expected a 24-bit RGB integer');
      return {
        rgb: c.rgb,
        ...(c.name === undefined ? {} : { name: str(c.name, `${path}.colors[${i}].name`, 200) }),
        ...(c.unlockCost === undefined ? {} : { unlockCost: int(c.unlockCost, `${path}.colors[${i}].unlockCost`, 0) }),
      };
    }),
  };
}

function strategyOf(value: unknown, path: string): StrategyConfig {
  const s = object(value, path, ['id', 'seed', 'colorOrder']);
  const id = oneOf(s.id, `${path}.id`, STRATEGIES);
  let colorOrder: StrategyConfig['colorOrder'];
  if (s.colorOrder !== undefined) {
    if (!Array.isArray(s.colorOrder)) bad(`${path}.colorOrder`, 'expected an array');
    colorOrder = s.colorOrder.map((c, i) => {
      if (typeof c !== 'number' || !isRgb(c)) bad(`${path}.colorOrder[${i}]`, 'expected a 24-bit RGB integer');
      return c;
    });
  }
  return {
    id,
    ...(s.seed === undefined ? {} : { seed: int(s.seed, `${path}.seed`) }),
    ...(colorOrder === undefined ? {} : { colorOrder }),
  };
}

function quantizationOf(value: unknown, path: string): QuantizationMethod {
  const q = object(value, path, ['algorithm', 'distance', 'version']);
  return {
    algorithm: oneOf(q.algorithm, `${path}.algorithm`, ['nearest-color'] as const),
    distance: str(q.distance, `${path}.distance`, 100),
    version: int(q.version, `${path}.version`, 1) === 1 ? 1 : bad(`${path}.version`, 'expected 1'),
  };
}

function statsOf(value: unknown, path: string): QuantizationStats {
  const s = object(value, path, ['pixels', 'transparent', 'exact', 'approximated']);
  const stats = {
    pixels: int(s.pixels, `${path}.pixels`, 1),
    transparent: int(s.transparent, `${path}.transparent`, 0),
    exact: int(s.exact, `${path}.exact`, 0),
    approximated: int(s.approximated, `${path}.approximated`, 0),
  };
  if (stats.transparent + stats.exact + stats.approximated !== stats.pixels) bad(path, 'counts do not add up to pixels');
  return stats;
}

const REVISION_KEYS = [
  'revision', 'createdAt', 'reasons', 'basedOn', 'width', 'height', 'placement', 'coordinateSystem', 'palette',
  'alphaThreshold', 'quantizationMethod', 'sourceImageHash', 'quantizedImageHash', 'quantizedFileHash', 'stats', 'extensions',
] as const;

function extensionsOf(value: unknown, path: string): Record<string, unknown> {
  return { ...object(value, path, Object.keys((value as Json | null) ?? {})) };
}

function revisionOf(value: unknown, path: string): RevisionRecordV1 {
  const r = object(value, path, REVISION_KEYS);
  if (!Array.isArray(r.reasons) || r.reasons.length === 0) bad(`${path}.reasons`, 'expected a non-empty array');
  const width = int(r.width, `${path}.width`, 1);
  const height = int(r.height, `${path}.height`, 1);
  const stats = statsOf(r.stats, `${path}.stats`);
  if (stats.pixels !== width * height) bad(`${path}.stats.pixels`, 'does not match width x height');
  const threshold = int(r.alphaThreshold, `${path}.alphaThreshold`, 0);
  if (threshold > 256) bad(`${path}.alphaThreshold`, 'expected an integer in [0, 256]');
  return {
    revision: int(r.revision, `${path}.revision`, 1),
    createdAt: int(r.createdAt, `${path}.createdAt`, 0),
    reasons: r.reasons.map((reason, i) => oneOf(reason, `${path}.reasons[${i}]`, REASONS)),
    basedOn: r.basedOn === null ? null : int(r.basedOn, `${path}.basedOn`, 1),
    width,
    height,
    placement: placementOf(r.placement, `${path}.placement`),
    coordinateSystem: systemOf(r.coordinateSystem, `${path}.coordinateSystem`),
    palette: paletteOf(r.palette, `${path}.palette`),
    alphaThreshold: threshold,
    quantizationMethod: quantizationOf(r.quantizationMethod, `${path}.quantizationMethod`),
    sourceImageHash: hash(r.sourceImageHash, `${path}.sourceImageHash`),
    quantizedImageHash: hash(r.quantizedImageHash, `${path}.quantizedImageHash`),
    quantizedFileHash: hash(r.quantizedFileHash, `${path}.quantizedFileHash`),
    stats,
    extensions: extensionsOf(r.extensions, `${path}.extensions`),
  };
}

const MANIFEST_KEYS = [
  'schemaVersion', 'projectId', 'templateId', 'generation', 'name', 'drawingStrategy', 'priority', 'status',
  'createdAt', 'updatedAt', 'deletedAt', 'currentRevision', 'revisions', 'extensions',
] as const;

/** Validates a parsed v1 manifest object. */
export function validateManifest(value: unknown): TemplateManifest {
  const m = object(value, 'manifest', MANIFEST_KEYS);
  if (m.schemaVersion !== 1) bad('manifest.schemaVersion', 'expected 1');
  if (!Array.isArray(m.revisions) || m.revisions.length === 0) bad('manifest.revisions', 'expected a non-empty array');
  const revisions = m.revisions.map((r, i) => revisionOf(r, `manifest.revisions[${i}]`));
  revisions.forEach((r, i) => {
    if (r.revision !== i + 1) bad(`manifest.revisions[${i}].revision`, `expected ${i + 1} (revisions are contiguous from 1)`);
    if (r.basedOn !== null && r.basedOn >= r.revision) bad(`manifest.revisions[${i}].basedOn`, 'must refer to an earlier revision');
  });
  const currentRevision = int(m.currentRevision, 'manifest.currentRevision', 1);
  if (currentRevision > revisions.length) bad('manifest.currentRevision', 'refers to a missing revision');
  const extensions = extensionsOf(m.extensions, 'manifest.extensions');
  let projectId;
  let templateId;
  try {
    projectId = asProjectId(m.projectId);
    templateId = asTemplateId(m.templateId);
  } catch (error) {
    bad('manifest.projectId/templateId', (error as Error).message);
  }
  return {
    schemaVersion: 1,
    projectId,
    templateId,
    generation: int(m.generation, 'manifest.generation', 1),
    name: str(m.name, 'manifest.name', MAX_NAME_LENGTH),
    drawingStrategy: strategyOf(m.drawingStrategy, 'manifest.drawingStrategy'),
    priority: int(m.priority, 'manifest.priority'),
    status: oneOf(m.status, 'manifest.status', STATUSES),
    createdAt: int(m.createdAt, 'manifest.createdAt', 0),
    updatedAt: int(m.updatedAt, 'manifest.updatedAt', 0),
    deletedAt: m.deletedAt === null ? null : int(m.deletedAt, 'manifest.deletedAt', 0),
    currentRevision,
    revisions,
    extensions,
  };
}

/** Parses manifest JSON: migrates older schemas, rejects newer or invalid ones. */
export function parseManifest(json: string): TemplateManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new TemplateError('INVALID_MANIFEST', `not valid JSON: ${(error as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) bad('manifest', 'expected an object');
  let manifest = raw as Json;
  let version = manifest.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) bad('manifest.schemaVersion', 'expected a positive integer');
  if (version > TEMPLATE_MANIFEST_SCHEMA_VERSION) {
    throw new TemplateError('UNSUPPORTED_SCHEMA', `manifest schema ${version} is newer than supported (${TEMPLATE_MANIFEST_SCHEMA_VERSION})`);
  }
  while (version < TEMPLATE_MANIFEST_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[version];
    if (migrate === undefined) throw new TemplateError('UNSUPPORTED_SCHEMA', `no migration from manifest schema ${version}`);
    manifest = migrate(manifest);
    version += 1;
  }
  return validateManifest(manifest);
}

/** Stable serialization (fixed key order, 2-space indentation, final newline). */
export function serializeManifest(manifest: TemplateManifest): string {
  const ordered = {
    schemaVersion: manifest.schemaVersion,
    projectId: manifest.projectId,
    templateId: manifest.templateId,
    generation: manifest.generation,
    name: manifest.name,
    drawingStrategy: manifest.drawingStrategy,
    priority: manifest.priority,
    status: manifest.status,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    deletedAt: manifest.deletedAt,
    currentRevision: manifest.currentRevision,
    revisions: manifest.revisions.map((r) => {
      const record: Record<string, unknown> = {};
      for (const key of REVISION_KEYS) record[key] = r[key];
      return record;
    }),
    extensions: manifest.extensions,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Generation stored in a manifest JSON, or null when unreadable (for storage adapters). */
export function manifestGeneration(json: string | null): number | null {
  if (json === null) return null;
  try {
    const value = (JSON.parse(json) as { generation?: unknown }).generation;
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}
