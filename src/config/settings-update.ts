/**
 * Settings validation and in-place update (pure logic, unit-tested).
 *
 * The settings object is shared by reference between the settings route,
 * the server's persistence function and the template-manager context, so an
 * update must mutate it in place: replacing it (as the previous route did)
 * left the server persisting and the engine reading a stale object.
 */

import type { Settings } from '../types/index.js';
import { settingsSchema } from '../middleware/validation.js';

export interface SettingsIssue {
  path: string;
  message: string;
}

export type SettingsUpdateResult =
  | { ok: true; changed: (keyof Settings)[] }
  | { ok: false; issues: SettingsIssue[] };

/**
 * Validate a partial update and apply it to `current` in place.
 * Unknown fields are ignored (the UI sends a few extra fields); invalid
 * values reject the whole update and leave `current` untouched.
 */
export function applySettingsUpdate(current: Settings, body: unknown): SettingsUpdateResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, issues: [{ path: '', message: 'Expected a JSON object' }] };
  }

  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    };
  }

  const changed: (keyof Settings)[] = [];
  for (const [key, value] of Object.entries(parsed.data) as [keyof Settings, unknown][]) {
    if (value === undefined) continue;
    if (current[key] !== value) changed.push(key);
    (current as unknown as Record<string, unknown>)[key] = value;
  }
  return { ok: true, changed };
}

/**
 * Sanitise settings read from disk: every field that fails validation is
 * replaced by its default value instead of being trusted.
 */
export function sanitizeLoadedSettings(
  loaded: unknown,
  defaults: Settings
): { settings: Settings; rejected: string[] } {
  const settings: Settings = { ...defaults };
  const rejected: string[] = [];
  if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) {
    return { settings, rejected: ['<root>'] };
  }

  for (const [key, value] of Object.entries(loaded)) {
    if (!(key in defaults)) continue; // unknown or legacy field
    const single = settingsSchema.safeParse({ [key]: value });
    const accepted = single.success ? (single.data as Record<string, unknown>)[key] : undefined;
    if (accepted === undefined) {
      rejected.push(key);
      continue;
    }
    (settings as unknown as Record<string, unknown>)[key] = accepted;
  }
  return { settings, rejected };
}
