/**
 * Accounts / agents. Layer 1.
 */

import type { AgentId, Timestamp } from './primitives.js';

export type AccountStatus = 'inactive' | 'ready' | 'cooldown' | 'expired' | 'suspended' | 'error';

/** Public view of an agent: never holds credentials (kept by a server-side session store). */
export interface AccountSession {
  readonly agentId: AgentId;
  readonly displayName: string;
  readonly status: AccountStatus;
  readonly expiresAt?: Timestamp;
  readonly lastCheckedAt?: Timestamp;
}

export interface AccountManager {
  list(): readonly AccountSession[];
  get(id: AgentId): AccountSession | undefined;
  /** Throws when EngineConfig.maxActiveAgents would be exceeded (1 in V1 production). */
  activate(id: AgentId): AccountSession;
  deactivate(id: AgentId): AccountSession;
  activeAgents(): readonly AccountSession[];
}
