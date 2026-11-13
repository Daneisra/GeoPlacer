/**
 * Default settings and settings management
 */

import type { Settings } from '../types/index.js';
import { DEFAULT_SETTINGS } from './default-settings.js';
import { SETTINGS_FILE } from './constants.js';
import { logger } from '../utils/logger.js';
import { readJsonWithRecovery, writeJsonAtomic } from '../utils/json-store.js';
import { reportJsonLoad } from '../utils/helpers.js';
import { sanitizeLoadedSettings } from './settings-update.js';

export { DEFAULT_SETTINGS };

/**
 * Load settings from disk (with crash recovery) or return defaults.
 */
export function loadSettings(): Settings {
  const result = readJsonWithRecovery<unknown>(SETTINGS_FILE, () => null);
  reportJsonLoad(SETTINGS_FILE, result);
  if (result.data === null) {
    return { ...DEFAULT_SETTINGS };
  }

  // Every field is validated: invalid values (old files, manual edits, the
  // former unvalidated PUT /settings) fall back to their defaults.
  const { settings, rejected } = sanitizeLoadedSettings(result.data, DEFAULT_SETTINGS);
  if (rejected.length > 0) {
    logger.warn(`[SYSTEM] Invalid settings replaced by defaults: ${rejected.join(', ')}`);
  }
  return settings;
}

/**
 * Save settings to disk atomically.
 */
export function saveSettings(settings: Settings): void {
  try {
    writeJsonAtomic(SETTINGS_FILE, settings);
  } catch (error) {
    logger.error('Failed to save settings:', error);
    throw error;
  }
}
