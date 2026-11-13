/**
 * Validation middleware using Zod
 */

import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import type { Cookies } from '../types/index.js';

// ============ Collection bounds ============
//
// GHSA-mrhx-c7xc-m3w5: Zod creates one issue object per invalid element of
// an array/record. Since 4.6.6 a .max() constraint stops early, but an
// unbounded collection still accumulates millions of issues (measured on
// 4.6.7: +686 MB for 1M invalid elements; nested arrays overflow the stack).
// Every collection taken from a request is therefore bounded, and large
// matrices are checked with a fail-fast validator (one issue at most).

export const MAX_TEMPLATE_DIMENSION = 4096;
export const MAX_USER_IDS = 256;
export const MAX_COOKIE_ENTRIES = 32;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** number[][] of at most maxDim x maxDim finite numbers, fail-fast. */
export function numberMatrix(maxDim: number) {
  return z.custom<number[][]>((value) => {
    if (!Array.isArray(value) || value.length > maxDim) return false;
    for (const row of value) {
      if (!Array.isArray(row) || row.length > maxDim) return false;
      for (const cell of row) {
        if (typeof cell !== 'number' || !Number.isFinite(cell)) return false;
      }
    }
    return true;
  }, `Expected a number[][] of at most ${maxDim}x${maxDim} finite numbers`);
}

// ============ Validation Schemas ============

/** Session cookies: a non-empty "j" and only string values, fail-fast. */
export const cookiesSchema = z.custom<Cookies>((value) => {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length > MAX_COOKIE_ENTRIES) return false;
  if (typeof value.j !== 'string' || value.j.length === 0) return false;
  return keys.every((key) => typeof value[key] === 'string');
}, `Expected at most ${MAX_COOKIE_ENTRIES} string cookies including a non-empty "j"`);

export const userLoginSchema = z.object({
  cookies: cookiesSchema,
  expirationDate: z.number().optional(),
});

export const templateCreateSchema = z.object({
  templateName: z.string().min(1).max(100),
  template: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    data: numberMatrix(MAX_TEMPLATE_DIMENSION),
  }),
  coords: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  userIds: z.array(z.string()).max(MAX_USER_IDS),
  canBuyCharges: z.boolean().optional(),
  canBuyMaxCharges: z.boolean().optional(),
  antiGriefMode: z.boolean().optional(),
  eraseMode: z.boolean().optional(),
  outlineMode: z.boolean().optional(),
  skipPaintedPixels: z.boolean().optional(),
  enableAutostart: z.boolean().optional(),
});

export const templateUpdateSchema = z.object({
  templateName: z.string().min(1).max(100).optional(),
  coords: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  userIds: z.array(z.string()).max(MAX_USER_IDS).optional(),
  canBuyCharges: z.boolean().optional(),
  canBuyMaxCharges: z.boolean().optional(),
  antiGriefMode: z.boolean().optional(),
  eraseMode: z.boolean().optional(),
  outlineMode: z.boolean().optional(),
  skipPaintedPixels: z.boolean().optional(),
  enableAutostart: z.boolean().optional(),
  running: z.boolean().optional(),
});

export const tokenSchema = z.object({
  t: z.string().min(1),
  pawtect: z.string().optional(),
  fp: z.string().optional(),
});

export const settingsSchema = z.object({
  accountCooldown: z.number().int().min(1000).max(300000).optional(),
  purchaseCooldown: z.number().int().min(1000).max(60000).optional(),
  keepAliveCooldown: z.number().int().min(300000).max(86400000).optional(),
  dropletReserve: z.number().int().min(0).max(10000).optional(),
  antiGriefStandby: z.number().int().min(0).max(3600000).optional(),
  drawingDirection: z.enum(['ttb', 'btt', 'ltr', 'rtl', 'center_out', 'random']).optional(),
  drawingOrder: z.enum(['linear', 'color']).optional(),
  chargeThreshold: z.number().min(0).max(1).optional(),
  pixelSkip: z.number().int().min(1).max(10).optional(),
  proxyEnabled: z.boolean().optional(),
  proxyRotationMode: z.enum(['sequential', 'random']).optional(),
  logProxyUsage: z.boolean().optional(),
  openBrowserOnStart: z.boolean().optional(),
});

// ============ Validation Middleware ============

export function validateBody<T>(schema: z.ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          details: err.issues,
        });
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

export function validateParams<T>(schema: z.ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.params = schema.parse(req.params) as any;
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          details: err.issues,
        });
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

export function validateQuery<T>(schema: z.ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.query = schema.parse(req.query) as any;
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          details: err.issues,
        });
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}
