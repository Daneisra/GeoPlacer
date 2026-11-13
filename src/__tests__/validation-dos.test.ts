/**
 * Regression tests for GHSA-mrhx-c7xc-m3w5 (Zod issue accumulation).
 * Malicious request bodies must be rejected quickly with a bounded number of
 * issues instead of exhausting memory or the call stack.
 */

import {
  templateCreateSchema,
  templateUpdateSchema,
  userLoginSchema,
  cookiesSchema,
  numberMatrix,
  MAX_TEMPLATE_DIMENSION,
  MAX_USER_IDS,
  MAX_COOKIE_ENTRIES,
} from '../middleware/validation.js';

const validTemplateBody = (data: unknown) => ({
  templateName: 't',
  template: { width: 3, height: 1, data },
  coords: [0, 0, 0, 0],
  userIds: ['u1'],
});

function timed<T>(fn: () => T): { result: T; ms: number } {
  const start = Date.now();
  const result = fn();
  return { result, ms: Date.now() - start };
}

describe('template matrix (fail-fast, bounded)', () => {
  it('accepts a valid matrix', () => {
    expect(templateCreateSchema.safeParse(validTemplateBody([[1, 2, 3]])).success).toBe(true);
  });

  it('rejects 3 million invalid cells in one row with a single issue', () => {
    const { result, ms } = timed(() => templateCreateSchema.safeParse(validTemplateBody([new Array(3_000_000).fill('x')])));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toHaveLength(1);
    expect(ms).toBeLessThan(1000);
  });

  it('rejects invalid cells spread over many rows with a single issue', () => {
    const rows = Array.from({ length: 700 }, () => new Array(4000).fill('x'));
    const result = templateCreateSchema.safeParse(validTemplateBody(rows));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toHaveLength(1);
  });

  it('rejects matrices larger than the maximum dimension', () => {
    const matrix = numberMatrix(MAX_TEMPLATE_DIMENSION);
    expect(matrix.safeParse([new Array(MAX_TEMPLATE_DIMENSION + 1).fill(0)]).success).toBe(false);
    expect(matrix.safeParse(new Array(MAX_TEMPLATE_DIMENSION + 1).fill([0])).success).toBe(false);
    expect(matrix.safeParse([[NaN]]).success).toBe(false);
    expect(matrix.safeParse([[Infinity]]).success).toBe(false);
    expect(matrix.safeParse('not a matrix').success).toBe(false);
  });

  it('accepts a 2000x2000 template (guard against pathological slowness only)', () => {
    const data = Array.from({ length: 2000 }, () => new Array(2000).fill(5));
    const { result, ms } = timed(() => templateCreateSchema.safeParse(validTemplateBody(data)));
    expect(result.success).toBe(true);
    expect(ms).toBeLessThan(10_000);
  });
});

describe('bounded id lists', () => {
  it('rejects oversized userIds lists with a single issue', () => {
    const userIds = new Array(1_000_000).fill(42);
    for (const schema of [templateCreateSchema, templateUpdateSchema]) {
      const body = schema === templateCreateSchema ? { ...validTemplateBody([[1]]), userIds } : { userIds };
      const result = schema.safeParse(body);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.length).toBeLessThanOrEqual(1);
    }
  });

  it('accepts lists up to the limit', () => {
    expect(templateUpdateSchema.safeParse({ userIds: new Array(MAX_USER_IDS).fill('u') }).success).toBe(true);
  });
});

describe('cookies (fail-fast, bounded)', () => {
  it('accepts valid cookies and keeps extra string cookies', () => {
    expect(cookiesSchema.parse({ j: 'token', s: 'other' })).toEqual({ j: 'token', s: 'other' });
  });

  it('rejects a huge cookie object with a single issue', () => {
    const cookies: Record<string, unknown> = { j: 'token' };
    for (let i = 0; i < 500_000; i++) cookies[`k${i}`] = 1;
    const result = userLoginSchema.safeParse({ cookies });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toHaveLength(1);
  });

  it('enforces the entry limit, string values and a non-empty j', () => {
    const many: Record<string, string> = { j: 'token' };
    for (let i = 0; i < MAX_COOKIE_ENTRIES; i++) many[`k${i}`] = 'v';
    expect(cookiesSchema.safeParse(many).success).toBe(false);
    expect(cookiesSchema.safeParse({ j: 'token', s: 1 }).success).toBe(false);
    expect(cookiesSchema.safeParse({ j: '' }).success).toBe(false);
    expect(cookiesSchema.safeParse(['j']).success).toBe(false);
  });
});
