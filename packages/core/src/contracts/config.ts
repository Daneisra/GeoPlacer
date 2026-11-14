/**
 * Engine configuration. Layer 0.
 */

/** V1 production rule: a single active agent. Only simulator tests may raise it. */
export const DEFAULT_MAX_ACTIVE_AGENTS = 1;

export interface EngineConfig {
  /** Production V1 uses DEFAULT_MAX_ACTIVE_AGENTS (1). Multi-agent values are for the simulator only. */
  readonly maxActiveAgents: number;
  /** Lease duration of an attempt before it is considered abandoned. */
  readonly leaseTtlMs: number;
  /** Upper bound of pixels planned per batch (bounded work window). */
  readonly maxBatchSize: number;
}
