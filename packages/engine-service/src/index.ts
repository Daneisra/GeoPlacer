/**
 * @geoplacer/engine-service (Phase 1B.9): the orchestration service between
 * the engine packages and the server. Local simulation only: the only
 * canvas provider is the simulated one, with a durable world.
 */

export {
  FileWorldStore,
  WORLD_FORMAT_VERSION,
  WorldStoreError,
  type FileWorldStoreOptions,
  type LoadedWorld,
  type WorldIdentity,
  type WorldOpenReport,
  type WorldStoreErrorCode,
  type WorldStoreStep,
} from './world-store.js';
