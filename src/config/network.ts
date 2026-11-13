/**
 * Network binding helpers (pure functions, unit-tested).
 *
 * GeoPlacer listens on the loopback interface by default. Exposing the
 * server to the local network requires an explicit HOST=0.0.0.0 (or a
 * specific interface address) in the environment.
 */

import { isIP } from 'node:net';

export const DEFAULT_BIND_HOST = '127.0.0.1';

export interface BindHostResolution {
  host: string;
  /** Set when the configured value was rejected or normalised. */
  warning?: string;
}

/**
 * Resolve the address the HTTP server binds to from the raw HOST value.
 * Accepts IPv4/IPv6 literals and "localhost"; anything else falls back to
 * 127.0.0.1 so a typo can never silently expose the server.
 */
export function resolveBindHost(raw: string | undefined): BindHostResolution {
  if (raw === undefined) return { host: DEFAULT_BIND_HOST };

  const value = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (value === '') return { host: DEFAULT_BIND_HOST };

  if (value.toLowerCase() === 'localhost') return { host: DEFAULT_BIND_HOST };

  // Accept bracketed IPv6 such as "[::1]".
  const unbracketed = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (isIP(unbracketed) !== 0) return { host: unbracketed };

  return {
    host: DEFAULT_BIND_HOST,
    warning: `Invalid HOST value "${value}": expected an IP address or "localhost". Falling back to ${DEFAULT_BIND_HOST}.`,
  };
}

/** True when the address listens on every interface. */
export function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

/** True for loopback addresses (127.0.0.0/8 and ::1). */
export function isLoopbackHost(host: string): boolean {
  return host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
