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
  template: 2,
  canvas: 2,
  strategy: 3,
  work: 3,
  progress: 3,
  scheduler: 4,
  index: 5,
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
