/**
 * What the /api/v1 routes and the engine WebSocket need from the engine
 * (Phase 1B.9). A structural interface: the real implementation is
 * EngineService (@geoplacer/engine-service), wired in src/engine/bootstrap.ts;
 * the route tests use a fake. No business rule lives in the routes.
 */

/** A refused command: the service throws an error carrying a stable code and an HTTP status. */
export interface EngineApiError {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly details?: unknown;
}

export interface EngineEventEnvelopeLike {
  readonly stream: string;
  readonly seq: number;
  readonly at: number;
  readonly event: { readonly type: string } & Record<string, unknown>;
}

export interface CommandResultLike {
  readonly changed: boolean;
  readonly status: unknown;
}

export interface EngineApi {
    readonly singlePixelWriter?: import('@geoplacer/engine-service').SinglePixelWriter;
    readonly connector?: import('@geoplacer/engine-service').GeoPixelsProvider;
    readonly pairing?: import('@geoplacer/engine-service').ConnectorPairing;
    selectSource?(source: 'simulation' | 'geopixels'): Promise<CommandResultLike>;
    bindConnector?(): Promise<unknown>;
    connectorView?(): Promise<unknown>;
    importDrawing?(input:import('@geoplacer/engine-service').GhostImportInput & { useAccountPalette?: boolean }):Promise<unknown>;
    drawingLibrary?(): Promise<unknown>;
    editDrawingPreferences?(edit: import('@geoplacer/engine-service').DrawingPreferencesEdit): Promise<unknown>;
    setDrawingStrategy?(templateId: string, strategy: import('@geoplacer/core').DrawingStrategyId): Promise<unknown>;
    deleteDrawing?(templateId: string, confirmName: string): Promise<unknown>;
    exportDrawing?(templateId: string, thumbnail?: boolean): Promise<{ png: Uint8Array; filename: string }>;
    previewDrawing?(groupSize?: number, pixelBudget?: number, upgrades?: import('@geoplacer/engine-service').AutomaticUpgradePolicy, energy?: import('@geoplacer/engine-service').EnergyPolicy, groups?: import('@geoplacer/engine-service').GroupPolicy): Promise<unknown>;
    configureConnectorRegions?(regions: unknown, restore?: boolean): Promise<unknown>;
    connectorProposals?(policy: import('@geoplacer/core').UpgradePolicy): Promise<unknown>;

    status(): unknown;
    start(): Promise<CommandResultLike>;
    pause(): Promise<CommandResultLike>;
    resume(): CommandResultLike;
    stop(options?: { readonly abort?: boolean }): Promise<CommandResultLike>;
    subscribe(listener: (e: EngineEventEnvelopeLike) => void): () => void;
    readonly stream: { readonly id: string; readonly seq: number };

    listTemplates(): Promise<unknown>;
    importTemplate(input: {
        readonly name: string;
        readonly png: Uint8Array;
        readonly x: number;
        readonly y: number;
        readonly strategy: string;
    }): Promise<unknown>;
    templateInfoOf(templateId: string): Promise<unknown>;
    templateImage(
        templateId: string,
        rect?: { readonly minX: number; readonly minY: number; readonly width: number; readonly height: number },
        scale?: number
    ): Promise<unknown>;
    selectTemplate(templateId: string): Promise<CommandResultLike>;
    moveTemplate(templateId: string, x: number, y: number): Promise<unknown>;

    readonly settings: unknown;
    configure(patch: {
        readonly simulator?: Record<string, number>;
        readonly agent?: Record<string, number>;
        readonly run?: Record<string, number>;
        readonly resetWorld?: boolean;
    }): Promise<CommandResultLike>;
    resetWorld(confirm: string): Promise<CommandResultLike>;
    resetAgent(): Promise<CommandResultLike>;
    canvasRegion(
        rect?: { readonly minX: number; readonly minY: number; readonly width: number; readonly height: number },
        scale?: number
    ): Promise<unknown>;
    simulateExternalEdit(count: number): Promise<unknown>;

    resourcesView(): Promise<unknown>;
    applyUpgrade(proposalId: string, confirmed: boolean): Promise<unknown>;

    attemptsView(): unknown;
    journalDiagnosis(): Promise<unknown>;
    compact(): Promise<unknown>;
    /** Backup of the data directory, stopped only, into the server's backup directory (Phase 1B.10). */
    backup(): Promise<unknown>;
    /** Demonstration (Phase 1B.10): availability (empty project only), and its setup. */
    demoAvailability(): Promise<unknown>;
    setupDemo(): Promise<CommandResultLike>;

    /**
     * Phase 1C.1: GeoPixels ghost image export. Local only: the PNG is imported by hand in the
     * native tool of GeoPixels; nothing is ever sent to GeoPixels.
     */
    importGhost(input: {
        readonly name: string;
        readonly png: Uint8Array;
        readonly palette: readonly string[];
        readonly width?: number;
        readonly height?: number;
        readonly alphaThreshold?: number;
        readonly x?: number;
        readonly y?: number;
    }): Promise<unknown>;
    listGhosts(): Promise<unknown>;
    ghostInfoOf(templateId: string): Promise<unknown>;
    exportGhost(templateId: string): Promise<{ readonly png: Uint8Array; readonly filename: string }>;
    deleteGhost(templateId: string): Promise<unknown>;
}

/** True for an error thrown by the engine with a stable code (EngineServiceError and the like). */
export function isEngineApiError(error: unknown): error is EngineApiError {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as Partial<EngineApiError>;
  return typeof e.code === 'string' && typeof e.status === 'number' && e.status >= 400 && e.status < 600 && typeof e.message === 'string';
}
