/**
 * Architecture rules of @geoplacer/core, checked on the sources:
 * - no external package and no Node/DOM module (environment-agnostic core);
 * - contracts follow their layering, hence no import cycle;
 * - contracts contain no algorithm (no function or class bodies).
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const contractsDir = path.join(srcDir, 'contracts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(path.join(dir, entry.name)) : entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : []
  );
}

function importSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? '');
}

const LAYERS: Readonly<Record<string, number>> = {
  primitives: 0,
  config: 0,
  geometry: 1,
  palette: 1,
  resources: 1,
  accounts: 1,
  ports: 1,
  template: 2,
  canvas: 2,
  strategy: 3,
  work: 4,
  progress: 3,
  scheduler: 5,
  upgrades: 4,
  index: 6,
};

describe('@geoplacer/core architecture', () => {
  it('imports only relative modules (no external package, no node: or DOM module)', () => {
    for (const file of sourceFiles(srcDir)) {
      for (const spec of importSpecifiers(file)) {
        expect({ file: path.relative(srcDir, file), spec, relative: spec.startsWith('./') || spec.startsWith('../') }).toMatchObject({
          relative: true,
        });
      }
    }
  });

  it('contracts only import lower layers (hence no cycle)', () => {
    for (const file of sourceFiles(contractsDir)) {
      const name = path.basename(file, '.ts');
      const layer = LAYERS[name];
      expect({ name, known: layer !== undefined }).toEqual({ name, known: true });
      for (const spec of importSpecifiers(file)) {
        const target = path.basename(spec, '.js');
        const targetLayer = LAYERS[target];
        expect({ from: name, to: target, ok: targetLayer !== undefined && layer !== undefined && targetLayer < layer }).toEqual({
          from: name,
          to: target,
          ok: true,
        });
      }
    }
  });

  it('implementation modules only depend on the modules they are allowed to', () => {
    // Folder -> folders it may import. Contracts stay at the bottom.
    const allowed: Readonly<Record<string, readonly string[]>> = {
      contracts: ['contracts'],
      geometry: ['contracts', 'geometry'],
      color: ['contracts', 'color'],
      palette: ['contracts', 'color', 'palette'],
      template: ['contracts', 'color', 'palette', 'geometry', 'template'],
      // Strategies: pure orders over a TemplateImage; no template manager, no I/O.
      strategy: ['contracts', 'geometry', 'strategy'],
      // Pure in-memory canvas snapshots (simulated or imported data, decoded elsewhere).
      canvas: ['contracts', 'geometry', 'canvas'],
      // Progress and ETA: template image, geometry and eligible region only; no scheduler, no I/O.
      progress: ['contracts', 'geometry', 'strategy', 'resources', 'progress'],
      // Resource rules and agent states: pure, contracts only.
      resources: ['contracts', 'resources'],
      // Upgrade planning: simulations over resources and the ETA; no purchase, no I/O.
      upgrades: ['contracts', 'resources', 'progress', 'upgrades'],
      // Work planning, attempts and recovery: pure, over the other domains; I/O through ports.
      work: ['contracts', 'geometry', 'strategy', 'progress', 'resources', 'work'],
    };
    for (const file of sourceFiles(srcDir)) {
      const folder = path.relative(srcDir, file).split(path.sep)[0] ?? '';
      if (folder.endsWith('.ts')) continue; // src/index.ts re-exports everything
      const rules = allowed[folder];
      expect({ folder, known: rules !== undefined }).toEqual({ folder, known: true });
      for (const spec of importSpecifiers(file)) {
        const target = path.relative(srcDir, path.resolve(path.dirname(file), spec)).split(path.sep)[0] ?? '';
        expect({ from: path.relative(srcDir, file), to: target, ok: rules?.includes(target) ?? false }).toMatchObject({ ok: true });
      }
    }
  });

  it('has no import cycle anywhere in src', () => {
    const graph = new Map<string, string[]>();
    for (const file of sourceFiles(srcDir)) {
      graph.set(
        file,
        importSpecifiers(file).map((spec) => path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts'))
      );
    }
    const state = new Map<string, 'visiting' | 'done'>();
    const cycles: string[] = [];
    const visit = (node: string, trail: string[]): void => {
      if (state.get(node) === 'done') return;
      if (state.get(node) === 'visiting') {
        cycles.push([...trail, node].map((f) => path.relative(srcDir, f)).join(' -> '));
        return;
      }
      state.set(node, 'visiting');
      for (const next of graph.get(node) ?? []) visit(next, [...trail, node]);
      state.set(node, 'done');
    };
    for (const node of graph.keys()) visit(node, []);
    expect(cycles).toEqual([]);
  });

  it('contracts contain no algorithm', () => {
    for (const file of sourceFiles(contractsDir)) {
      const text = readFileSync(file, 'utf8');
      expect({ file: path.basename(file), hasFunction: /\bfunction\b|=>\s*\{|\bclass\s+\w+/.test(text) }).toEqual({
        file: path.basename(file),
        hasFunction: false,
      });
    }
  });
});
