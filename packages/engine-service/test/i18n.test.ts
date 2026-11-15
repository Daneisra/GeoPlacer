/**
 * Phase 1B.10: the French table of the dashboard covers every code and
 * state reason the engine can send. The codes are read from the SOURCES
 * (scheduler, service, routes), so that a new code without translation
 * fails here, not in front of the user.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The table lives in the frontend: loaded at run time (Vitest transpiles it), typed here. */
interface I18n {
  TRANSLATED_ERROR_CODES: readonly string[];
  TRANSLATED_ETA_CODES: readonly string[];
  TRANSLATED_UPGRADE_CODES: readonly string[];
  translateError(code: string, message: string): string;
  translateNotice(message: string): string;
  translateReason(reason: string | null): string | null;
  translateVerdict(verdict: string): string;
}
const { TRANSLATED_ERROR_CODES, TRANSLATED_ETA_CODES, TRANSLATED_UPGRADE_CODES, translateError, translateNotice, translateReason, translateVerdict } = (await import(
  pathToFileURL(path.join(repo, 'frontend', 'src', 'lib', 'i18n.ts')).href
)) as I18n;

const read = (rel: string) => readFile(path.join(repo, rel), 'utf8');
const all = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map((m) => m[1]!);

describe('French texts of the dashboard', () => {
  it('translate every error code of the scheduler, the service and the routes', async () => {
    const scheduler = await read('packages/core/src/scheduler/scheduler.ts');
    const service = await read('packages/engine-service/src/service.ts');
    const router = await read('src/api/v1/engine-router.ts');
    const world = await read('packages/engine-service/src/world-store.ts');
    const codes = new Set([
      ...all(scheduler, /(?:fail|recordError)\('([A-Z_]+)'/g),
      ...all(service, /EngineServiceError\('([A-Z_]+)'/g),
      ...all(router, /sendError\(res, \d+, '([A-Z_]+)'/g),
      ...all(world, /'(WORLD_[A-Z_]+)'/g).filter((c) => c !== 'WORLD_CLOSED'),
    ]);
    expect(codes.size).toBeGreaterThan(30);
    const missing = [...codes].filter((c) => !TRANSLATED_ERROR_CODES.includes(c));
    expect(missing).toEqual([]);
  });

  it('translate every estimate and upgrade refusal code of the core contracts', async () => {
    const progress = await read('packages/core/src/contracts/progress.ts');
    const upgrades = await read('packages/core/src/contracts/upgrades.ts');
    const eta = all(progress.slice(progress.indexOf('export type EtaUnavailableCode'), progress.indexOf('export interface EtaUnavailableReason')), /\| '([A-Z_]+)'/g);
    const up = all(upgrades.slice(upgrades.indexOf('export type UpgradeImpossibleCode'), upgrades.indexOf('export interface UpgradeOption')), /\| '([A-Z_]+)'/g);
    expect(eta.length).toBeGreaterThan(5);
    expect(eta.filter((c) => !TRANSLATED_ETA_CODES.includes(c))).toEqual([]);
    expect(up.filter((c) => !TRANSLATED_UPGRADE_CODES.includes(c))).toEqual([]);
  });

  it('translate every state reason of the scheduler (parameters included)', () => {
    const reasons = [
      'the canvas matches the template',
      'recovering the journal',
      'pause requested',
      'stop requested',
      'stopped (operation aborted)',
      'a write ended without a reliable answer',
      'the canvas could not be read',
      '3 attempt(s) still open, waiting for a covering canvas read',
      'the resources could not be observed',
      'agent unavailable until 1794765079337',
      'waiting for a newer observation (STALE_RESOURCES)',
      'waiting for the energy of 10 pixel(s)',
      'simulated world unavailable: WORLD_DAMAGED',
      'BLOCKED: work left that the agent cannot do: colors 0xff00ff',
    ];
    for (const r of reasons) {
      const fr = translateReason(r)!;
      expect(fr, r).not.toMatch(/message du moteur/);
      expect(fr, r).not.toBe(r);
    }
    expect(translateReason('waiting for the energy of 10 pixel(s)')).toBe('En attente de l’énergie de 10 pixel(s).');
  });

  it('every reason literal of the scheduler source is covered', async () => {
    const scheduler = await read('packages/core/src/scheduler/scheduler.ts');
    const literals = all(scheduler, /setState\('[a-z-]+', '([^']+)'\)/g);
    expect(literals.length).toBeGreaterThan(5);
    for (const r of literals) expect(translateReason(r), r).not.toMatch(/message du moteur/);
  });

  it('notices, verdicts and parameters', () => {
    expect(translateNotice('simulated upgrade applied: energy-pack')).toBe('Amélioration simulée appliquée : recharge d’énergie.');
    expect(translateNotice('simulated world reset')).toBe('Monde simulé réinitialisé.');
    expect(translateVerdict('healthy')).toBe('sain');
    expect(translateError('PIXELS_REJECTED', '4 pixel(s) rejected by the canvas')).toBe('4 pixel(s) refusé(s) par la toile.');
    expect(translateError('INVALID_SETTINGS', 'width must be an integer in [16, 4096]')).toBe('Largeur de la toile : un nombre entier entre 16 et 4096 est attendu.');
    expect(translateError('TEMPLATE_OUTSIDE_CANVAS', 'the template (60x40 at 10, 5) does not fit in the simulated canvas (64x64)')).toBe('Le modèle (60 × 40 à 10, 5) ne tient pas dans la toile simulée (64 × 64).');
  });

  it('an unknown code or text is shown as received, marked, never hidden', () => {
    expect(translateError('SOMETHING_NEW', 'details')).toBe('details [SOMETHING_NEW] (message du moteur)');
    expect(translateReason('a brand new reason')).toBe('a brand new reason (message du moteur)');
    expect(translateNotice('new notice')).toBe('new notice (message du moteur)');
  });
});
