/**
 * Server configuration resolved from environment variables (pure, unit-tested).
 *
 * Every variable is optional: a missing .env file, an empty value or an
 * invalid value falls back to a safe default, and invalid values produce a
 * warning logged at startup. See .env.example for the documented variables.
 */

import { resolveBindHost, type BindHostResolution } from './network.js';

export const DEFAULT_PORT = 3000;
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ['http://localhost:*', 'http://127.0.0.1:*', 'chrome-extension://*'];
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_MAX = 300;
export const DEFAULT_MAX_WS_CONNECTIONS = 50;
export const DEFAULT_WS_PING_INTERVAL_MS = 30_000;
export const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 3_600_000;
export const DEFAULT_JSON_BODY_LIMIT = '12mb';
export const DEFAULT_WPLACE_BASE = 'https://backend.wplace.live';

export interface ServerConfig {
  readonly host: BindHostResolution;
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly rateLimitWindowMs: number;
  readonly rateLimitMax: number;
  readonly maxWsConnections: number;
  readonly wsPingIntervalMs: number;
  readonly gracefulShutdownTimeoutMs: number;
  readonly keepAliveIntervalMs: number;
  readonly jsonBodyLimit: string;
  /** Legacy Wplace client only (to be removed with the legacy engine). */
  readonly wplaceBase: string;
  /** Invalid values that were replaced by defaults. */
  readonly warnings: readonly string[];
}

type Env = Readonly<Record<string, string | undefined>>;

function present(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function integer(
  env: Env,
  name: string,
  fallback: number,
  warnings: string[],
  bounds: { min: number; max: number } = { min: 1, max: Number.MAX_SAFE_INTEGER }
): number {
  const raw = present(env[name]);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    warnings.push(`Invalid ${name}="${raw}": expected an integer between ${bounds.min} and ${bounds.max}. Using ${fallback}.`);
    return fallback;
  }
  return value;
}

function list(env: Env, name: string, fallback: readonly string[]): readonly string[] {
  const raw = present(env[name]);
  if (raw === undefined) return fallback;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function bodyLimit(env: Env, warnings: string[]): string {
  const raw = present(env.JSON_BODY_LIMIT);
  if (raw === undefined) return DEFAULT_JSON_BODY_LIMIT;
  if (!/^\d+(b|kb|mb)?$/i.test(raw)) {
    warnings.push(`Invalid JSON_BODY_LIMIT="${raw}": expected a size such as "12mb". Using ${DEFAULT_JSON_BODY_LIMIT}.`);
    return DEFAULT_JSON_BODY_LIMIT;
  }
  return raw.toLowerCase();
}

export function resolveServerConfig(env: Env): ServerConfig {
  const warnings: string[] = [];
  const host = resolveBindHost(env.HOST);
  if (host.warning) warnings.push(host.warning);

  return {
    host,
    port: integer(env, 'PORT', DEFAULT_PORT, warnings, { min: 1, max: 65_535 }),
    allowedOrigins: list(env, 'ALLOWED_ORIGINS', DEFAULT_ALLOWED_ORIGINS),
    allowedHosts: list(env, 'ALLOWED_HOSTS', []),
    rateLimitWindowMs: integer(env, 'RATE_LIMIT_WINDOW_MS', DEFAULT_RATE_LIMIT_WINDOW_MS, warnings),
    rateLimitMax: integer(env, 'RATE_LIMIT_MAX', DEFAULT_RATE_LIMIT_MAX, warnings),
    maxWsConnections: integer(env, 'MAX_WS_CONNECTIONS', DEFAULT_MAX_WS_CONNECTIONS, warnings),
    wsPingIntervalMs: integer(env, 'WS_PING_INTERVAL_MS', DEFAULT_WS_PING_INTERVAL_MS, warnings),
    gracefulShutdownTimeoutMs: integer(env, 'GRACEFUL_SHUTDOWN_TIMEOUT_MS', DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS, warnings),
    keepAliveIntervalMs: integer(env, 'KEEP_ALIVE_INTERVAL_MS', DEFAULT_KEEP_ALIVE_INTERVAL_MS, warnings),
    jsonBodyLimit: bodyLimit(env, warnings),
    wplaceBase: present(env.WPLACE_BASE) ?? DEFAULT_WPLACE_BASE,
    warnings,
  };
}
