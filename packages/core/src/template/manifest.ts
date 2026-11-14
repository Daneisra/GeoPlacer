/**
 * Template manifest (schema 2, reads schema 1): strict validation, stable
 * serialization, migration registry.
 *
 * Compatibility rules:
 * - New optional data written by future code goes into `extensions`
 *   (top level), which is preserved verbatim on every rewrite.
 * - Any other unknown key is rejected: the manifest is the integrity anchor,
 *   so it is never half-understood.
 * - An incompatible change requires a new schema and a migration; a
 *   manifest newer than this code is rejected (UNSUPPORTED_SCHEMA).
 * - Schema 1 -> 2 (Phase 1B.6): explicit revision numbering, gaps allowed.
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

/**
 * Migrations from an older schema version to the next one, in memory only:
 * a stored file is rewritten in the new schema by the next write, never by
 * a read.
 * 1 -> 2: revision numbering becomes explicit; a schema-1 manifest was
 * numbered from the manifest alone ('legacy'). A valid schema-1 revision
 * list (contiguous from 1) is a valid schema-2 list.
 */
const MIGRATIONS: Readonly<Record<number, (manifest: Json) => Json>> = {
  1: (manifest) => ({ ...manifest, schemaVersion: 2, numbering: 'legacy' }),
};

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

/** Validates a strategy configuration (seed: unsigned 32-bit; colorOrder: distinct colors). */
export function validateStrategyConfig(value: unknown, path = 'strategy'): StrategyConfig {
  return strategyOf(value, path);
}

function strategyOf(value: unknown, path: string): StrategyConfig {
  const s = object(value, path, ['id', 'seed', 'colorOrder']);
  const id = oneOf(s.id, `${path}.id`, STRATEGIES);
  let colorOrder: StrategyConfig['colorOrder'];
  if (s.colorOrder !== undefined) {
    if (!Array.isArray(s.colorOrder)) bad(`${path}.colorOrder`, 'expected an array');
    const seen = new Set<number>();
    colorOrder = s.colorOrder.map((c, i) => {
      if (typeof c !== 'number' || !isRgb(c)) bad(`${path}.colorOrder[${i}]`, 'expected a 24-bit RGB integer');
      if (seen.has(c)) bad(`${path}.colorOrder[${i}]`, 'duplicate color');
      seen.add(c);
      return c;
    });
  }
  let seed: number | undefined;
  if (s.seed !== undefined) {
    seed = int(s.seed, `${path}.seed`, 0);
    if (seed > 0xffffffff) bad(`${path}.seed`, 'expected an unsigned 32-bit integer');
  }
  return {
    id,
    ...(seed === undefined ? {} : { seed }),
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

/** Bounds of an `extensions` object (manifest or revision). */
export const EXTENSIONS_LIMITS = {
  /** Serialized JSON size. */
  maxBytes: 64 * 1024,
  /** Nesting depth below the extensions object itself. */
  maxDepth: 8,
  maxKeys: 64,
  maxStringLength: 10_000,
} as const;
/** Top-level extension names: a letter, then letters, digits, '.', '_' or '-' (64 max). */
const EXTENSION_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** UTF-8 byte length (the core has no TextEncoder). Lone surrogates count as 3 bytes, like U+FFFD. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Plain JSON data only: no prototype keys, bounded depth, size and strings. */
function jsonValue(value: unknown, path: string, depth: number): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) bad(path, 'expected a finite number');
    return;
  }
  if (typeof value === 'string') {
    if (value.length > EXTENSIONS_LIMITS.maxStringLength) bad(path, `string longer than ${EXTENSIONS_LIMITS.maxStringLength}`);
    return;
  }
  if (depth >= EXTENSIONS_LIMITS.maxDepth) bad(path, `nested deeper than ${EXTENSIONS_LIMITS.maxDepth}`);
  if (Array.isArray(value)) {
    value.forEach((item, i) => jsonValue(item, `${path}[${i}]`, depth + 1));
    return;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) bad(path, 'expected JSON data');
  for (const [key, item] of Object.entries(value as Json)) {
    if (FORBIDDEN_KEYS.has(key) || key.length > 200) bad(`${path}.${key.slice(0, 40)}`, 'forbidden or too long key');
    jsonValue(item, `${path}.${key}`, depth + 1);
  }
}

/**
 * Forward-compatible data, preserved verbatim, but validated: named entries,
 * plain JSON values, bounded size and depth.
 */
export function validateExtensions(value: unknown, path = 'extensions'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    bad(path, 'expected an object');
  }
  const record = value as Json;
  const keys = Object.keys(record);
  if (keys.length > EXTENSIONS_LIMITS.maxKeys) bad(path, `more than ${EXTENSIONS_LIMITS.maxKeys} entries`);
  for (const key of keys) {
    if (!EXTENSION_KEY.test(key) || FORBIDDEN_KEYS.has(key)) bad(`${path}.${key.slice(0, 40)}`, 'invalid extension name');
    jsonValue(record[key], `${path}.${key}`, 0);
  }
  if (utf8Length(JSON.stringify(record)) > EXTENSIONS_LIMITS.maxBytes) {
    bad(path, `larger than ${EXTENSIONS_LIMITS.maxBytes} bytes`);
  }
  return { ...record };
}

const extensionsOf = validateExtensions;

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
  'schemaVersion', 'numbering', 'projectId', 'templateId', 'generation', 'name', 'drawingStrategy', 'priority', 'status',
  'createdAt', 'updatedAt', 'deletedAt', 'currentRevision', 'revisions', 'extensions',
] as const;

/** Validates a parsed schema-2 manifest object (schema-1 objects go through parseManifest's migration). */
export function validateManifest(value: unknown): TemplateManifest {
  const m = object(value, 'manifest', MANIFEST_KEYS);
  if (m.schemaVersion !== 2) bad('manifest.schemaVersion', 'expected 2');
  const numbering = oneOf(m.numbering, 'manifest.numbering', ['legacy', 'reserved'] as const);
  if (!Array.isArray(m.revisions) || m.revisions.length === 0) bad('manifest.revisions', 'expected a non-empty array');
  const revisions = m.revisions.map((r, i) => revisionOf(r, `manifest.revisions[${i}]`));
  // Strictly increasing numbers; gaps are allowed (reserved but unpublished, or lost and never reused).
  const numbers = new Set<number>();
  revisions.forEach((r, i) => {
    const previous = revisions[i - 1];
    if (previous !== undefined && r.revision <= previous.revision) bad(`manifest.revisions[${i}].revision`, 'revision numbers must strictly increase');
    if (numbering === 'legacy' && r.revision !== i + 1) bad(`manifest.revisions[${i}].revision`, `expected ${i + 1} (legacy numbering is contiguous from 1)`);
    if (r.basedOn !== null && (r.basedOn >= r.revision || !numbers.has(r.basedOn))) {
      bad(`manifest.revisions[${i}].basedOn`, 'must refer to an earlier revision of this manifest');
    }
    numbers.add(r.revision);
  });
  const currentRevision = int(m.currentRevision, 'manifest.currentRevision', 1);
  if (!numbers.has(currentRevision)) bad('manifest.currentRevision', 'refers to a missing revision');
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
    schemaVersion: 2,
    numbering,
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
    numbering: manifest.numbering,
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
