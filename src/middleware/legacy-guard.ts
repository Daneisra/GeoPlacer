/**
 * Isolation of the inherited Wplacer features (Phase 1B.10).
 *
 * GeoPlacer V1 is a LOCAL SIMULATION. The inherited routes below could
 * contact Wplace (account login and status checks), feed the inherited
 * painting engine (templates to run, start command), or serve its
 * anti-bot plumbing (tokens, signing bridge, proxies). They are refused here
 * with a stable answer, before their handlers, whatever the spelling of the
 * path (case, trailing slash) or the method alias (HEAD for GET).
 *
 * The handlers are kept in the code (traceability of the fork); the HTTP
 * client they would use refuses any request too (services/http-client.ts):
 * two independent locks.
 *
 * Purely local inherited routes stay available: listing and deleting users
 * and inherited templates, settings, logs, palette, color ordering, overlay
 * coordinates.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const LEGACY_DISABLED_CODE = 'LEGACY_DISABLED';
export const LEGACY_DISABLED_STATUS = 410;

export interface DisabledLegacyRoute {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly pattern: RegExp;
  /** What the route did (French, shown to the user). */
  readonly feature: string;
  /** Only refused when this returns true (default: always). */
  readonly when?: (req: Request) => boolean;
}

export const DISABLED_LEGACY_ROUTES: readonly DisabledLegacyRoute[] = [
  // Real accounts: login and status checks contact Wplace.
  { method: 'POST', pattern: /^\/user$/, feature: 'ajout d’un compte réel (connexion à Wplace)' },
  { method: 'GET', pattern: /^\/user\/status\/[^/]+$/, feature: 'vérification d’un compte réel' },
  { method: 'POST', pattern: /^\/users\/status$/, feature: 'vérification des comptes réels' },
  // Inherited painting engine: its templates and its start command.
  { method: 'POST', pattern: /^\/template$/, feature: 'création d’un modèle de l’ancien moteur' },
  { method: 'POST', pattern: /^\/templates\/import$/, feature: 'import d’un modèle de l’ancien moteur' },
  { method: 'PUT', pattern: /^\/template\/edit\/[^/]+$/, feature: 'modification d’un modèle de l’ancien moteur' },
  {
    method: 'PUT',
    pattern: /^\/template\/[^/]+$/,
    feature: 'démarrage de l’ancien moteur',
    // Stopping (running: false) stays possible: the safe direction.
    when: (req) => !(typeof req.body === 'object' && req.body !== null && (req.body as { running?: unknown }).running === false),
  },
  // Anti-bot plumbing and proxies of the inherited engine.
  { method: 'GET', pattern: /^\/token-needed$/, feature: 'jetons anti-bot de l’ancien moteur' },
  { method: 'POST', pattern: /^\/t$/, feature: 'jetons anti-bot de l’ancien moteur' },
  { method: 'POST', pattern: /^\/bridge$/, feature: 'pont de l’extension héritée' },
  { method: 'GET', pattern: /^\/sign-request$/, feature: 'signature de requêtes de l’ancien moteur' },
  { method: 'POST', pattern: /^\/sign-response$/, feature: 'signature de requêtes de l’ancien moteur' },
  { method: 'POST', pattern: /^\/bot\/activate$/, feature: 'activation de l’ancien moteur' },
  { method: 'POST', pattern: /^\/bot\/deactivate$/, feature: 'activation de l’ancien moteur' },
  { method: 'POST', pattern: /^\/reload-proxies$/, feature: 'proxys de l’ancien moteur' },
];

/** Path as Express routes it: case-insensitive, an optional trailing slash. */
function normalise(path: string): string {
  const lower = path.toLowerCase();
  return lower.length > 1 ? lower.replace(/\/+$/, '') : lower;
}

/** The disabled route matching this request, if any (exported for the tests). */
export function disabledLegacyRoute(method: string, path: string, req?: Request): DisabledLegacyRoute | undefined {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  const p = normalise(path);
  return DISABLED_LEGACY_ROUTES.find((r) => r.method === m && r.pattern.test(p) && (r.when === undefined || req === undefined || r.when(req)));
}

/** Refuses the disabled inherited routes (mount before the inherited routers, after the body parser). */
export function legacyGuard(onRefused?: (route: DisabledLegacyRoute, req: Request) => void): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const route = disabledLegacyRoute(req.method, req.path, req);
    if (route === undefined) {
      next();
      return;
    }
    onRefused?.(route, req);
    res.status(LEGACY_DISABLED_STATUS).json({
      error: `Désactivé dans GeoPlacer V1 (simulation locale uniquement) : ${route.feature}.`,
      code: LEGACY_DISABLED_CODE,
    });
  };
}
