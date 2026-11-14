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

    it('replaces a manifest by compare-and-swap on its raw text, preserving it and keeping the backup', async () => {
      const s = await target.make();
      await s.writeManifest(P1, T1, manifestJson(1), null);
      await s.writeManifest(P1, T1, '{"generation":2,"broken', 1);
      await expect(s.replaceManifest(P1, T1, manifestJson(4), manifestJson(1))).rejects.toBeInstanceOf(StorageConflictError);
      await expect(s.replaceManifest(P1, T1, manifestJson(4), null)).rejects.toBeInstanceOf(StorageConflictError);
      const preserved = await s.replaceManifest(P1, T1, manifestJson(4), '{"generation":2,"broken');
      expect(preserved).toMatch(/corrupt/);
      expect(await s.readManifest(P1, T1)).toEqual({ current: manifestJson(4), backup: manifestJson(1) });
      expect(await s.listTemplates(P1)).toEqual([T1]);
      // Absent current manifest: nothing to preserve.
      const T2 = 'modele-2' as TemplateId;
      await expect(s.replaceManifest(P1, T2, manifestJson(1), 'x')).rejects.toBeInstanceOf(StorageConflictError);
      expect(await s.replaceManifest(P1, T2, manifestJson(1), null)).toBeNull();
      expect((await s.readManifest(P1, T2)).current).toBe(manifestJson(1));
    });

    it('reserves each number once, exclusively, and reports the highest ones', async () => {
      const s = await target.make();
      expect(await s.reservations(P1, T1)).toEqual({ generation: null, revision: null });
      await s.reserve(P1, T1, 'generation', 1);
      await s.reserve(P1, T1, 'generation', 7);
      await s.reserve(P1, T1, 'revision', 3);
      await expect(s.reserve(P1, T1, 'generation', 7)).rejects.toBeInstanceOf(StorageConflictError);
      await expect(s.reserve(P1, T1, 'revision', 3)).rejects.toBeInstanceOf(StorageConflictError);
      expect(await s.reservations(P1, T1)).toEqual({ generation: 7, revision: 3 });
      // Per template and per project.
      expect(await s.reservations(P2, T1)).toEqual({ generation: null, revision: null });
      await s.reserve(P2, T1, 'generation', 7);
      await expect(s.reserve(P1, T1, 'generation', 0)).rejects.toThrow();
      // A reservation alone does not make a template appear.
      expect(await s.listTemplates(P1)).toEqual([]);
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
            replaceManifest: wrap(storage.replaceManifest.bind(storage)),
            reserve: wrap(storage.reserve.bind(storage)),
            reservations: wrap(storage.reservations.bind(storage)),
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
        ['delete', (m, ref) => m.delete(ref, { confirmName: 'Fresque' }), false],
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
              if (now.deletedAt === null) {
                const loaded = await reopened.load(ref);
                expect(loaded.report.problems, where).toEqual([]);
                expect(loaded.template.revision, where).toBe(now.currentRevision);
              }
              expect((await reopened.verify(ref)).revisions.every((r) => r.ok), where).toBe(true);
              expect(now.revisions.slice(0, before.revisions.length), where).toEqual(before.revisions);
              // Every published number was reserved first.
              const reserved = await storage.reservations(P1, t.id);
              expect(reserved.generation ?? 0, where).toBeGreaterThanOrEqual(now.generation);
              expect(reserved.revision ?? 0, where).toBeGreaterThanOrEqual(now.revisions[now.revisions.length - 1]!.revision);
              scenarios++;
            }
            if (!reachedAny) break; // the operation completed before call k: every call index is covered
          }
          expect(scenarios).toBeGreaterThan(4);
        });
      }

      it('leaves the corrupt state (backup intact) or the repaired one after a failure during repair', async () => {
        for (let k = 0; ; k++) {
          let reachedAny = false;
          for (const after of [false, true]) {
            const storage = await target.make();
            const t = await create(manager(storage));
            const ref = { projectId: t.projectId, templateId: t.id };
            await manager(storage).revise(ref, { placement: at(9, 9) });
            const good = (await storage.readManifest(P1, t.id)).current;
            await storage.writeManifest(P1, t.id, '{"generation":3,"broken', 2); // good one becomes the backup
            const f = faulty(storage, k, after);
            const ok = await manager(f.storage).repair(ref, { apply: true }).then(
              () => true,
              () => false
            );
            reachedAny ||= f.reached();
            const where = `repair k=${k} after=${String(after)}`;
            const read = await storage.readManifest(P1, t.id);
            expect(read.backup, where).toBe(good);
            const reopened = manager(storage);
            if (read.current === '{"generation":3,"broken') {
              expect(ok, where).toBe(false);
              expect((await reopened.load(ref, { recover: true })).template.revision, where).toBe(2);
            } else {
              const loaded = await reopened.load(ref);
              expect(loaded.report.problems, where).toEqual([]);
              expect(loaded.template.revision, where).toBe(2);
              expect((await reopened.manifest(ref)).generation, where).toBe(4);
            }
          }
          if (!reachedAny) break;
        }
      });

      it('leaves no copy or a complete one after a failure during duplication', async () => {
        for (let k = 0; ; k++) {
          let reachedAny = false;
          for (const after of [false, true]) {
            const storage = await target.make();
            const t = await create(manager(storage));
            const ids = sequentialIds('copie');
            const f = faulty(storage, k, after);
            const ok = await manager(f.storage, ids)
              .duplicate({ projectId: P1, templateId: t.id }, { name: 'Copie', projectId: P2 })
              .then(
                () => true,
                () => false
              );
            reachedAny ||= f.reached();
            const { templates, failures } = await manager(storage).list(P2);
            expect(failures).toEqual([]);
            if (ok) expect(templates.length).toBe(1);
            expect(templates.length).toBeLessThanOrEqual(1);
            for (const summary of templates) expect((await manager(storage).verify({ projectId: P2, templateId: summary.templateId })).revisions[0]?.ok).toBe(true);
          }
          if (!reachedAny) break;
        }
      });

      it('never gives a revision number to two contents across repeated corruption and repair', async () => {
        const storage = await target.make();
        const m = manager(storage);
        const t = await create(m);
        const ref = { projectId: t.projectId, templateId: t.id };
        const contentOf = new Map<number, string>();
        const record = async (): Promise<void> => {
          const manifest = await manager(storage).manifest(ref);
          for (const r of manifest.revisions) {
            const key = JSON.stringify([r.quantizedImageHash, r.placement]);
            const seen = contentOf.get(r.revision);
            if (seen !== undefined) expect(seen, `revision ${r.revision}`).toBe(key);
            contentOf.set(r.revision, key);
          }
        };
        const generations: number[] = [];
        for (let round = 0; round < 6; round++) {
          await manager(storage).revise(ref, { placement: at(round, 2 * round + 1) });
          await record();
          // Lose the current manifest (the latest revision lives only there): corrupt it, repair.
          const current = (await storage.readManifest(P1, t.id)).current ?? '';
          await storage.writeManifest(P1, t.id, '{"broken', JSON.parse(current).generation as number);
          const report = await manager(storage).repair(ref, { apply: true });
          generations.push(report.generation);
          // A second corruption before any write: still a new generation.
          if (round % 2 === 0) {
            const again = (await storage.readManifest(P1, t.id)).current ?? '';
            await storage.writeManifest(P1, t.id, '{"broken again', JSON.parse(again).generation as number);
            generations.push((await manager(storage).repair(ref, { apply: true })).generation);
          }
          await record();
        }
        for (let i = 1; i < generations.length; i++) expect(generations[i]!).toBeGreaterThan(generations[i - 1]!);
        // Lost revisions left gaps: more numbers used than revisions kept.
        const kept = (await manager(storage).manifest(ref)).revisions.map((r) => r.revision);
        expect(new Set(kept).size).toBe(kept.length);
        expect(Math.max(...contentOf.keys())).toBeGreaterThan(kept.length);
      });

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
            const { templates: list, failures } = await reopened.list(P1);
            expect(failures).toEqual([]);
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
