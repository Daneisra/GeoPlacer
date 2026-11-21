import type { DrawingStrategyId } from '@geoplacer/core';
import { CONNECTOR_MAX_GROUP_PIXELS } from './batch-limits.js';
import { validEnergyPolicy, type EnergyPolicy, type GroupPolicy, type Threshold } from './drawing-energy.js';
import { UPGRADE_KINDS, type AutomaticUpgradePolicy } from './upgrade-policy.js';

export type ThresholdFormat = keyof Threshold | 'both';
export type DrawingOptions = {
  energyMode: EnergyPolicy['mode'];
  thresholds: Record<'start' | 'restart' | 'reserve', Threshold>;
  formats: Record<'start' | 'restart' | 'reserve', ThresholdFormat>;
  groupSize: number;
  groups: GroupPolicy;
  pixelBudget: number | null;
  upgradeMode: 'disabled' | 'limited' | 'unlimited';
  upgrades: AutomaticUpgradePolicy & { maxBudget: number };
  palette: { manualOnly: boolean; manual: string | null };
};
export type DrawingPreset = { options: DrawingOptions; strategy: DrawingStrategyId };
export type DrawingProfile = { id: string; name: string; preset: DrawingPreset };
export type DrawingPreferences = {
  recent: DrawingPreset | null;
  defaults: DrawingPreset | null;
  projects: Record<string, DrawingOptions>;
  profiles: DrawingProfile[];
};
export type DrawingPreferencesView = {
  templateId: string | null;
  current: DrawingPreset;
  next: DrawingPreset;
  explicitDefault: boolean;
  migrateLegacy: boolean;
  restorePreviousScope: boolean;
  profiles: Pick<DrawingProfile, 'id' | 'name'>[];
};
export type DrawingPreferencesEdit =
  | { action: 'save'; templateId: string | null; options: DrawingOptions }
  | { action: 'create'; templateId: string | null; name: string }
  | { action: 'rename'; id: string; name: string }
  | { action: 'delete'; id: string }
  | { action: 'load'; id: string; templateId: string | null }
  | { action: 'default' | 'reset'; templateId: string | null };

export const INITIAL_DRAWING: DrawingPreset = {
  strategy: 'top-to-bottom',
  options: {
    energyMode: 'bursts',
    thresholds: { start: { units: 0, percent: 0 }, restart: { units: 0, percent: 0 }, reserve: { units: 0, percent: 0 } },
    formats: { start: 'units', restart: 'units', reserve: 'units' },
    groupSize: 0,
    groups: { mode: 'adaptive', minimum: 0, allowFinal: false },
    pixelBudget: null,
    upgradeMode: 'disabled',
    upgrades: { maxBudget: 0, minimumReserve: 0, targetCapacity: 300, energyBelow: 5, priority: ['energy-pack'] },
    palette: { manualOnly: false, manual: null },
  },
};

export const EMPTY_DRAWING_PREFERENCES: DrawingPreferences = { recent: null, defaults: null, projects: {}, profiles: [] };

export function nextDrawing(prefs: DrawingPreferences): DrawingPreset {
  return prefs.defaults ?? prefs.recent ?? INITIAL_DRAWING;
}

const int = (v: number, max: number, min = 0) => Number.isSafeInteger(v) && v >= min && v <= max;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): boolean => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);

export function validDrawingOptions(value: unknown): value is DrawingOptions {
  if (!exact(value, ['energyMode', 'thresholds', 'formats', 'groupSize', 'groups', 'pixelBudget', 'upgradeMode', 'upgrades', 'palette'])) return false;
  const v = value as DrawingOptions;
  const u = v.upgrades;
  return (v.energyMode === 'bursts' || v.energyMode === 'continuous') &&
    exact(v.thresholds, ['start', 'restart', 'reserve']) && validEnergyPolicy({ mode: 'bursts', ...v.thresholds }) &&
    exact(v.formats, ['start', 'restart', 'reserve']) && (['start', 'restart', 'reserve'] as const).every(k => {
      const f = v.formats[k];
      return f === 'both' || (f === 'units' && v.thresholds[k].percent === 0) || (f === 'percent' && v.thresholds[k].units === 0);
    }) &&
    int(v.groupSize, CONNECTOR_MAX_GROUP_PIXELS) && exact(v.groups, ['mode', 'minimum', 'allowFinal']) &&
    ['adaptive', 'manual'].includes(v.groups.mode) && int(v.groups.minimum, CONNECTOR_MAX_GROUP_PIXELS) && typeof v.groups.allowFinal === 'boolean' &&
    (v.pixelBudget === null || int(v.pixelBudget, Number.MAX_SAFE_INTEGER)) &&
    ['disabled', 'limited', 'unlimited'].includes(v.upgradeMode) && exact(u, ['maxBudget', 'minimumReserve', 'targetCapacity', 'energyBelow', 'priority']) &&
    [u.maxBudget, u.minimumReserve, u.targetCapacity, u.energyBelow].every(n => int(n, 1e9)) &&
    Array.isArray(u.priority) && u.priority.length <= UPGRADE_KINDS.length && new Set(u.priority).size === u.priority.length &&
    u.priority.every(kind => UPGRADE_KINDS.includes(kind)) && exact(v.palette, ['manualOnly', 'manual']) && typeof v.palette.manualOnly === 'boolean' &&
    (v.palette.manual === null || (typeof v.palette.manual === 'string' && v.palette.manual.length <= 4096));
}

export function validDrawingPreferences(value: unknown, strategies: readonly DrawingStrategyId[]): value is DrawingPreferences {
  if (!exact(value, ['recent', 'defaults', 'projects', 'profiles'])) return false;
  const v = value as DrawingPreferences;
  const preset = (p: DrawingPreset) => exact(p, ['strategy', 'options']) && strategies.includes(p.strategy) && validDrawingOptions(p.options);
  return (v.recent === null || preset(v.recent)) && (v.defaults === null || preset(v.defaults)) && object(v.projects) &&
    Object.entries(v.projects).every(([id, options]) => uuid(id) && validDrawingOptions(options)) && Array.isArray(v.profiles) &&
    v.profiles.every(p => exact(p, ['id', 'name', 'preset']) && uuid(p.id) && typeof p.name === 'string' &&
      p.name.trim() === p.name && p.name.length > 0 && p.name.length <= 80 && preset(p.preset)) &&
    new Set(v.profiles.map(p => p.id)).size === v.profiles.length &&
    new Set(v.profiles.map(p => p.name.toLowerCase())).size === v.profiles.length;
}
