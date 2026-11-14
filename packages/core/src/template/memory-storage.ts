/**
 * In-memory TemplateStorage (pure): tests and the local simulator.
 * Same contract as the filesystem adapter: the previous manifest becomes
 * the backup, writes are compare-and-swap on `generation`, bytes are copied
 * in and out so callers cannot alter stored data.
 */

import type { ManifestRead, ProjectId, TemplateId, TemplateStorage } from '../contracts/index.js';
import { StorageConflictError } from './errors.js';
import { manifestGeneration } from './manifest.js';

export interface MemoryTemplateStorage extends TemplateStorage {
  /** Test hook: direct access to the stored state (to simulate corruption). */
  readonly state: {
    readonly manifests: Map<string, { current: string | null; backup: string | null }>;
    readonly blobs: Map<string, Uint8Array>;
  };
}

export function createMemoryTemplateStorage(): MemoryTemplateStorage {
  const manifests = new Map<string, { current: string | null; backup: string | null }>();
  const blobs = new Map<string, Uint8Array>();
  const key = (projectId: ProjectId, id: string): string => `${projectId}/${id}`;

  return {
    state: { manifests, blobs },

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
