/**
 * Scheduler and engine events. Layer 4 (top).
 */

import type { AccountManager, AccountStatus } from './accounts.js';
import type { ReadWriteCanvasProvider } from './canvas.js';
import type { EngineConfig } from './config.js';
import type { Clock, AgentId, Timestamp } from './primitives.js';
import type { EtaEstimator, ProgressCalculator, ProgressSnapshot } from './progress.js';
import type { AgentResourceState, ResourceManager } from './resources.js';
import type { TemplateManager } from './template.js';
import type { AttemptManager, HistoryEntry, HistoryStore, WorkPlanner } from './work.js';

export type EngineEvent =
  | { readonly type: 'progress'; readonly progress: ProgressSnapshot; readonly etaMs: number | null }
  | { readonly type: 'resources'; readonly agent: AgentId; readonly resources: AgentResourceState }
  | { readonly type: 'agent-status'; readonly agent: AgentId; readonly status: AccountStatus }
  | { readonly type: 'attempt'; readonly entry: HistoryEntry }
  | { readonly type: 'error'; readonly message: string };

export interface EventSink {
  emit(event: EngineEvent): void;
}

export interface SchedulerDependencies {
  readonly config: EngineConfig;
  readonly clock: Clock;
  /** Must be writable: a read-only snapshot provider is rejected at compile time. */
  readonly canvas: ReadWriteCanvasProvider;
  readonly accounts: AccountManager;
  readonly resources: ResourceManager;
  readonly templates: TemplateManager;
  readonly planner: WorkPlanner;
  readonly attempts: AttemptManager;
  readonly progress: ProgressCalculator;
  readonly eta: EtaEstimator;
  readonly history: HistoryStore;
  readonly events: EventSink;
}

export interface TickReport {
  readonly at: Timestamp;
  readonly attempts: number;
  readonly applied: number;
  /** When the scheduler should run again (earliest agent readiness), or null when idle. */
  readonly nextTickAt: Timestamp | null;
}

/** Works on a collection of agents; the active count is bounded by EngineConfig.maxActiveAgents. */
export interface TaskScheduler {
  tick(): Promise<TickReport>;
  start(): void;
  stop(): Promise<void>;
}
