/**
 * Opens the new engine for the server (Phase 1B.9): local simulation only,
 * on its own data directory (default `data/engine`, or GEOPLACER_ENGINE_DIR).
 *
 * A directory already used by another GeoPlacer instance is refused at
 * startup (EngineLockedError), before the server listens: nothing is
 * written, nothing is corrupted.
 */

import path from 'node:path';
import { EngineService } from '@geoplacer/engine-service';
import type { EngineApi } from '../api/v1/engine-api.js';

export class EngineLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineLockedError';
  }
}

export interface OpenedEngine {
  readonly api: EngineApi;
  readonly dataDir: string;
  close(graceMs: number): Promise<void>;
}

export function engineDataDir(env: NodeJS.ProcessEnv, dataDir: string): string {
  const configured = env.GEOPLACER_ENGINE_DIR?.trim();
  return path.resolve(configured !== undefined && configured !== '' ? configured : path.join(dataDir, 'engine'));
}

export async function openEngine(dataDir: string, log: (level: 'info' | 'warn' | 'error', message: string) => void): Promise<OpenedEngine> {
  let service: EngineService;
  try {
    service = await EngineService.open({ dataDir, log });
  } catch (error) {
    if ((error as { code?: unknown }).code === 'DATA_DIRECTORY_LOCKED') {
      throw new EngineLockedError(`${(error as Error).message}. Stop the other instance, or give this one another directory (GEOPLACER_ENGINE_DIR).`);
    }
    throw error;
  }
  // Compile-time check: the service offers everything the routes and the socket need.
  const api: EngineApi = service;
  return { api, dataDir, close: (graceMs) => service.close(graceMs) };
}
