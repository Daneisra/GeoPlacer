/**
 * Client of the new engine API (/api/v1, Phase 1B.9). V1: a LOCAL
 * SIMULATION only. The browser never computes a resource or progress rule:
 * it displays what the server computed.
 */

import axios, { AxiosError } from 'axios';
import { translateError } from './i18n';

export const engineHttp = axios.create({ baseURL: '/api/v1', headers: { 'Content-Type': 'application/json' } });

export type SchedulerState = 'stopped' | 'initializing' | 'running' | 'paused' | 'waiting-resources' | 'waiting-observation' | 'waiting-reconciliation' | 'completed' | 'error';

export interface TemplateInfo {
  templateId: string;
  name: string;
  revision: number;
  width: number;
  height: number;
  paintablePixels: number;
  strategy: string;
  placement: { x: number; y: number } | null;
  updatedAt: number;
}

export interface SchedulerStatus {
  at: number;
  state: SchedulerState;
  reason: string | null;
  revision: number | null;
  cycles: number;
  workPixels: number | null;
  correct: number | null;
  incorrect: number | null;
  unknown: number | null;
  progressPercent: number | null;
  openAttempts: number;
  uncertainAttempts: string[];
  energy: number | null;
  nextAvailabilityAt: number | null;
  eta: { durationMs: number | null; finishAt: number | null; unavailable: { code: string; message: string }[] } | null;
  applied: number;
  attemptsClosed: number;
  recentErrors: { at: number; code: string; message: string }[];
}

export interface EngineSettings {
  schemaVersion: 1;
  simulator: { width: number; height: number; costPerPixel: number; capacity: number; regenIntervalMs: number; writeLatencyMs: number; rulesVersion: number };
  agent: { startEnergy: number; startCurrency: number };
  run: { maxBatchSize: number; minBatchSize: number };
  selection: { templateId: string } | null;
}

export interface EngineStatus {
  mode: 'simulation' | 'geopixels';
  state: SchedulerState;
  reason: string | null;
  stream: string;
  seq: number;
  selection: TemplateInfo | null;
  commands: { start: boolean; pause: boolean; resume: boolean; stop: boolean };
  scheduler: SchedulerStatus | null;
  world: { available: boolean; error: { code: string; message: string } | null; width: number; height: number; generation: number | null; changesSinceCheckpoint: number | null };
  journal: { openAttempts: number; toReconcileAtStart: number; damaged: boolean; compacting: boolean };
  instance: { lock: string; guard: string; guardDetail: string | null };
  settings: EngineSettings;
  lastActivityAt: number | null;
}

export interface UpgradeProposal {
  id: string;
  kind: 'max-energy' | 'regen-speed' | 'energy-pack' | 'color-unlock';
  color: number | null;
  cost: number | null;
  possible: boolean;
  impossible: { code: string; message: string }[];
  benefit: string;
  savedMs: number | null;
  recommended: boolean;
  rank: number;
  effects: { capacity: { before: number; after: number }; regenIntervalMs: { before: number; after: number }; energy: { before: number; after: number }; currency: { before: number; after: number } } | null;
}

export interface ResourcesView {
  agent: string;
  simulated: true;
  observedAt: number;
  energy: number;
  capacity: number;
  regenIntervalMs: number;
  costPerPixel: number;
  currency: number;
  upgrades: { maxEnergy: number; regenSpeed: number; energyPacks: number };
  unlockedColors: number[];
  lockedColors: { color: number; cost: number }[];
  nextEnergyAt: number | null;
  proposals: UpgradeProposal[];
  proposalsUnavailable: string | null;
}

export interface CanvasRegion {
  stream: string;
  seq: number;
  rect: { minX: number; minY: number; width: number; height: number };
  /** One canvas pixel out of `scale` in each direction; output width x height. */
  scale: number;
  width: number;
  height: number;
  yAxis: 'down' | 'up';
  observedAt: number;
  data: string;
}

export interface AttemptSummary {
  attemptId: string;
  state: string;
  pixels: number;
  applied: number;
  at: number;
}

/** A readable (French) message for a failed call, with the server's stable code. */
export function errorText(error: unknown): { code: string; message: string } {
  const e = error as AxiosError<{ error?: { code?: string; message?: string } | string; code?: string }>;
  const data = e.response?.data;
  const body = typeof data?.error === 'object' ? data.error : undefined;
  if (body?.code !== undefined) return { code: body.code, message: translateError(body.code, body.message ?? body.code) };
  // Inherited routes answer { error: string, code }.
  if (typeof data?.code === 'string') return { code: data.code, message: translateError(data.code, typeof data.error === 'string' ? data.error : data.code) };
  if (e.response === undefined) return { code: 'NETWORK', message: translateError('NETWORK', '') };
  const code = `HTTP_${e.response.status}`;
  return { code, message: translateError(code, e.message) };
}

export function errorCode(error: unknown): string {
  return errorText(error).code;
}

/** Base64 of little-endian int32 values (0xRRGGBB, -1 empty, -2 unknown). */
export function decodeInt32(data: string): Int32Array {
  const bin = atob(data);
  const out = new Int32Array(bin.length / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = bin.charCodeAt(i * 4) | (bin.charCodeAt(i * 4 + 1) << 8) | (bin.charCodeAt(i * 4 + 2) << 16) | (bin.charCodeAt(i * 4 + 3) << 24);
  }
  return out;
}

export function rgbHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

export function formatTime(at: number | null | undefined): string {
  if (at === null || at === undefined) return '—';
  // French format whatever the browser language (Phase 1B.10: seen as « 12:56:19 AM » in an English Firefox).
  return new Date(at).toLocaleTimeString('fr-FR');
}

export const STATE_LABELS: Record<SchedulerState, string> = {
  stopped: 'Arrêté',
  initializing: 'Initialisation',
  running: 'En cours',
  paused: 'En pause',
  'waiting-resources': 'Attente ressources',
  'waiting-observation': 'En attente d’observations',
  'waiting-reconciliation': 'Attente réconciliation',
  completed: 'Terminé',
  error: 'Erreur',
};

export const STRATEGY_LABELS: Record<string, string> = {
  'top-to-bottom': 'Haut vers bas',
  'bottom-to-top': 'Bas vers haut',
  'left-to-right': 'Gauche vers droite',
  'right-to-left': 'Droite vers gauche',
  'color-by-color': 'Couleur par couleur',
  'outline-first': 'Contours d’abord',
  'center-out': 'Du centre vers l’extérieur',
  random: 'Aléatoire',
};

export const UPGRADE_LABELS: Record<UpgradeProposal['kind'], string> = {
  'max-energy': 'Capacité d’énergie',
  'regen-speed': 'Vitesse de régénération',
  'energy-pack': 'Recharge d’énergie',
  'color-unlock': 'Débloquer la couleur',
};
