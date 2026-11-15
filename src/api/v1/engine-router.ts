/**
 * /api/v1 routes of the new engine (Phase 1B.9): local simulation only.
 *
 * Mounted behind the server-wide protections (Host and Origin checks, rate
 * limiter, JSON size limit). In addition, under /api/v1:
 * - a browser extension origin (chrome-extension://, moz-extension://...)
 *   is refused: only the dashboard pages may drive the engine;
 * - a request that changes state must be `application/json` (an HTML form
 *   cannot send it cross-site without a preflight);
 * - every body and query is validated by a strict Zod schema (unknown
 *   fields refused, bounded sizes).
 *
 * Errors: `{ error: { code, message } }` with a stable code. No business
 * rule lives here: the engine decides what each state allows.
 */

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { isEngineApiError, type EngineApi } from './engine-api.js';

export const STRATEGY_IDS = ['top-to-bottom', 'bottom-to-top', 'left-to-right', 'right-to-left', 'color-by-color', 'outline-first', 'center-out', 'random'] as const;
/** Largest PNG accepted by the import (decoded bytes). */
export const MAX_PNG_BYTES = 8 * 1024 * 1024;

const ID = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'invalid id');
const coord = z.number().int().min(0).max(65_536);
const positive = z.number().int().min(0).max(1_000_000_000);

const schemas = {
  empty: z.strictObject({}),
  stop: z.strictObject({ abort: z.boolean().optional() }),
  importTemplate: z.strictObject({
    name: z.string().trim().min(1).max(100),
    pngBase64: z.string().min(1).max(Math.ceil((MAX_PNG_BYTES * 4) / 3) + 4).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'invalid base64'),
    x: coord,
    y: coord,
    strategy: z.enum(STRATEGY_IDS),
  }),
  select: z.strictObject({ templateId: ID }),
  move: z.strictObject({ x: coord, y: coord }),
  settings: z.strictObject({
    simulator: z
      .strictObject({ width: positive, height: positive, costPerPixel: positive, capacity: positive, regenIntervalMs: positive, writeLatencyMs: positive })
      .partial()
      .optional(),
    agent: z.strictObject({ startEnergy: positive, startCurrency: positive }).partial().optional(),
    run: z.strictObject({ maxBatchSize: positive, minBatchSize: positive }).partial().optional(),
    resetWorld: z.boolean().optional(),
  }),
  reset: z.strictObject({ confirm: z.string().max(16) }),
  externalEdit: z.strictObject({ count: z.number().int().min(1).max(10_000) }),
  upgrade: z.strictObject({ proposalId: z.string().min(1).max(200), confirm: z.boolean() }),
  canvasQuery: z.strictObject({ x: z.coerce.number().int(), y: z.coerce.number().int(), w: z.coerce.number().int().min(1), h: z.coerce.number().int().min(1), s: z.coerce.number().int().min(1).max(256) }).partial(),
};

function sendError(res: Response, status: number, code: string, message: string, details?: unknown): void {
  res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) } });
}

class RequestValidationError extends Error {
  readonly issues: { path: string; message: string }[];
  constructor(issues: { path: string; message: string }[]) {
    super('invalid request');
    this.issues = issues;
  }
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new RequestValidationError(result.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return result.data;
}

/** Maps any error to a stable JSON answer; never leaks a stack or a path. */
function handleError(error: unknown, res: Response): void {
  if (error instanceof RequestValidationError) {
    sendError(res, 400, 'INVALID_REQUEST', 'the request does not match the expected format', error.issues);
    return;
  }
  if (isEngineApiError(error)) {
    sendError(res, error.status, error.code, error.message);
    return;
  }
  const e = error as { name?: string; code?: unknown; message?: unknown };
  if ((e.name === 'TemplateError' || e.name === 'SettingsError' || e.name === 'PngError') && typeof e.code === 'string') {
    sendError(res, 400, e.code === 'INVALID_SETTINGS' ? 'INVALID_SETTINGS' : 'INVALID_TEMPLATE', typeof e.message === 'string' ? e.message : 'invalid input');
    return;
  }
  sendError(res, 500, 'INTERNAL_ERROR', 'the engine could not complete the request (see the server log)');
}

/** x, y, w, h: all four (a region) or none (the default area). */
function regionOf(q: { x?: number; y?: number; w?: number; h?: number }): { minX: number; minY: number; width: number; height: number } | undefined {
  if (q.x === undefined && q.y === undefined && q.w === undefined && q.h === undefined) return undefined;
  if (q.x === undefined || q.y === undefined || q.w === undefined || q.h === undefined) throw new RequestValidationError([{ path: 'x,y,w,h', message: 'give all four, or none' }]);
  return { minX: q.x, minY: q.y, width: q.w, height: q.h };
}

/** Wraps a handler: JSON result, errors mapped. */
function route(fn: (req: Request) => Promise<unknown> | unknown): RequestHandler {
  return async (req, res) => {
    try {
      const result = await fn(req);
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    } catch (error) {
      handleError(error, res);
    }
  };
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Origins that may drive the engine (HTTP and WebSocket): none (same-origin
 * tools), or an http(s) page; never a browser extension. The server-wide
 * Host/Origin checks apply on top.
 */
export function isEngineOriginAllowed(origin: string | undefined): boolean {
  return origin === undefined || origin === 'null' || /^https?:\/\//i.test(origin);
}

/** Refuses browser extension origins and non-JSON state-changing requests under /api/v1. */
export function v1Guards(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isEngineOriginAllowed(req.headers.origin)) {
      sendError(res, 403, 'FORBIDDEN_ORIGIN', 'this origin may not drive the engine');
      return;
    }
    if (STATE_CHANGING.has(req.method) && !req.is('application/json')) {
      sendError(res, 415, 'JSON_REQUIRED', 'send the request as application/json');
      return;
    }
    next();
  };
}

