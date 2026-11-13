/**
 * Winston format that masks secrets in every log entry before any transport
 * writes it (files, console, WebSocket stream).
 *
 * It mutates the info object in place: winston relies on its Symbol keys,
 * which a deep copy would drop.
 */

import winston from 'winston';
import { redactString, redactValue, REDACTED } from './redact.js';

const SECRET_INFO_KEYS = new Set([
  'cookie',
  'cookies',
  'token',
  'tokens',
  'tokenuser',
  'pawtect',
  'fp',
  'authorization',
  'password',
  'secret',
]);

export const redactSecretsFormat = winston.format((info) => {
  const record = info as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === 'level' || key === 'timestamp') continue;
    const value = record[key];
    if (SECRET_INFO_KEYS.has(key.toLowerCase())) {
      record[key] = REDACTED;
    } else if (typeof value === 'string') {
      record[key] = redactString(value);
    } else if (value !== null && typeof value === 'object') {
      record[key] = redactValue(value);
    }
  }
  return info;
});
