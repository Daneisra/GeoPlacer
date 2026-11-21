/**
 * Settings of the local simulation (Phase 1B.9), persisted in
 * `<data>/engine.json`. Everything here is SYNTHETIC: the canvas, the
 * palette and the resource rules describe a local simulation, not a real
 * service.
 */

import path from 'node:path';
import type { AgentId, DrawingStrategyId, Palette, ResourceRules, Rgb } from '@geoplacer/core';
import { validateRules } from '@geoplacer/core';
import { nodeJournalFs, type JournalFs } from '@geoplacer/adapters-node';
import { validDrawingPreferences, type DrawingPreferences } from './geopixels/drawing-preferences.js';
import { validAccountPaletteSample, type AccountPaletteSample } from './geopixels/writer-resources.js';

export const SETTINGS_FILE = 'engine.json';
export const SIMULATION_PROJECT = 'simulation';
export const SIMULATION_RULES_ID = 'geoplacer-local-simulation';
export const SIMULATED_AGENT = 'agent-simule-1' as AgentId;

/** Demonstration palette (synthetic): 16 colors available, 8 unlockable. */
export const DEMO_COLORS: readonly Rgb[] = [
  0x000000, 0xffffff, 0x7f7f7f, 0xc3c3c3, 0xed1c24, 0xff7f27, 0xfff200, 0x22b14c,
  0x00a2e8, 0x3f48cc, 0xa349a4, 0xb97a57, 0xffaec9, 0xffc90e, 0xb5e61d, 0x99d9ea,
  0x880015, 0x7092be, 0xc8bfe7, 0xefe4b0, 0x1a5e1a, 0x5c3a1e, 0x2b2b6b, 0xff00ff,
] as Rgb[];
export const DEMO_INITIAL_COLORS = 16;

export const DEMO_PALETTE: Palette = { id: 'demo-simulation', colors: DEMO_COLORS.map((rgb) => ({ rgb })) };

export interface SimulatorSettings {
  /** Simulated canvas: [0, width) x [0, height), y down. */
  readonly width: number;
  readonly height: number;
  readonly costPerPixel: number;
  readonly capacity: number;
  readonly regenIntervalMs: number;
  /** Time a simulated write takes (real milliseconds). */
  readonly writeLatencyMs: number;
  /** Bumped at each explicit reset of the simulated world (new rules version). */
  readonly rulesVersion: number;
}

export interface AgentSettings {
  readonly startEnergy: number;
  readonly startCurrency: number;
}

export interface RunSettings {
  readonly maxBatchSize: number;
  readonly minBatchSize: number;
}

export interface Selection {
  readonly templateId: string;
}

export interface EngineSettings {
  readonly schemaVersion: 1;
  readonly simulator: SimulatorSettings;
  readonly agent: AgentSettings;
  readonly run: RunSettings;
  readonly selection: Selection | null;
  readonly drawingPreferences?: DrawingPreferences;
  readonly lastAccountPalette?: AccountPaletteSample;
}

export const DEFAULT_SETTINGS: EngineSettings = {
  schemaVersion: 1,
  simulator: { width: 512, height: 512, costPerPixel: 1, capacity: 300, regenIntervalMs: 200, writeLatencyMs: 40, rulesVersion: 1 },
  agent: { startEnergy: 300, startCurrency: 2000 },
  run: { maxBatchSize: 40, minBatchSize: 10 },
  selection: null,
};

/** Bounds of every setting (the API validates against the same limits). */
export const LIMITS = {
  canvasSide: { min: 16, max: 4096 },
  costPerPixel: { min: 1, max: 100 },
  capacity: { min: 1, max: 1_000_000 },
  regenIntervalMs: { min: 10, max: 86_400_000 },
  writeLatencyMs: { min: 0, max: 10_000 },
  energy: { min: 0, max: 1_000_000 },
  currency: { min: 0, max: 1_000_000_000 },
  batch: { min: 1, max: 1_000 },
} as const;

export const STRATEGIES: readonly DrawingStrategyId[] = ['top-to-bottom', 'bottom-to-top', 'left-to-right', 'right-to-left', 'color-by-color', 'outline-first', 'center-out', 'random'];

export class SettingsError extends Error {
  readonly code = 'INVALID_SETTINGS';
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function int(o: Record<string, unknown>, key: string, limits: { readonly min: number; readonly max: number }): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < limits.min || v > limits.max) throw new SettingsError(`${key} must be an integer in [${limits.min}, ${limits.max}]`);
  return v;
}

