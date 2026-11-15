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
  status(): unknown;
  start(): Promise<CommandResultLike>;
  pause(): Promise<CommandResultLike>;
  resume(): CommandResultLike;
  stop(options?: { readonly abort?: boolean }): Promise<CommandResultLike>;
  subscribe(listener: (e: EngineEventEnvelopeLike) => void): () => void;
  readonly stream: { readonly id: string; readonly seq: number };

  listTemplates(): Promise<unknown>;
  importTemplate(input: { readonly name: string; readonly png: Uint8Array; readonly x: number; readonly y: number; readonly strategy: string }): Promise<unknown>;
  templateInfoOf(templateId: string): Promise<unknown>;
  templateImage(templateId: string): Promise<unknown>;
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
  canvasRegion(rect?: { readonly minX: number; readonly minY: number; readonly width: number; readonly height: number }): Promise<unknown>;
  simulateExternalEdit(count: number): Promise<unknown>;

  resourcesView(): Promise<unknown>;
  applyUpgrade(proposalId: string, confirmed: boolean): Promise<unknown>;

  attemptsView(): unknown;
  journalDiagnosis(): Promise<unknown>;
  compact(): Promise<unknown>;
  /** Backup of the data directory, stopped only, into the server's backup directory (Phase 1B.10). */
  backup(): Promise<unknown>;
}

/** True for an error thrown by the engine with a stable code (EngineServiceError and the like). */
export function isEngineApiError(error: unknown): error is EngineApiError {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as Partial<EngineApiError>;
  return typeof e.code === 'string' && typeof e.status === 'number' && e.status >= 400 && e.status < 600 && typeof e.message === 'string';
}
