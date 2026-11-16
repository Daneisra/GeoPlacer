/** Phase 2A wire contract. No service credentials or arbitrary network operations. */
export const CONNECTOR_PROTOCOL = 1;
export const CONNECTOR_MAX_PIXELS = 65_536;
export const CONNECTOR_MAX_AREA = 4_000_000;
export const CONNECTOR_MAX_AGE_MS = 30_000;
export type ConnectorMode = 'read-only' | 'local-fake';
export interface BrowserProject {
  readonly id: string;
  readonly generation: string;
  readonly width: number;
  readonly height: number;
  readonly gridX: number;
  readonly gridY: number;
  readonly layer: 'base';
}
export interface ObservedResources {
  readonly observedAt: number | null;
  readonly energy: number | null;
  readonly capacity: number | null;
  readonly currency: number | null;
  readonly regenIntervalMs: number | null;
  readonly colors: readonly number[] | null;
}
export interface BrowserObservation {
  readonly type: 'observation';
  readonly sequence: number;
  readonly session: string;
  readonly project: BrowserProject;
  readonly capturedAt: number;
  /** Epoch milliseconds only when established; a server cursor is NOT a date. */
  readonly observedAt: number | null;
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** Native grid order: increasing X, then increasing Y. -2 unknown, -1 transparent. */
  readonly pixels: readonly number[];
  readonly resources: ObservedResources | null;
}
export class ConnectorError extends Error {
  readonly status = 409;
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConnectorError('CONNECTOR_INVALID', message);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(typeof value === 'object' && value !== null && !Array.isArray(value), 'expected an object');
  const record = value as Record<string, unknown>;
  check(
    Object.keys(record).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(record, key)),
    'unexpected or missing fields'
  );
  return record;
}
export const integer = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const stamp = (n: unknown): boolean => n === null || integer(n, 0, 8_640_000_000_000_000);
const label = (n: unknown): boolean => typeof n === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(n);
export function parseObservation(value: unknown, now: number): BrowserObservation {
  const v = object(value, ['type', 'sequence', 'session', 'project', 'capturedAt', 'observedAt', 'rect', 'pixels', 'resources']);
  check(v.type === 'observation' && integer(v.sequence, 1, Number.MAX_SAFE_INTEGER) && label(v.session), 'invalid observation identity');
  check(
    integer(v.capturedAt, 0, now + 2_000) &&
      stamp(v.observedAt) &&
      (v.observedAt === null || (v.observedAt as number) <= (v.capturedAt as number)),
    'invalid observation time'
  );
  const p = object(v.project, ['id', 'generation', 'width', 'height', 'gridX', 'gridY', 'layer']);
  check(label(p.id) && label(p.generation) && p.layer === 'base', 'unsupported project or layer');
  check(integer(p.width, 1, 2000) && integer(p.height, 1, 2000) && p.width * p.height <= CONNECTOR_MAX_AREA, 'project exceeds 2000 x 2000');
  check(integer(p.gridX, -1_000_000_000, 1_000_000_000) && integer(p.gridY, -1_000_000_000, 1_000_000_000), 'invalid project coordinates');
  const r = object(v.rect, ['x', 'y', 'width', 'height']);
  check(
    integer(r.x, -1_000_000_000, 1_000_000_000) &&
      integer(r.y, -1_000_000_000, 1_000_000_000) &&
      integer(r.width, 1, 2000) &&
      integer(r.height, 1, 2000),
    'invalid observation region'
  );
  check(
    r.width * r.height <= CONNECTOR_MAX_PIXELS &&
      Array.isArray(v.pixels) &&
      v.pixels.length === r.width * r.height &&
      v.pixels.every((n) => integer(n, -2, 0xffffff)),
    'invalid pixels or oversized region'
  );
  check(
    r.x >= p.gridX && r.y >= p.gridY - p.height + 1 && r.x + r.width <= p.gridX + p.width && r.y + r.height <= p.gridY + 1,
    'region outside selected ghost'
  );
  if (v.resources !== null) {
    const res = object(v.resources, ['observedAt', 'energy', 'capacity', 'currency', 'regenIntervalMs', 'colors']);
    check(
      stamp(res.observedAt) && (res.observedAt === null || (res.observedAt as number) <= (v.capturedAt as number)),
      'invalid resource date'
    );
    for (const key of ['energy', 'capacity', 'currency'])
      check(res[key] === null || integer(res[key], 0, 1_000_000_000), 'invalid resource value');
    check(res.regenIntervalMs === null || integer(res.regenIntervalMs, 1, 86_400_000), 'invalid regeneration rate');
    check(
      res.colors === null ||
        (Array.isArray(res.colors) &&
          res.colors.length <= 256 &&
          res.colors.every((n) => integer(n, 0, 0xffffff)) &&
          new Set(res.colors).size === res.colors.length),
      'invalid resource palette'
    );
  }
  return value as BrowserObservation;
}
