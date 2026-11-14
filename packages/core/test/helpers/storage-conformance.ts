/**
 * Shared conformance suite for TemplateStorage implementations, run against
 * the in-memory storage (core) and the filesystem storage (adapters-node),
 * so the test double cannot drift from the real adapter.
 *
 * Part 2 injects a failure at every storage call of real manager operations
 * (the call is skipped, or performed and then reported as failed), reopens
 * the storage with a fresh manager and checks that the template is exactly
 * the old or the new revision, fully verified.
 */

import { describe, expect, it } from 'vitest';
import type { Hasher, Palette, PngCodec, ProjectId, TemplateId, TemplateManager, TemplateRef, TemplateStorage } from '../../src/index.js';
import { StorageConflictError, asProjectId, createTemplateManager, rgb } from '../../src/index.js';
import { rgbaPng } from './png.js';
import { manualClock, sequentialIds } from './ports.js';

export interface ConformanceTarget {
  readonly name: string;
  /** A fresh, empty storage. */
  readonly make: () => Promise<TemplateStorage>;
  readonly codec: PngCodec;
  readonly hasher: Hasher;
}

const P1 = asProjectId('projet-a');
const P2 = asProjectId('projet-b');
const T1 = 'modele-1' as TemplateId;
const A1 = 'a'.repeat(64);
const palette: Palette = { id: 'base', colors: [{ rgb: rgb(0, 0, 0) }, { rgb: rgb(255, 255, 255) }, { rgb: rgb(255, 0, 0) }] };
const sourcePng = rgbaPng(3, 2, (x, y) => (x === 1 && y === 0 ? [0, 0, 0, 0] : [x * 100, y * 100, 50, 255]));
const at = (x: number, y: number) => ({ topLeft: { x, y } });
const manifestJson = (generation: number): string => `{"generation":${generation}}`;