/** The /api/v1 engine router (mount at /api/v1). */
export function createEngineRouter(api: EngineApi): Router {
  const r = Router();
  r.use(v1Guards());

  // Engine state and commands.
  r.get('/engine/status', route(() => api.status()));
  r.post('/engine/start', route((req) => (parse(schemas.empty, req.body), api.start())));
  r.post('/engine/pause', route((req) => (parse(schemas.empty, req.body), api.pause())));
  r.post('/engine/resume', route((req) => (parse(schemas.empty, req.body), api.resume())));
  r.post('/engine/stop', route((req) => api.stop({ abort: parse(schemas.stop, req.body).abort === true })));
  r.put('/engine/selection', route((req) => api.selectTemplate(parse(schemas.select, req.body).templateId)));
  r.get('/engine/progress', route(() => {
    const s = api.status() as { scheduler?: unknown; state?: unknown; selection?: unknown };
    return { state: s.state, selection: s.selection, progress: s.scheduler ?? null };
  }));
  r.get('/engine/attempts', route(() => api.attemptsView()));

  // Templates of the simulation.
  r.get('/templates', route(() => api.listTemplates()));
  r.post('/templates', route((req) => {
    const body = parse(schemas.importTemplate, req.body);
    const png = Buffer.from(body.pngBase64, 'base64');
    if (png.length > MAX_PNG_BYTES) throw new RequestValidationError([{ path: 'pngBase64', message: `at most ${MAX_PNG_BYTES} bytes` }]);
    return api.importTemplate({ name: body.name, png: new Uint8Array(png), x: body.x, y: body.y, strategy: body.strategy });
  }));
  r.get('/templates/:id', route((req) => api.templateInfoOf(parse(ID, req.params.id))));
  r.get('/templates/:id/image', route((req) => {
    const q = parse(schemas.canvasQuery, req.query);
    return api.templateImage(parse(ID, req.params.id), regionOf(q), q.s);
  }));
  r.post('/templates/:id/move', route((req) => {
    const { x, y } = parse(schemas.move, req.body);
    return api.moveTemplate(parse(ID, req.params.id), x, y);
  }));

  // Simulator.
  r.get('/simulator/settings', route(() => ({ settings: api.settings, simulated: true })));
  r.put('/simulator/settings', route((req) => api.configure(parse(schemas.settings, req.body))));
  r.post('/simulator/reset', route((req) => api.resetWorld(parse(schemas.reset, req.body).confirm)));
  r.post('/simulator/agent/reset', route((req) => (parse(schemas.empty, req.body), api.resetAgent())));
  r.post('/simulator/external-edit', route((req) => api.simulateExternalEdit(parse(schemas.externalEdit, req.body).count)));
  r.get('/simulator/canvas', route((req) => {
    const q = parse(schemas.canvasQuery, req.query);
    return api.canvasRegion(regionOf(q), q.s);
  }));

  // Resources and simulated upgrades (never automatic).
  r.get('/resources', route(() => api.resourcesView()));
  r.post('/resources/upgrades', route((req) => {
    const body = parse(schemas.upgrade, req.body);
    return api.applyUpgrade(body.proposalId, body.confirm);
  }));

  // Journal.
  r.get('/journal/diagnosis', route(() => api.journalDiagnosis()));
  r.post('/journal/compact', route((req) => (parse(schemas.empty, req.body), api.compact())));

  // Backup (Phase 1B.10): stopped only, written where the server decides (never a client path).
  r.post('/backup', route((req) => (parse(schemas.empty, req.body), api.backup())));

  // Demonstration (Phase 1B.10): set up on an empty project only.
  r.get('/demo', route(() => api.demoAvailability()));
  r.post('/demo', route((req) => (parse(schemas.empty, req.body), api.setupDemo())));

  // Unknown /api/v1 route: JSON 404, never the UI.
  r.use((_req, res) => sendError(res, 404, 'NOT_FOUND', 'unknown API route'));
  return r;
}
