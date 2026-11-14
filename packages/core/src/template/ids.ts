/**
 * Project and template identifiers. They become directory names in file
 * adapters, so they are restricted to a lower-case, bounded charset: no case
 * collisions on case-insensitive file systems (NTFS), no path separators,
 * no dots.
 */

import type { ProjectId, TemplateId } from '../contracts/index.js';
import { TemplateError } from './errors.js';

/** 1-64 characters: lower-case letters, digits, hyphens; starts with a letter or digit. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}

function assertId(value: unknown, kind: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new TemplateError('INVALID_ID', `${kind} must match ${ID_PATTERN.source}, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function asProjectId(value: unknown): ProjectId {
  return assertId(value, 'projectId') as ProjectId;
}

export function asTemplateId(value: unknown): TemplateId {
  return assertId(value, 'templateId') as TemplateId;
}

export const MAX_NAME_LENGTH = 200;

/** Trimmed, 1-200 characters, no control characters. */
export function normalizeName(name: unknown): string {
  if (typeof name !== 'string') throw new TemplateError('INVALID_NAME', 'name must be a string');
  const trimmed = name.trim();
  // eslint-disable-next-line no-control-regex
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new TemplateError('INVALID_NAME', `name must have 1 to ${MAX_NAME_LENGTH} characters without control characters`);
  }
  return trimmed;
}