/** Validates settings read from disk or built from a request (throws SettingsError). */
export function validateSettings(value: unknown): EngineSettings {
  if (!isObject(value) || value.schemaVersion !== 1) throw new SettingsError('unknown settings format');
  const s = value.simulator;
  const a = value.agent;
  const r = value.run;
  if (!isObject(s) || !isObject(a) || !isObject(r)) throw new SettingsError('simulator, agent and run settings are required');
  const simulator: SimulatorSettings = {
    width: int(s, 'width', LIMITS.canvasSide),
    height: int(s, 'height', LIMITS.canvasSide),
    costPerPixel: int(s, 'costPerPixel', LIMITS.costPerPixel),
    capacity: int(s, 'capacity', LIMITS.capacity),
    regenIntervalMs: int(s, 'regenIntervalMs', LIMITS.regenIntervalMs),
    writeLatencyMs: int(s, 'writeLatencyMs', LIMITS.writeLatencyMs),
    rulesVersion: int(s, 'rulesVersion', { min: 1, max: Number.MAX_SAFE_INTEGER }),
  };
  const agent: AgentSettings = { startEnergy: int(a, 'startEnergy', LIMITS.energy), startCurrency: int(a, 'startCurrency', LIMITS.currency) };
  const run: RunSettings = { maxBatchSize: int(r, 'maxBatchSize', LIMITS.batch), minBatchSize: int(r, 'minBatchSize', LIMITS.batch) };
  if (run.minBatchSize > run.maxBatchSize) throw new SettingsError('minBatchSize must not exceed maxBatchSize');
  let selection: Selection | null = null;
  if (value.selection !== null && value.selection !== undefined) {
    if (!isObject(value.selection) || typeof value.selection.templateId !== 'string') throw new SettingsError('invalid selection');
    selection = { templateId: value.selection.templateId };
  }
  const drawingPreferences = value.drawingPreferences;
  if (drawingPreferences !== undefined && !validDrawingPreferences(drawingPreferences, STRATEGIES)) throw new SettingsError('invalid drawing preferences');
  const lastAccountPalette = value.lastAccountPalette;
  return { schemaVersion: 1, simulator, agent, run, selection,
    ...(drawingPreferences === undefined ? {} : { drawingPreferences }),
    ...(validAccountPaletteSample(lastAccountPalette) ? { lastAccountPalette } : {}),
  };
}

/** The synthetic resource rules of the simulation (validated by the core). */
export function rulesOf(s: SimulatorSettings): ResourceRules {
  const base = s.regenIntervalMs;
  return validateRules({
    schemaVersion: 1,
    id: SIMULATION_RULES_ID,
    version: s.rulesVersion,
    energy: { costPerPixel: s.costPerPixel, baseCapacity: s.capacity, capacityLimit: s.capacity * 4, regenAmount: 1, regenIntervalMs: base, aboveCapacity: 'keep' },
    palette: {
      initialColors: DEMO_COLORS.slice(0, DEMO_INITIAL_COLORS),
      unlockable: DEMO_COLORS.slice(DEMO_INITIAL_COLORS).map((color) => ({ color, cost: 150 })),
    },
    upgrades: {
      maxEnergy: [
        { cost: 300, capacityBonus: s.capacity },
        { cost: 600, capacityBonus: s.capacity * 2 },
      ],
      regenSpeed: [
        { cost: 400, regenIntervalMs: Math.max(1, Math.round(base / 2)) },
        { cost: 800, regenIntervalMs: Math.max(1, Math.round(base / 4)) },
      ],
      energyPack: { cost: 100, energy: Math.max(1, Math.round(s.capacity / 2)), maxPurchases: 20 },
    },
    currency: { maxSpendPerOperation: 1000 },
  });
}

/** Changing these needs a reset of the simulated world (they are part of its identity). */
export function worldIdentityChanged(a: SimulatorSettings, b: SimulatorSettings): boolean {
  return a.width !== b.width || a.height !== b.height || a.costPerPixel !== b.costPerPixel || a.capacity !== b.capacity || a.regenIntervalMs !== b.regenIntervalMs;
}

export async function loadSettings(root: string, fs: JournalFs = nodeJournalFs): Promise<EngineSettings> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(path.join(root, SETTINGS_FILE));
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return DEFAULT_SETTINGS;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SettingsError(`${SETTINGS_FILE} is not valid JSON`);
  }
  return validateSettings(parsed);
}

/** Written to a new file, fsynced, then renamed over the old one. */
export async function saveSettings(root: string, settings: EngineSettings, fs: JournalFs = nodeJournalFs): Promise<void> {
  const tmp = path.join(root, `${SETTINGS_FILE}.tmp`);
  await fs.remove(tmp);
  await fs.writeNew(tmp, new TextEncoder().encode(`${JSON.stringify(settings, null, 2)}\n`));
  await fs.rename(tmp, path.join(root, SETTINGS_FILE));
  await fs.syncDir(root);
}
