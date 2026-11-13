/**
 * Local access protection for the management server.
 *
 * The server runs on the user's machine and holds sensitive state. Any web
 * page open in the user's browser can try to reach it. This module rejects:
 *
 * - DNS rebinding: requests whose Host header names a host that is not this
 *   machine (an attacker domain resolving to 127.0.0.1).
 * - Cross-site requests: a browser Origin outside the allow-list, or a
 *   cross-site navigation/subresource without an Origin (Sec-Fetch-Site).
 *
 * Checks compare host *names* only, never ports: the server may fall back to
 * another port when the configured one is busy.
 *
 * All decision logic is pure and unit-tested; the Express middleware and the
 * WebSocket verifier are thin adapters around checkAccess().
 */

import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'node:http';
import { isWildcardHost } from '../config/network.js';

/** Host names that always designate this machine. */
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '::1'];

export interface LocalAccessPolicy {
  /** Lower-case host names (no port, IPv6 without brackets). */
  allowedHostnames: ReadonlySet<string>;
  /** Anchored patterns compiled from ALLOWED_ORIGINS. */
  originPatterns: readonly RegExp[];
}

export interface AccessRequest {
  host?: string;
  origin?: string;
  secFetchSite?: string;
}

export type AccessDecision =
  | { ok: true }
  | { ok: false; reason: 'invalid-host' | 'forbidden-host' | 'forbidden-origin' | 'cross-site' };

/**
 * Extract the host name from a Host header value.
 * "localhost:3000" -> "localhost", "[::1]:3000" -> "::1".
 * Returns null for malformed values.
 */
export function hostnameFromHostHeader(header: string | undefined): string | null {
  if (!header) return null;
  const value = header.trim().toLowerCase();
  if (value === '') return null;

  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return null;
    const rest = value.slice(end + 1);
    if (rest !== '' && !/^:\d{1,5}$/.test(rest)) return null;
    const inner = value.slice(1, end);
    return /^[0-9a-f:.]+$/.test(inner) ? inner : null;
  }

  const match = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(value);
  return match ? match[1] : null;
}

/**
 * Build the set of host names the server answers to.
 * - Loopback names are always allowed.
 * - A specific bind address is allowed.
 * - With a wildcard bind (explicit LAN exposure), the machine's own
 *   interface addresses are allowed. IP literals cannot be used for DNS
 *   rebinding, so this stays safe.
 * - Extra names can be added explicitly (ALLOWED_HOSTS).
 */
export function buildAllowedHostnames(
  bindHost: string,
  extraHostnames: readonly string[] = [],
  interfaceAddresses: readonly string[] = []
): Set<string> {
  const names = new Set<string>(LOOPBACK_HOSTNAMES);
  if (isWildcardHost(bindHost)) {
    for (const address of interfaceAddresses) names.add(address.toLowerCase());
  } else {
    names.add(bindHost.toLowerCase());
  }
  for (const extra of extraHostnames) {
    const name = hostnameFromHostHeader(extra);
    if (name) names.add(name);
  }
  return names;
}

/**
 * Compile ALLOWED_ORIGINS entries into anchored regular expressions.
 * Every character is literal except "*", which matches one label made of
 * letters, digits and hyphens (no dots, colons or slashes). So
 * "http://localhost:*" accepts "http://localhost:5173" but rejects
 * "http://localhost:3000.evil.com".
 */
export function compileOriginPatterns(patterns: readonly string[]): RegExp[] {
  return patterns
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => {
      const escaped = p.replace(/[.+?^${}()|[\]\\/]/g, '\\$&').replace(/\*/g, '[A-Za-z0-9-]+');
      return new RegExp(`^${escaped}$`);
    });
}

/**
 * An Origin is allowed when it matches an explicit pattern, or when it is
 * an http(s) origin whose host name is one of the allowed host names (the
 * management UI served by this very server).
 */
export function isAllowedOrigin(origin: string, policy: LocalAccessPolicy): boolean {
  if (policy.originPatterns.some((re) => re.test(origin))) return true;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // includes the opaque "null" origin
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.origin !== origin) return false; // reject origins carrying a path or credentials
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return policy.allowedHostnames.has(hostname);
}

/** Decide whether a request may reach the application. */
export function checkAccess(request: AccessRequest, policy: LocalAccessPolicy): AccessDecision {
  const hostname = hostnameFromHostHeader(request.host);
  if (hostname === null) return { ok: false, reason: 'invalid-host' };
  if (!policy.allowedHostnames.has(hostname)) return { ok: false, reason: 'forbidden-host' };

  if (request.origin !== undefined) {
    return isAllowedOrigin(request.origin, policy) ? { ok: true } : { ok: false, reason: 'forbidden-origin' };
  }

  // No Origin header: non-browser clients (curl, scripts) are allowed, but a
  // browser that marks the request as cross-site (image, form, link) is not.
  if (request.secFetchSite === 'cross-site') return { ok: false, reason: 'cross-site' };

  return { ok: true };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toAccessRequest(req: IncomingMessage): AccessRequest {
  return {
    host: headerValue(req.headers.host),
    origin: headerValue(req.headers.origin),
    secFetchSite: headerValue(req.headers['sec-fetch-site']),
  };
}

/** Express middleware: answers 403 when checkAccess() refuses the request. */
export function createLocalAccessMiddleware(
  policy: LocalAccessPolicy,
  onReject?: (reason: string, req: Request) => void
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const decision = checkAccess(toAccessRequest(req), policy);
    if (decision.ok) {
      next();
      return;
    }
    onReject?.(decision.reason, req);
    res.status(403).json({ error: 'Forbidden', reason: decision.reason });
  };
}

/** WebSocket handshake verifier (ws `verifyClient`). */
export function createWebSocketVerifier(policy: LocalAccessPolicy, onReject?: (reason: string) => void) {
  return (info: { req: IncomingMessage }): boolean => {
    const decision = checkAccess(toAccessRequest(info.req), policy);
    if (!decision.ok) onReject?.(decision.reason);
    return decision.ok;
  };
}
