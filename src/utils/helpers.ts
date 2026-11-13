/**
 * General utility functions
 */

import { exec } from 'node:child_process';
import { logger } from './logger.js';
import { readJsonWithRecovery, writeJsonAtomic, type JsonLoadResult } from './json-store.js';

// Re-export MS time constants from central constants module
export { MS } from '../config/constants.js';

/**
 * Cross-platform open-in-browser
 */
export function openBrowser(url: string): void {
  const start =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  exec(`${start} ${url}`);
}

/**
 * Human-readable duration formatter
 */
export function duration(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 1000) return `${ms}ms`;

  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600);

  return [h ? `${h}h` : '', m ? `${m}m` : '', `${s % 60}s`]
    .filter(Boolean)
    .join(' ');
}

/**
 * Sleep/promise delay
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Log what readJsonWithRecovery() had to do, if anything. */
export function reportJsonLoad(filename: string, result: JsonLoadResult<unknown>): void {
  if (result.removedTempFiles.length > 0) {
    logger.warn(`Removed ${result.removedTempFiles.length} temp file(s) left by an interrupted write of ${filename}.`);
  }
  if (result.status === 'recovered-from-backup') {
    logger.warn(
      `${filename} was unreadable (${result.error ?? 'missing'}); restored the last valid backup.` +
        (result.quarantinedTo ? ` Damaged file kept as ${result.quarantinedTo}.` : '')
    );
  } else if (result.status === 'corrupt-no-backup') {
    logger.error(
      `${filename} was unreadable (${result.error}) and no backup exists; starting empty. Damaged file kept as ${result.quarantinedTo}.`
    );
  }
}

/**
 * Load JSON with crash recovery. A corrupt file is never silently replaced:
 * it is kept aside and the last valid backup is used when available.
 */
export function loadJSON<T>(filename: string): T {
  const result = readJsonWithRecovery<T>(filename, () => ({}) as T);
  reportJsonLoad(filename, result);
  return result.data;
}

/**
 * Atomic JSON save (temp file + fsync + rename, previous version kept as .bak).
 */
export function saveJSON<T>(filename: string, data: T): void {
  try {
    writeJsonAtomic(filename, data);
  } catch (error) {
    logger.error(`Failed to save JSON to ${filename}:`, error);
    throw error;
  }
}
