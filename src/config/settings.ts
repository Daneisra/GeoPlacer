/**
 * Default settings and settings management
 */

import type { Settings } from '../types/index.js';
import { DEFAULT_SETTINGS } from './default-settings.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DATA_DIR, SETTINGS_FILE } from './constants.js';
import { logger } from '../utils/logger.js';
import { sanitizeLoadedSettings } from './settings-update.js';

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  // This will be handled by the main server bootstrap
}

export { DEFAULT_SETTINGS };

/**
 * Load settings from disk or return defaults
 */
export function loadSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) {
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const data = readFileSync(SETTINGS_FILE, 'utf8');
    // Every field is validated: invalid values (old files, manual edits, the
    // former unvalidated PUT /settings) fall back to their defaults.
    const { settings, rejected } = sanitizeLoadedSettings(JSON.parse(data), DEFAULT_SETTINGS);
    if (rejected.length > 0) {
      logger.warn(`[SYSTEM] Invalid settings replaced by defaults: ${rejected.join(', ')}`);
    }

    return settings;
  } catch (error) {
    logger.error('Failed to load settings, using defaults:', error);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Save settings to disk
 */
export function saveSettings(settings: Settings): void {
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (error) {
    logger.error('Failed to save settings:', error);
    throw error;
  }
}
