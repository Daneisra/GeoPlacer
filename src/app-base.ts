/**
 * Server-wide protections, applied in this order to every route (Phase 1A),
 * extracted in Phase 1B.9 so that the route tests run behind the very same
 * stack as the server:
 * 1. Host (anti DNS rebinding) and Origin (anti cross-site) checks;
 * 2. CORS headers for the allowed origins only;
 * 3. rate limiter (before the body is parsed);
 * 4. JSON body parser with a size limit.
 */

import express, { type Express, type Request } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createLocalAccessMiddleware, isAllowedOrigin, type LocalAccessPolicy } from './middleware/local-access.js';

export interface BaseProtections {
  readonly policy: LocalAccessPolicy;
  readonly rateLimitWindowMs: number;
  readonly rateLimitMax: number;
  readonly jsonLimit: string | number;
  readonly onBlocked?: (reason: string, req: Request) => void;
}

export function applyBaseProtections(app: Express, options: BaseProtections): void {
  app.use(createLocalAccessMiddleware(options.policy, options.onBlocked ?? (() => undefined)));
  app.use(
    cors({
      // Requests with a disallowed Origin are already rejected above; this only
      // decides which CORS headers allowed origins receive.
      origin: (origin, callback) => {
        callback(null, !origin || isAllowedOrigin(origin, options.policy));
      },
      credentials: true,
    })
  );
  app.use(
    rateLimit({
      windowMs: options.rateLimitWindowMs,
      limit: options.rateLimitMax,
      message: 'Too many requests from this IP, please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
    })
  );
  app.use(express.json({ limit: options.jsonLimit }));
}
