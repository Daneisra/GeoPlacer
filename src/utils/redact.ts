/**
 * Secret redaction for logs and API responses (pure functions, unit-tested).
 *
 * Defence in depth: callers should never log secrets, but anything that
 * reaches the logger (messages, metadata, error messages and stacks) goes
 * through these functions before being written to a file, the console or
 * the WebSocket log stream.
 */

import type { User } from '../types/index.js';

export const REDACTED = '[REDACTED]';

/** Object keys whose values are always secret (compared case-insensitively). */
const SECRET_KEYS = new Set([
  'j',
  's',
  't',
  'cookie',
  'cookies',
  'set-cookie',
  'token',
  'tokens',
  'tokenuser',
  'pawtect',
  'fp',
  'authorization',
  'password',
  'secret',
  'credential',
  'credentials',
]);

const STRING_PATTERNS: Array<[RegExp, string]> = [
  // JSON-like "key": "value" pairs for secret keys
  [
    /("(?:j|s|t|cookie|cookies|token|tokenUser|pawtect|fp|authorization|password|secret|credential)"\s*:\s*")((?:[^"\\]|\\.)*)(")/gi,
    `$1${REDACTED}$3`,
  ],
  // HTTP header style: "Cookie: ...", "Authorization: Bearer ..."
  [/\b(cookie|set-cookie|authorization)(\s*[:=]\s*)[^\r\n]+/gi, `$1$2${REDACTED}`],
  // Cookie pairs such as "j=<value>;" or "s=<value>"
  [/(^|[\s;,{(])(j|s)=([^;\s,)}]+)/g, `$1$2=${REDACTED}`],
  // JSON Web Tokens (the wplace "j" cookie is a JWT)
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
];

/** Mask secrets inside free text. */
export function redactString(text: string): string {
  let out = text;
  for (const [pattern, replacement] of STRING_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Deep-copy a value, masking secret keys and redacting strings.
 * Handles cycles and Error objects (message and stack are kept, redacted).
 */
export function redactValue(value: unknown, seen: WeakMap<object, unknown> = new WeakMap()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(redactValue(item, seen));
    return copy;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  if (value instanceof Error) {
    copy.name = value.name;
    copy.message = redactString(value.message);
    if (value.stack) copy.stack = redactString(value.stack);
  }
  for (const [key, inner] of Object.entries(value)) {
    copy[key] = SECRET_KEYS.has(key.toLowerCase()) ? REDACTED : redactValue(inner, seen);
  }
  return copy;
}

/** A user as exposed by the API: never includes session cookies. */
export type PublicUser = Omit<User, 'cookies'> & { hasCookies: boolean };

export function toPublicUser(user: User): PublicUser {
  const { cookies, ...rest } = user;
  return { ...rest, hasCookies: Boolean(cookies && typeof cookies.j === 'string' && cookies.j.length > 0) };
}

export function toPublicUsers(users: Record<string, User>): Record<string, PublicUser> {
  const out: Record<string, PublicUser> = {};
  for (const [id, user] of Object.entries(users)) out[id] = toPublicUser(user);
  return out;
}
