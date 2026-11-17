/**
 * @geoplacer/engine-service (Phase 1B.9): the orchestration service between
 * the engine packages and the server. Phase 2A adds an opt-in observation provider; the durable simulated
 * world and existing scheduler remain available. Real service writes are disabled.
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
export { monotonicClock, type MonotonicClock } from './clock.js';
export { EngineEventHub, type AttemptEventSummary, type EngineEvent, type EngineEventEnvelope, type EventHubOptions } from './events.js';
export {
  DEFAULT_SETTINGS,
  DEMO_COLORS,
  DEMO_PALETTE,
  LIMITS,
  SETTINGS_FILE,
  SIMULATED_AGENT,
  SIMULATION_PROJECT,
  STRATEGIES,
  SettingsError,
  rulesOf,
  validateSettings,
  type AgentSettings,
  type EngineSettings,
  type RunSettings,
  type SimulatorSettings,
} from './settings.js';
export {
  EngineService,
  EngineServiceError,
  type CanvasRegion,
  type CommandResult,
  type EngineErrorCode,
  type EngineServiceOptions,
  type EngineStatus,
  type ResourcesView,
  type TemplateInfo,
} from './service.js';
export {
  BACKUP_FORMAT_VERSION,
  BackupError,
  assertNoRestoreInProgress,
  createBackup,
  dataDirKind,
  restoreBackup,
  restoreStateFile,
  resumeRestore,
  verifyBackup,
  type BackupErrorCode,
  type BackupFileEntry,
  type BackupManifest,
  type RestoreOptions,
  type RestoreReport,
  type RestoreStep,
} from './backup.js';
export { DEMO_HEIGHT, DEMO_POSITION, DEMO_SETTINGS, DEMO_STRATEGY, DEMO_TEMPLATE_NAME, DEMO_WIDTH, demoPixels, demoRgba } from './demo.js';
export { GHOST_PROJECT, MAX_GHOST_COLORS, ghostFilename, hexOf, parsePalette, type GhostImportInput, type GhostInfo } from './ghost.js';

export { GeoPixelsProvider, nativePoint, nativeTile } from './geopixels/provider.js';
export { ConnectorPairing, localOrigin } from './geopixels/pairing.js';
export { ConnectorError, parseObservation } from './geopixels/protocol.js';
export type { ConnectorMode, BrowserProject, BrowserObservation } from './geopixels/protocol.js';

export { ConnectorHttpChannel } from './geopixels/http-channel.js';

export { SinglePixelWriter, type SinglePixelCommand } from './geopixels/single-pixel-writer.js';
