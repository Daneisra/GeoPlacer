import { validWriterResources } from '@geoplacer/engine-service';
import express, { Router, type ErrorRequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { ConnectorHttpChannel } from '@geoplacer/engine-service';
import { isLoopbackChannel } from './connector-router.js';

/** Dedicated capability-authenticated ingress. Does not change management CORS/Origin rules. */
export function createPrivilegedReaderRouter(channel: ConnectorHttpChannel): Router {
    const router = Router();
    router.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const origin = req.headers.origin;
        const allowed =
            origin === undefined ||
            origin === 'null' ||
            ['https://geopixels.net', 'https://www.geopixels.net'].includes(origin) ||
            /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
            /^moz-extension:\/\/[a-f0-9-]{36}$/.test(origin);
        if (!isLoopbackChannel(req) || !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '') || !allowed) {
            res.status(403).json({ error: 'privileged reader access refused' });
            return;
        }
        // No Access-Control-Allow-Origin. Browser preflights/forms cannot use this channel.
        if (req.method !== 'POST') {
            res.sendStatus(405);
            return;
        }
        if (req.url.includes('?') || !req.is('application/json')) {
            res.sendStatus(415);
            return;
        }
        next();
    });
    router.use(rateLimit({ windowMs: 1000, limit: 40, standardHeaders: true, legacyHeaders: false }));
    const claimLimit = rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false });
    const small = express.json({ limit: 2048, strict: true });
    const fail = (res: express.Response) =>
        res.status(409).json({ error: 'reader request refused; check pairing, approval or expiry' });
    router.post('/claim', claimLimit, small, (req, res) => {
        try {
            const b = z
                .strictObject({
                    protocol: z.literal(1),
                    origin: z.enum(['https://geopixels.net', 'https://www.geopixels.net']),
                    code: z.string().regex(/^[a-f0-9]{64}$/),
                })
                .parse(req.body);
            res.json(channel.claim(b.origin, b.code));
        } catch {
            fail(res);
        }
    });
    router.use((req, res, next) => {
        try {
            const value = req.headers.authorization;
            if (!value?.startsWith('Bearer ')) throw new Error();
            channel.verify(value.slice(7));
            res.locals.capability = value.slice(7);
            next();
        } catch {
            res.status(403).json({ error: 'reader capability refused' });
        }
    });
    const pace = (start: number) =>
        new Promise((resolve) => setTimeout(resolve, Math.max(0, 50 - (Date.now() - start))));
    router.post('/pixel-claim', small, async (req, res) => {
        try {
            z.strictObject({ protocol: z.literal(1) }).parse(req.body);
            res.json({ command: await channel.claimPixel(res.locals.capability as string) });
        } catch {
            fail(res);
        }
    });
    router.post('/pixel-check', small, (req, res) => {
        try {
            const b = z.strictObject({ protocol: z.literal(1), attemptId: z.string().uuid() }).parse(req.body);
            res.json(channel.pixelAllowed(res.locals.capability as string, b.attemptId));
        } catch {
            fail(res);
        }
    });
    router.post('/pixel-result', small, async (req, res) => {
        try {
            const b = z
                .strictObject({
                    protocol: z.literal(1),
                    attemptId: z.string().uuid(),
                    result: z.enum(['confirmed', 'not-sent', 'uncertain']),
                })
                .parse(req.body);
            const view = await channel.pixelResult(res.locals.capability as string, b.attemptId, b.result);
            res.json({ accepted: true, state: view.state });
        } catch {
            fail(res);
        }
    });
    router.post('/batch-claim', small, async (req, res) => {
        try {
            z.strictObject({ protocol: z.literal(1) }).parse(req.body);
            res.json({ command: channel.claimBatch(res.locals.capability as string) });
        } catch {
            fail(res);
        }
    });
    router.post('/batch-check', small, (req, res) => {
        try {
            const b = z
                .strictObject({ protocol: z.literal(1), batchId: z.string().uuid(), attemptId: z.string().uuid() })
                .parse(req.body);
            res.json(channel.batchAllowed(res.locals.capability as string, b.batchId, b.attemptId));
        } catch {
            fail(res);
        }
    });
    router.post('/batch-result', small, async (req, res) => {
        try {
            const b = z
                .strictObject({
                    protocol: z.literal(1),
                    batchId: z.string().uuid(),
                    attemptId: z.string().uuid(),
                    result: z.enum(['confirmed', 'not-sent', 'uncertain', 'waiting-resources']),
                })
                .parse(req.body);
            const view = await channel.batchResult(res.locals.capability as string, b.batchId, b.attemptId, b.result);
            res.json({
                accepted: true,
                state: view.state,
                confirmed: view.confirmed,
                acceptedRequests: view.acceptedRequests,
            });
        } catch {
            fail(res);
        }
    });
    router.post('/status', small, async (req, res) => {
        try {
            const start = Date.now();
            const b = z
                .strictObject({
                    protocol: z.literal(1),
                    readerVersion: z
                        .union([z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8)])
                        .optional(),
                    waitMs: z.literal(5000).optional(),
                    writerResources: z.custom(validWriterResources).optional(),
                    abortedCapture: z
                        .string()
                        .regex(/^[a-zA-Z0-9._:-]{1,128}$/)
                        .optional(),
                    monitoring: z
                        .strictObject({
                            revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
                            state: z.enum(['running', 'paused', 'stopped']),
                        })
                        .optional(),
                })
                .parse(req.body);
            if ((b.monitoring || b.waitMs || b.abortedCapture) && ![3, 4, 5, 6, 7, 8].includes(b.readerVersion ?? 0))
                throw new Error('reader version required');
            if (b.writerResources !== undefined && b.readerVersion !== 8) throw new Error('resource protocol required');
            const abort = new AbortController();
            res.once('close', () => abort.abort());
            const answer = b.waitMs
                ? await channel.poll(
                      res.locals.capability as string,
                      b.readerVersion!,
                      b.monitoring,
                      abort.signal,
                      b.abortedCapture,
                      b.writerResources
                  )
                : channel.status(
                      res.locals.capability as string,
                      b.readerVersion,
                      b.monitoring,
                      b.abortedCapture,
                      b.writerResources
                  );
            await pace(start);
            channel.verify(res.locals.capability as string);
            if (!res.destroyed) res.json(answer);
        } catch {
            if (!res.destroyed) fail(res);
        }
    });
    router.post('/observations', express.json({ limit: 768 * 1024, strict: true }), async (req, res) => {
        try {
            const start = Date.now();
            const b = z
                .strictObject({ protocol: z.literal(1), observations: z.array(z.unknown()).min(1).max(2) })
                .parse(req.body);
            const answer = channel.batch(res.locals.capability as string, b.observations);
            await pace(start);
            channel.verify(res.locals.capability as string);
            if (!res.destroyed) res.json(answer);
        } catch {
            fail(res);
        }
    });
    router.post('/disconnect', small, (req, res) => {
        try {
            z.strictObject({ protocol: z.literal(1) }).parse(req.body);
            res.json(channel.disconnect(res.locals.capability as string));
        } catch {
            fail(res);
        }
    });
    router.use((_req, res) => {
        res.sendStatus(404);
    });
    const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
        const status = (error as { status?: number }).status === 413 ? 413 : 400;
        res.status(status).json({ error: 'invalid or oversized reader message' });
    };
    router.use(errors);
    return router;
}
