import { Router, type Request } from 'express';
import { z } from 'zod';
import { asRgb } from '@geoplacer/core';
import type { EngineApi } from './engine-api.js';
import { hostnameFromHostHeader } from '../../middleware/local-access.js';

export const CONNECTOR_WS_PATH = '/api/v1/connector/channel';
export function isLoopbackChannel(req: { headers: { host?: string }; socket: { remoteAddress?: string } }): boolean {
  const host = hostnameFromHostHeader(req.headers.host);
  return (
    host !== null &&
    ['localhost', '127.0.0.1', '::1'].includes(host) &&
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
  );
}

export function createConnectorRouter(engine: EngineApi): Router {
  const router = Router();
  router.use((req, res, next) => {
    // This control surface stays loopback-only even when the dashboard is exposed to a LAN.
    if (
      !isLoopbackChannel(req) ||
      (req.headers.origin !== undefined && !sameOrigin(req)) ||
      req.headers['sec-fetch-site'] === 'cross-site'
    ) {
      res.status(403).json({ error: { code: 'CONNECTOR_FORBIDDEN', message: 'local same-origin dashboard required' } });
      return;
    }
    if (req.method !== 'GET' && !req.is('application/json')) {
      res.sendStatus(415);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const action = (fn: (req: Request) => unknown | Promise<unknown>) => async (req: Request, res: import('express').Response) => {
    try {
      res.json(await fn(req));
    } catch (error) {
      const e = error as { code?: string; message?: string; status?: number };
      const invalid = error instanceof z.ZodError;
      const known = typeof e.status === 'number' && e.status >= 400 && e.status <= 599 && typeof e.code === 'string';
      res.status(invalid ? 400 : known ? e.status! : 500).json({
        error: {
          code: invalid ? 'CONNECTOR_INVALID' : known ? e.code : 'CONNECTOR_FAILED',
          message: invalid
            ? 'invalid connector request'
            : known
              ? (e.message ?? 'connector request refused')
              : 'the connector could not complete the request',
        },
      });
    }
  };
  router.get(
    '/status',
    action(() => engine.connectorView!())
  );
  router.post(
    '/source',
    action((req) => {
      const body = z.strictObject({ source: z.enum(['simulation', 'geopixels']) }).parse(req.body);
      return engine.selectSource!(body.source);
    })
  );
  router.post(
    '/pair',
    action((req) => {
      const body = z.strictObject({ mode: z.enum(['read-only', 'local-fake']), origin: z.string().max(200) }).parse(req.body);
      return engine.pairing!.issue(body.mode, body.origin);
    })
  );
  router.post(
    '/revoke',
    action((req) => {
      z.strictObject({}).parse(req.body);
      engine.pairing!.revoke();
      engine.connector!.disconnect('revoked by user');
      return { revoked: true };
    })
  );
  router.post(
    '/policy',
    action((req) => {
      const kind = z.enum(['energy-pack', 'max-energy', 'regen-speed', 'color-unlock']);
      const nonnegative = z.number().int().min(0).max(1_000_000_000);
      const policy = z
        .strictObject({
          enabled: z.strictObject({
            'energy-pack': z.boolean(),
            'max-energy': z.boolean(),
            'regen-speed': z.boolean(),
            'color-unlock': z.boolean(),
          }),
          priority: z.array(kind).max(4),
          targetCapacity: nonnegative,
          requiredColors: z.array(z.number().int().min(0).max(0xffffff)).max(256),
          maxBudget: nonnegative,
          minimumReserve: nonnegative,
        })
        .parse(req.body);
      return engine.connectorProposals!({ ...policy, requiredColors: policy.requiredColors.map(asRgb) });
    })
  );
  router.post(
    '/bind',
    action((req) => {
      z.strictObject({}).parse(req.body);
      return engine.bindConnector!();
    })
  );
  return router;
}
function sameOrigin(req: Request): boolean {
  try {
    const u = new URL(req.headers.origin!);
    return u.origin === req.headers.origin && u.host === req.headers.host && u.protocol === 'http:';
  } catch {
    return false;
  }
}
