import { Router, type Request } from 'express';
import { z } from 'zod';
import { ConnectorError, type ConnectorHttpChannel } from '@geoplacer/engine-service';
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

export function createConnectorRouter(engine: EngineApi, httpChannel?: ConnectorHttpChannel): Router {
    const router = Router();
    router.use((req, res, next) => {
        // This control surface stays loopback-only even when the dashboard is exposed to a LAN.
        if (
            !isLoopbackChannel(req) ||
            (req.headers.origin !== undefined && !sameOrigin(req)) ||
            req.headers['sec-fetch-site'] === 'cross-site'
        ) {
            res.status(403).json({
                error: { code: 'CONNECTOR_FORBIDDEN', message: 'local same-origin dashboard required' },
            });
            return;
        }
        if (req.method !== 'GET' && !req.is('application/json')) {
            res.sendStatus(415);
            return;
        }
        res.setHeader('Cache-Control', 'no-store');
        next();
    });
    const action =
        (fn: (req: Request) => unknown | Promise<unknown>) => async (req: Request, res: import('express').Response) => {
            try {
                res.json(await fn(req));
            } catch (error) {
                const e = error as { code?: string; message?: string; status?: number };
                const invalid = error instanceof z.ZodError;
                const known =
                    typeof e.status === 'number' && e.status >= 400 && e.status <= 599 && typeof e.code === 'string';
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
    router.get(
        '/http',
        action(() => httpChannel?.info() ?? { enabled: false, pending: null, active: false })
    );
    const regionControl = (req: Request) => {
        if (!httpChannel?.info().active)
            throw new ConnectorError('CONNECTOR_UNAVAILABLE', 'Coupler le lecteur régional avant cette commande.');
        httpChannel.control(req.header('X-GeoPlacer-Approval') ?? '');
    };
    router.post(
        '/regions',
        action((req) => {
            regionControl(req);
            const b = z.strictObject({ regions: z.array(z.unknown()).max(16) }).parse(req.body);
            return engine.configureConnectorRegions!(b.regions);
        })
    );
    const batchControl = (req: Request) => {
        if (!httpChannel) throw new ConnectorError('CONNECTOR_UNAVAILABLE', 'approval channel required');
        httpChannel.control(req.header('X-GeoPlacer-Approval') ?? '');
        return engine.singlePixelWriter!.batch;
    };
    router.post(
        '/batch/prepare',
        action((req) => {
            const batch = batchControl(req);
            const b = z
                .strictObject({
                    mode: z.enum(['fake', 'real']),
                    limit: z.number().int().min(1).max(25),
                    execution: z.enum(['sequential', 'grouped', 'session']).default('sequential'),
                    energyBudget: z.number().int().min(1).max(25).optional(),
                })
                .superRefine((b, ctx) => {
                    if (b.execution !== 'session' && b.limit > 5)
                        ctx.addIssue({ code: 'custom', path: ['limit'], message: 'Lot limité à cinq pixels.' });
                    if (b.execution === 'session' && b.energyBudget === undefined)
                        ctx.addIssue({ code: 'custom', path: ['energyBudget'], message: 'Budget de session requis.' });
                    if (b.execution !== 'session' && b.energyBudget !== undefined)
                        ctx.addIssue({
                            code: 'custom',
                            path: ['energyBudget'],
                            message: 'Budget réservé aux sessions.',
                        });
                })
                .parse(req.body);
            if (b.mode === 'real') regionControl(req);
            if (b.mode === 'real' && b.execution === 'grouped' && (httpChannel!.info().batchProtocol ?? 0) < 2)
                throw new ConnectorError(
                    'CONNECTOR_UNAVAILABLE',
                    'Installer et coupler le lecteur 0.7.0 pour un envoi groupé.'
                );
            if (b.mode === 'real' && b.execution === 'session' && httpChannel!.info().batchProtocol !== 3)
                throw new ConnectorError(
                    'CONNECTOR_UNAVAILABLE',
                    'Installer et coupler le lecteur 0.8.0 pour une session supervisée.'
                );
            return batch.prepare(b.mode, b.limit, b.execution, b.energyBudget);
        })
    );
    const consent = z.strictObject({
        batchId: z.string().uuid(),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        approved: z.literal(true),
    });
    router.post(
        '/batch/approve',
        action((req) => {
            const batch = batchControl(req),
                b = consent.parse(req.body);
            if (batch.view().mode === 'real') {
                regionControl(req);
                if (batch.view().execution === 'session' && httpChannel!.info().batchProtocol !== 3)
                    throw new ConnectorError('CONNECTOR_UNAVAILABLE', 'Lecteur 0.8.0 requis pour cette session.');
                if (batch.view().execution === 'grouped' && (httpChannel!.info().batchProtocol ?? 0) < 2)
                    throw new ConnectorError('CONNECTOR_UNAVAILABLE', 'Lecteur 0.7.0 requis pour ce groupe.');
            }
            return batch.approve(b.batchId, b.digest);
        })
    );
    router.post(
        '/batch/resume',
        action((req) => {
            const batch = batchControl(req),
                b = consent.parse(req.body);
            if (batch.view().mode === 'real') {
                regionControl(req);
                if (batch.view().execution === 'session' && httpChannel!.info().batchProtocol !== 3)
                    throw new ConnectorError('CONNECTOR_UNAVAILABLE', 'Lecteur 0.8.0 requis pour cette session.');
                if (batch.view().execution === 'grouped' && (httpChannel!.info().batchProtocol ?? 0) < 2)
                    throw new ConnectorError('CONNECTOR_UNAVAILABLE', 'Lecteur 0.7.0 requis pour ce groupe.');
            }
            return batch.resume(b.batchId, b.digest);
        })
    );
    router.post(
        '/batch/pause',
        action((req) => {
            const batch = batchControl(req);
            z.strictObject({}).parse(req.body);
            return batch.pause();
        })
    );
    router.post(
        '/batch/stop',
        action((req) => {
            const batch = batchControl(req);
            z.strictObject({}).parse(req.body);
            return batch.stop();
        })
    );
    router.post(
        '/batch/reconcile',
        action((req) => {
            const batch = batchControl(req);
            z.strictObject({}).parse(req.body);
            return batch.reconcile();
        })
    );
    router.post(
        '/pixel/prepare',
        action((req) => {
            if (!httpChannel) throw new ConnectorError('CONNECTOR_UNAVAILABLE', 'approval channel required');
            httpChannel.control(req.header('X-GeoPlacer-Approval') ?? '');
            const b = z.strictObject({ mode: z.enum(['fake', 'real']) }).parse(req.body);
            if (b.mode === 'real') regionControl(req);
            return engine.singlePixelWriter!.prepare(b.mode);
        })
    );
    router.post(
        '/pixel/confirm',
        action((req) => {
            if (!httpChannel) throw new ConnectorError('CONNECTOR_UNAVAILABLE', 'approval channel required');
            httpChannel.control(req.header('X-GeoPlacer-Approval') ?? '');
            const b = z
                .strictObject({
                    attemptId: z.string().uuid(),
                    gridX: z.number().int().safe(),
                    gridY: z.number().int().safe(),
                    color: z.number().int().min(0).max(0xffffff),
                    approved: z.literal(true),
                })
                .parse(req.body);
            if (engine.singlePixelWriter!.view().mode === 'real') regionControl(req);
            return engine.singlePixelWriter!.confirm(b.attemptId, b);
        })
    );
    router.post(
        '/pixel/stop',
        action((req) => {
            if (!httpChannel) throw new ConnectorError('CONNECTOR_UNAVAILABLE', 'approval channel required');
            httpChannel.control(req.header('X-GeoPlacer-Approval') ?? '');
            z.strictObject({}).parse(req.body);
            return engine.singlePixelWriter!.stop();
        })
    );
    router.post(
        '/pixel/reconcile',
        action((req) => {
            if (!httpChannel) throw new ConnectorError('CONNECTOR_UNAVAILABLE', 'approval channel required');
            httpChannel.control(req.header('X-GeoPlacer-Approval') ?? '');
            z.strictObject({}).parse(req.body);
            return engine.singlePixelWriter!.reconcile();
        })
    );
    router.post(
        '/regions/restore',
        action((req) => {
            regionControl(req);
            z.strictObject({}).parse(req.body);
            return engine.configureConnectorRegions!([], true);
        })
    );
    router.post(
        '/regions/observe',
        action(async (req) => {
            regionControl(req);
            const b = z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/) }).parse(req.body);
            const view = (await engine.connectorView!()) as { bound: boolean; source: string; connected: boolean };
            if (!view.bound || !view.connected || view.source !== 'geopixels')
                throw new ConnectorError('CONNECTOR_BINDING_REQUIRED', 'Lier le modèle avant cette observation.');
            engine.connector!.monitoring.requestRegion(b.id);
            return { requested: true };
        })
    );
    router.post(
        '/monitor',
        action(async (req) => {
            const b = z
                .strictObject({
                    action: z.enum(['start', 'pause', 'resume', 'stop']),
                    intervalMs: z.number().int().min(5000).max(60000),
                })
                .parse(req.body);
            if (!httpChannel?.info().active)
                throw new ConnectorError('CONNECTOR_UNAVAILABLE', 'Coupler le lecteur HTTP avant la surveillance.');
            httpChannel.control(req.header('X-GeoPlacer-Approval') ?? '');
            const view = (await engine.connectorView!()) as { bound: boolean; source: string; connected: boolean };
            if (b.action !== 'stop' && (!view.bound || !view.connected || view.source !== 'geopixels'))
                throw new ConnectorError('CONNECTOR_BINDING_REQUIRED', 'Lier le modèle actif avant la surveillance.');
            return engine.connector!.monitoring.command(b.action, b.intervalMs);
        })
    );
    router.post(
        '/http/pair',
        action((req) => {
            const b = z
                .strictObject({ origin: z.enum(['https://geopixels.net', 'https://www.geopixels.net']) })
                .parse(req.body);
            if (!httpChannel) throw new Error('reader unavailable');
            return httpChannel.issue(req.header('X-GeoPlacer-Approval') ?? '', b.origin);
        })
    );
    router.post(
        '/http/approve',
        action((req) => {
            const b = z.strictObject({ requestId: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.body);
            if (!httpChannel) throw new Error('reader unavailable');
            return httpChannel.approve(req.header('X-GeoPlacer-Approval') ?? '', b.requestId);
        })
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
            const body = z
                .strictObject({ mode: z.enum(['read-only', 'local-fake']), origin: z.string().max(200) })
                .parse(req.body);
            if (body.mode === 'read-only')
                throw new ConnectorError(
                    'CONNECTOR_LEGACY_READER_DISABLED',
                    'Le lecteur réel exige le couplage HTTP approuvé.'
                );
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
