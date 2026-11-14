/**
 * In-memory TemplateStorage (pure): tests and the local simulator.
 * Same contract as the filesystem adapter: the previous manifest becomes
 * the backup, writes are compare-and-swap on `generation`, bytes are copied
 * in and out so callers cannot alter stored data.
 */

import type { ManifestRead, ProjectId, ReservationMaxima, TemplateId, TemplateStorage } from '../contracts/index.js';
import { StorageConflictError } from './errors.js';
import { manifestGeneration } from './manifest.js';

export interface MemoryTemplateStorage extends TemplateStorage {
  /** Test hook: direct access to the stored state (to simulate corruption). */
  readonly state: {
    readonly manifests: Map<string, { current: string | null; backup: string | null }>;
    readonly blobs: Map<string, Uint8Array>;
    /** Corrupt manifests preserved by replaceManifest (repair), by name. */
    readonly preserved: Map<string, string>;
    /** Reservation records by template key: 'generation:<n>' / 'revision:<n>'. */
    readonly reservations: Map<string, Set<string>>;
  };
}

export function createMemoryTemplateStorage(): MemoryTemplateStorage {
  const manifests = new Map<string, { current: string | null; backup: string | null }>();
  const blobs = new Map<string, Uint8Array>();
  const preserved = new Map<string, string>();
  const reservations = new Map<string, Set<string>>();
  const key = (projectId: ProjectId, id: string): string => `${projectId}/${id}`;

  return {
    state: { manifests, blobs, preserved, reservations },

    async readManifest(projectId: ProjectId, templateId: TemplateId): Promise<ManifestRead> {
      const entry = manifests.get(key(projectId, templateId));
      return { current: entry?.current ?? null, backup: entry?.backup ?? null };
    },

    async writeManifest(projectId: ProjectId, templateId: TemplateId, json: string, expectedGeneration: number | null): Promise<void> {
      const k = key(projectId, templateId);
      const entry = manifests.get(k);
      const actual = manifestGeneration(entry?.current ?? null);
      const exists = entry?.current != null;
      if (expectedGeneration === null ? exists : actual !== expectedGeneration) {
        throw new StorageConflictError(expectedGeneration, actual);
      }
      manifests.set(k, { current: json, backup: entry?.current ?? null });
    },

    async replaceManifest(projectId: ProjectId, templateId: TemplateId, json: string, expectedCurrent: string | null): Promise<string | null> {
      const k = key(projectId, templateId);
      const entry = manifests.get(k);
      const current = entry?.current ?? null;
      if (current !== expectedCurrent) throw new StorageConflictError(null, manifestGeneration(current));
      let name: string | null = null;
      if (current !== null) {
        name = `${k}/manifest.json.corrupt-${preserved.size + 1}`;
        preserved.set(name, current);
      }
      manifests.set(k, { current: json, backup: entry?.backup ?? null });
      return name;
    },

    async reserve(projectId: ProjectId, templateId: TemplateId, kind: 'generation' | 'revision', value: number): Promise<void> {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${kind} number: ${String(value)}`);
      const k = key(projectId, templateId);
      const set = reservations.get(k) ?? new Set<string>();
      const name = `${kind}:${value}`;
      if (set.has(name)) throw new StorageConflictError(null, null);
      set.add(name);
      reservations.set(k, set);
    },

    async reservations(projectId: ProjectId, templateId: TemplateId): Promise<ReservationMaxima> {
      let generation: number | null = null;
      let revision: number | null = null;
      for (const name of reservations.get(key(projectId, templateId)) ?? []) {
        const [kind, raw] = name.split(':');
        const value = Number(raw);
        if (kind === 'generation') generation = Math.max(generation ?? 0, value);
        else revision = Math.max(revision ?? 0, value);
      }
      return { generation, revision };
    },

    async listTemplates(projectId: ProjectId): Promise<readonly TemplateId[]> {
      const prefix = `${projectId}/`;
      return [...manifests.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length) as TemplateId).sort();
    },

    async readBlob(projectId: ProjectId, address: string): Promise<Uint8Array | null> {
      const bytes = blobs.get(key(projectId, address));
      return bytes === undefined ? null : bytes.slice();
    },

    async writeBlob(projectId: ProjectId, address: string, bytes: Uint8Array): Promise<void> {
      blobs.set(key(projectId, address), bytes.slice());
    },
  };
}