export function storageConformance(target: ConformanceTarget): void {
  describe(`TemplateStorage conformance: ${target.name}`, () => {
    it('reads nothing from an empty storage', async () => {
      const s = await target.make();
      expect(await s.readManifest(P1, T1)).toEqual({ current: null, backup: null });
      expect(await s.listTemplates(P1)).toEqual([]);
      expect(await s.readBlob(P1, A1)).toBeNull();
    });

    it('publishes manifests by compare-and-swap and keeps the previous one as backup', async () => {
      const s = await target.make();
      await s.writeManifest(P1, T1, manifestJson(1), null);
      await expect(s.writeManifest(P1, T1, manifestJson(1), null)).rejects.toBeInstanceOf(StorageConflictError);
      await expect(s.writeManifest(P1, T1, manifestJson(3), 2)).rejects.toBeInstanceOf(StorageConflictError);
      expect(await s.readManifest(P1, T1)).toEqual({ current: manifestJson(1), backup: null });
      await s.writeManifest(P1, T1, manifestJson(2), 1);
      expect(await s.readManifest(P1, T1)).toEqual({ current: manifestJson(2), backup: manifestJson(1) });
    });

    it('stores blobs by address, returns copies, isolates projects and lists sorted ids', async () => {
      const s = await target.make();
      await s.writeBlob(P1, A1, new Uint8Array([1, 2, 3]));
      const read = await s.readBlob(P1, A1);
      expect([...(read ?? [])]).toEqual([1, 2, 3]);
      read?.fill(9);
      expect([...((await s.readBlob(P1, A1)) ?? [])]).toEqual([1, 2, 3]);
      expect(await s.readBlob(P2, A1)).toBeNull();
      await s.writeBlob(P1, A1, new Uint8Array([4]));
      expect([...((await s.readBlob(P1, A1)) ?? [])]).toEqual([4]);
      await s.writeManifest(P1, 'zz' as TemplateId, manifestJson(1), null);
      await s.writeManifest(P1, 'aa' as TemplateId, manifestJson(1), null);
      await s.writeManifest(P2, 'mm' as TemplateId, manifestJson(1), null);
      expect(await s.listTemplates(P1)).toEqual(['aa', 'zz']);
      expect(await s.listTemplates(P2)).toEqual(['mm']);
    });

    describe('interrupted manager operations', () => {
      const manager = (storage: TemplateStorage, ids = sequentialIds()): TemplateManager =>
        createTemplateManager({ storage, hasher: target.hasher, codec: target.codec, ids, clock: manualClock() });

      /** Fails storage call number `k`; `after` performs it before reporting the failure. */
      function faulty(storage: TemplateStorage, k: number, after: boolean): { storage: TemplateStorage; reached: () => boolean } {
        let calls = 0;
        let reached = false;
        const wrap =
          <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
          async (...args: A): Promise<R> => {
            if (calls++ === k) {
              reached = true;
              if (after) await fn(...args);
              throw new Error(`injected failure at storage call ${k}`);
            }
            return fn(...args);
          };
        return {
          storage: {
            readManifest: wrap(storage.readManifest.bind(storage)),
            writeManifest: wrap(storage.writeManifest.bind(storage)),
            listTemplates: wrap(storage.listTemplates.bind(storage)),
            readBlob: wrap(storage.readBlob.bind(storage)),
            writeBlob: wrap(storage.writeBlob.bind(storage)),
          },
          reached: () => reached,
        };
      }

      const create = (m: TemplateManager, projectId: ProjectId = P1) =>
        m.create({ projectId, name: 'Fresque', sourcePng, palette, placement: at(10, 20), coordinateSystem: { yAxis: 'down' } });

      type Op = (m: TemplateManager, ref: TemplateRef) => Promise<unknown>;
      const ops: Array<[string, Op, boolean]> = [
        ['placement', (m, ref) => m.revise(ref, { placement: at(7, 7) }), false],
        ['re-quantize', (m, ref) => m.revise(ref, { alphaThreshold: 255 }), false],
        ['new source', (m, ref) => m.revise(ref, { sourcePng: rgbaPng(2, 1, () => [1, 2, 3, 255]) }), false],
        ['restore', (m, ref) => m.restoreRevision(ref, 1), true],
        ['settings', (m, ref) => m.updateSettings(ref, { name: 'Renommé' }), false],
      ];

      for (const [label, op, needsSecondRevision] of ops) {
        it(`leaves the old or the new state after a failure at any call: ${label}`, async () => {
          let scenarios = 0;
          for (let k = 0; ; k++) {
            let reachedAny = false;
            for (const after of [false, true]) {
              const storage = await target.make();
              const t = await create(manager(storage));
              const ref = { projectId: t.projectId, templateId: t.id };
              if (needsSecondRevision) await manager(storage).revise(ref, { placement: at(9, 9) });
              const before = await manager(storage).manifest(ref);
              const f = faulty(storage, k, after);
              const ok = await op(manager(f.storage), ref).then(
                () => true,
                () => false
              );
              reachedAny ||= f.reached();
              const reopened = manager(storage);
              const now = await reopened.manifest(ref);
              const where = `${label} k=${k} after=${String(after)}`;
              expect([before.generation, before.generation + 1], where).toContain(now.generation);
              if (ok) expect(now.generation, where).toBe(before.generation + 1);
              const loaded = await reopened.load(ref);
              expect(loaded.report.problems, where).toEqual([]);
              expect(loaded.template.revision, where).toBe(now.currentRevision);
              expect((await reopened.verify(ref)).revisions.every((r) => r.ok), where).toBe(true);
              expect(now.revisions.slice(0, before.revisions.length), where).toEqual(before.revisions);
              scenarios++;
            }
            if (!reachedAny) break; // the operation completed before call k: every call index is covered
          }
          expect(scenarios).toBeGreaterThan(4);
        });
      }

      it('leaves no template or a complete one after a failure during creation', async () => {
        for (let k = 0; ; k++) {
          let reachedAny = false;
          for (const after of [false, true]) {
            const storage = await target.make();
            const f = faulty(storage, k, after);
            const ok = await create(manager(f.storage)).then(
              () => true,
              () => false
            );
            reachedAny ||= f.reached();
            const reopened = manager(storage, sequentialIds('autre'));
            const list = await reopened.list(P1);
            if (ok) expect(list.length).toBe(1);
            expect(list.length).toBeLessThanOrEqual(1);
            for (const summary of list) {
              expect((await reopened.verify({ projectId: P1, templateId: summary.templateId })).revisions[0]?.ok).toBe(true);
            }
          }
          if (!reachedAny) break;
        }
      });
    });
  });
}
