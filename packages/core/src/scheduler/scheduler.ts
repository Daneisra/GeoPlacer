/**
 * Single-agent scheduler (Phase 1B.8). It COORDINATES the existing
 * components, cycle after cycle, and re-implements none of their rules:
 *
 *   template (current revision)  -> TemplateSource, prepareTemplate
 *   leases expired                -> AttemptManager.expire
 *   canvas read                   -> CanvasReader.readRegion (template bounds)
 *   uncertain attempts            -> AttemptManager.reconcile (reads covering them)
 *   resources                     -> ResourceSource.observe -> ResourceManager
 *   progress, ETA                 -> computeProgress, estimateEta
 *   next batch                    -> nextBatch (WorkPlanner)
 *   lease / start / write / close -> AttemptManager + CanvasWriter
 *
 * Waiting (energy, availability, reconciliation) goes through
 * Clock.sleep(ms, signal): no busy loop; the virtual clock of the simulator
 * makes it instant in tests. Pause and stop wake a sleep up.
 *
 * A write that failed or whose answer was lost is never retried and never
 * considered applied: its attempt stays open and is reconciled from a
 * canvas read covering it (an observed correct color does not prove which
 * operation placed it). Stop never hides a started attempt: it is
 * reconciled when possible, otherwise reported open.
 */

import type {
  AbortSignalLike,
  AgentId,
  Attempt,
  AttemptId,
  CanvasRect,
  CanvasSnapshot,
  EtaResult,
  PlanResult,
  PreparedTemplate,
  ProgressSnapshot,
  SchedulerConfig,
  SchedulerDependencies,
  SchedulerError,
  SchedulerEvent,
  SchedulerState,
  SchedulerStatus,
  StopOptions,
  TaskScheduler,
  Template,
  Timestamp,
} from '../contracts/index.js';
import { templateBounds } from '../geometry/projection.js';
import { computeProgress } from '../progress/progress.js';
import { createIncrementalProgress } from '../progress/incremental.js';
import { estimateEta } from '../progress/eta.js';
import { nextBatch, prepareTemplate, prepareTemplateSync } from '../work/planner.js';

export class SchedulerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerConfigError';
  }
}

/** A minimal abort signal (the core has no DOM types). */
class Signal implements AbortSignalLike {
  aborted = false;
  private listeners: (() => void)[] = [];
  addEventListener(_type: 'abort', listener: () => void): void {
    if (this.aborted) listener();
    else this.listeners.push(listener);
  }
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const l of this.listeners.splice(0)) l();
  }
}

type CycleResult = { readonly kind: 'continue' } | { readonly kind: 'sleep'; readonly ms: number } | { readonly kind: 'end' };

const codeOf = (error: unknown): string => (error as { code?: string }).code ?? (error instanceof Error ? error.name : 'ERROR');
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function boundingRect(attempt: Attempt): CanvasRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const w of attempt.writes) {
    minX = Math.min(minX, w.point.x);
    minY = Math.min(minY, w.point.y);
    maxX = Math.max(maxX, w.point.x);
    maxY = Math.max(maxY, w.point.y);
  }
  return { minX, minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

const inside = (rect: CanvasRect, x: number, y: number): boolean => x >= rect.minX && y >= rect.minY && x < rect.minX + rect.width && y < rect.minY + rect.height;

export function validateSchedulerConfig(config: SchedulerConfig): void {
  const positive = (n: number): boolean => Number.isSafeInteger(n) && n > 0;
  if (config.agents.length === 0) throw new SchedulerConfigError('at least one agent is required');
  if (new Set(config.agents).size !== config.agents.length) throw new SchedulerConfigError('an agent appears twice');
  if (!positive(config.maxActiveAgents) || config.agents.length > config.maxActiveAgents) {
    throw new SchedulerConfigError(`${config.agents.length} agents for maxActiveAgents ${config.maxActiveAgents}`);
  }
  // V1: the single-agent loop only; the list stays for the multi-agent case.
  if (config.agents.length > 1) throw new SchedulerConfigError('multi-agent scheduling is not activated in V1: one agent');
  for (const [name, n] of [
    ['maxBatchSize', config.maxBatchSize],
    ['minBatchSize', config.minBatchSize],
    ['leaseTtlMs', config.leaseTtlMs],
    ['maxResourceAgeMs', config.maxResourceAgeMs],
    ['reconcileRetryMs', config.reconcileRetryMs],
    ['maxWaitMs', config.maxWaitMs],
    ['maxRecentErrors', config.maxRecentErrors],
  ] as const) {
    if (!positive(n)) throw new SchedulerConfigError(`${name} must be a positive integer`);
  }
  if (config.minBatchSize > config.maxBatchSize) throw new SchedulerConfigError('minBatchSize must not exceed maxBatchSize');
  if (config.maxCycles !== null && !positive(config.maxCycles)) throw new SchedulerConfigError('maxCycles must be a positive integer or null');
  if (config.progressMode !== undefined && config.progressMode !== 'full' && config.progressMode !== 'incremental') throw new SchedulerConfigError('progressMode must be full or incremental');
}

export function createScheduler(config: SchedulerConfig, deps: SchedulerDependencies): TaskScheduler {
  validateSchedulerConfig(config);
  const agent: AgentId = config.agents[0]!;
  const { clock, canvas, attempts, resources } = deps;
  const ref = { projectId: config.projectId, templateId: config.templateId };
  const progressOptions = config.freshness === undefined ? {} : { freshness: config.freshness };
  // A new scheduler (restart, restore, new world) starts with a new calculator: nothing is reused.
  const incremental = config.progressMode === 'incremental' ? createIncrementalProgress({ options: progressOptions }) : null;
  const cost = resources.rules.energy.costPerPixel;

  let state: SchedulerState = 'stopped';
  let reason: string | null = null;
  let recovered = false;
  let prepared: PreparedTemplate | null = null;
  let template: Template | null = null;
  let progress: ProgressSnapshot | null = null;
  let eta: EtaResult | null = null;
  let canvasSeen: SchedulerStatus['observations']['canvas'] = null;
  let nextAvailabilityAt: Timestamp | null = null;
  let cycles = 0;
  let applied = 0;
  let attemptsClosed = 0;
  let forceObserve = true;
  const errors: SchedulerError[] = [];
  const listeners = new Set<(event: SchedulerEvent) => void>();

  // Loop control.
  let loop: Promise<SchedulerStatus> | null = null;
  let pauseRequested = false;
  let stopRequested: StopOptions | null = null;
  let operation = new Signal(); // aborted by stop({ abort: true })
  let wake = new Signal(); // aborted by pause, resume or stop: interrupts a sleep
  const pausedWaiters: (() => void)[] = [];
  let resumeWaiter: (() => void) | null = null;
  /** The attempt whose write is in progress (never reconciled meanwhile). */
  let writing: AttemptId | null = null;

  function emit(event: SchedulerEvent): void {
    for (const l of [...listeners]) {
      try {
        l(event);
      } catch {
        // A listener never breaks the loop.
      }
    }
  }

  function setState(next: SchedulerState, why: string | null): void {
    if (next === state && why === reason) return;
    const from = state;
    state = next;
    reason = why;
    emit({ type: 'state', at: clock.now(), from, to: next, reason: why });
  }

  function recordError(code: string, message: string): void {
    const error = { at: clock.now(), code, message };
    errors.push(error);
    if (errors.length > config.maxRecentErrors) errors.splice(0, errors.length - config.maxRecentErrors);
    emit({ type: 'error', error });
  }

  function fail(code: string, message: string): CycleResult {
    recordError(code, message);
    setState('error', `${code}: ${message}`);
    return { kind: 'end' };
  }

  function status(): SchedulerStatus {
    const now = clock.now();
    let energy: number | null = null;
    let resourceSeen: SchedulerStatus['observations']['resources'] = null;
    const observed = resources.observed(agent);
    if (observed !== undefined) {
      try {
        const s = resources.stateAt(agent, Math.max(now, observed.at), Math.max(now, observed.at));
        energy = s.energy;
        resourceSeen = { at: s.observedAt, kind: s.kind };
      } catch {
        resourceSeen = { at: observed.observedAt, kind: observed.kind };
      }
    }
    const open = recovered ? attempts.open() : [];
    return {
      at: now,
      state,
      reason,
      projectId: config.projectId,
      templateId: config.templateId,
      revision: template?.revision ?? null,
      agent,
      cycles,
      workPixels: eta?.workPixels ?? (progress === null ? null : progress.incorrect + progress.unknown),
      correct: progress?.correct ?? null,
      incorrect: progress?.incorrect ?? null,
      unknown: progress?.unknown ?? null,
      progressPercent: progress?.conformityPercent ?? null,
      openAttempts: open.length,
      uncertainAttempts: open.filter((a) => a.state !== 'leased').map((a) => a.attemptId),
      energy,
      nextAvailabilityAt,
      eta: eta === null ? null : { durationMs: eta.durationMs, finishAt: eta.finishAt, unavailable: eta.unavailable },
      observations: { canvas: canvasSeen, resources: resourceSeen },
      applied,
      attemptsClosed,
      recentErrors: [...errors],
    };
  }

  async function ensureRecovered(): Promise<void> {
    if (recovered) return;
    setState('initializing', 'recovering the journal');
    const report = await attempts.recover(clock.now());
    recovered = true;
    forceObserve = true;
    if (report.damaged) recordError('JOURNAL_DAMAGED', `journal damaged (${report.corruptLines.length} line(s), ${report.sequenceGaps} gap(s)): leases need covering canvas reads`);
  }

  async function ensureTemplate(now: Timestamp): Promise<Template> {
    const current = await deps.templates.current(ref);
    if (current.projectId !== config.projectId || current.id !== config.templateId) throw new SchedulerConfigError('the template source returned another template');
    if (prepared === null || prepared.template.revision !== current.revision) {
      if (prepared !== null && current.revision > prepared.template.revision) await attempts.revisionChanged(config.projectId, config.templateId, current.revision, now);
      prepared = deps.hasher === undefined ? prepareTemplateSync(current) : await prepareTemplate(current, { hasher: deps.hasher, ...(deps.orderCache === undefined ? {} : { orderCache: deps.orderCache }) });
    }
    template = current;
    return current;
  }

  /** Observes the resources when unknown, uncertain or too old; returns false when they stay unusable. */
  async function ensureResources(now: Timestamp): Promise<void> {
    const observed = resources.observed(agent);
    const since = attempts.resourcesUncertainSince(agent);
    const stale = observed === undefined || now - observed.observedAt > config.maxResourceAgeMs || (since !== null && observed.observedAt <= since);
    if (!stale && !forceObserve) return;
    const obs = await deps.resourceSource.observe(agent, operation);
    if (observed !== undefined && obs.observedAt <= observed.observedAt) return; // nothing newer to learn yet
    resources.observe(obs);
    forceObserve = false;
  }

  /** Reconciles the uncertain attempts the reads cover; returns how many stay open. */
  async function reconcileUncertain(snapshot: CanvasSnapshot, now: Timestamp): Promise<number> {
    let pending = 0;
    for (const attempt of attempts.open()) {
      if (attempt.state === 'leased' || attempt.attemptId === writing) continue;
      const reads: CanvasSnapshot[] = [snapshot];
      if (attempt.writes.some((w) => !inside(snapshot.rect, w.point.x, w.point.y))) reads.push(await canvas.reader.readRegion(boundingRect(attempt), operation));
      try {
        const closed = await attempts.reconcile(attempt.attemptId, reads, now);
        attemptsClosed++;
        emit({ type: 'attempt', at: now, attemptId: closed.attemptId, state: 'reconciled', pixels: closed.writes.length, applied: 0 });
      } catch (error) {
        const code = codeOf(error);
        if (code !== 'STALE_SNAPSHOT' && code !== 'INCOMPLETE_OBSERVATION') throw error;
        pending++;
      }
    }
    return pending;
  }

  async function execute(plan: PlanResult, snapshot: CanvasSnapshot, now: Timestamp): Promise<CycleResult> {
    let leased: Attempt;
    try {
      leased = await attempts.lease({ agent, projectId: config.projectId, templateId: config.templateId, revision: prepared!.template.revision, writes: plan.writes, now, ttlMs: config.leaseTtlMs, evidence: snapshot });
    } catch (error) {
      recordError(codeOf(error), messageOf(error));
      forceObserve = true;
      return { kind: 'sleep', ms: config.reconcileRetryMs };
    }
    if (stopRequested?.abort === true) {
      await attempts.cancel(leased.attemptId, 'stopped before the write', clock.now());
      return { kind: 'end' };
    }
    await attempts.start(leased.attemptId, clock.now());
    writing = leased.attemptId;
    let result;
    try {
      result = await canvas.writer.applyPixels(agent, leased.writes, { attemptId: leased.attemptId, signal: operation });
    } catch (error) {
      // The request may or may not have been applied: never considered done, never resent.
      writing = null;
      recordError('WRITE_UNCERTAIN', `${messageOf(error)}: attempt ${leased.attemptId} will be reconciled from a canvas read`);
      setState('waiting-reconciliation', 'a write ended without a reliable answer');
      return { kind: 'sleep', ms: config.reconcileRetryMs };
    }
    writing = null;
    const t = clock.now();
    const rejected = result.outcomes.some((o) => o.status === 'rejected');
    const closed = rejected
      ? await attempts.fail(leased.attemptId, 'rejected by the canvas', result.outcomes, t, result.resources)
      : await attempts.finish(leased.attemptId, result.outcomes, t, result.resources);
    const appliedNow = result.outcomes.filter((o) => o.status === 'applied').length;
    applied += appliedNow;
    attemptsClosed++;
    emit({ type: 'attempt', at: t, attemptId: closed.attemptId, state: closed.state, pixels: closed.writes.length, applied: appliedNow });
    if (rejected) recordError('PIXELS_REJECTED', `${result.outcomes.filter((o) => o.status === 'rejected').length} pixel(s) rejected by the canvas`);
    return { kind: 'continue' };
  }

  async function cycle(): Promise<CycleResult> {
    await ensureRecovered();
    if (!attempts.usable()) return fail('JOURNAL_UNAVAILABLE', 'the journal is in an unknown state: restart the engine (recovery)');
    cycles++;
    if (config.maxCycles !== null && cycles > config.maxCycles) return fail('CYCLE_BUDGET', `more than ${config.maxCycles} cycles`);
    let now = clock.now();
    nextAvailabilityAt = null;
    let current: Template;
    try {
      current = await ensureTemplate(now);
    } catch (error) {
      return fail('TEMPLATE_UNAVAILABLE', messageOf(error));
    }
    await attempts.expire(now);
    const bounds = templateBounds(current.image, current.placement, current.coordinateSystem);
    let snapshot: CanvasSnapshot;
    try {
      snapshot = await canvas.reader.readRegion(bounds, operation);
    } catch (error) {
      recordError('CANVAS_READ_FAILED', messageOf(error));
      setState('waiting-reconciliation', 'the canvas could not be read');
      return { kind: 'sleep', ms: config.reconcileRetryMs };
    }
    canvasSeen = { at: snapshot.observedAt, source: snapshot.source };
    now = clock.now();
    const pending = await reconcileUncertain(snapshot, now);
    try {
      await ensureResources(now);
    } catch (error) {
      recordError('RESOURCES_UNAVAILABLE', messageOf(error));
      setState('waiting-resources', 'the resources could not be observed');
      return { kind: 'sleep', ms: config.reconcileRetryMs };
    }
    // An observation just made is dated after `now` on a real clock (Phase 1B.9): the cycle
    // continues at the later time, never asking for a state before the observation.
    now = Math.max(clock.now(), resources.observed(agent)?.at ?? 0);
    const resourcesNow = resources.stateAt(agent, now, now);
    progress = incremental !== null ? incremental.compute(current, snapshot, now) : computeProgress(current, snapshot, now, progressOptions);
    eta = estimateEta(progress, [{ id: agent, state: resourcesNow }], { rules: resources.rules, msPerPixel: config.eta.msPerPixel, minCoveragePercent: config.eta.minCoveragePercent, maxResourceAgeMs: config.maxResourceAgeMs, ...(config.eta.pauses === undefined ? {} : { pauses: config.eta.pauses }) }, now);
    emit({ type: 'progress', at: now, progress });
    const open = attempts.open().length;
    if ((progress.completion === 'complete' || progress.completion === 'no-eligible-pixels') && open === 0) {
      setState('completed', 'the canvas matches the template');
      return { kind: 'end' };
    }
    if (pauseRequested || stopRequested !== null) return { kind: 'continue' };

    const damage = attempts.damage();
    const plan = nextBatch(prepared!, {
      agent,
      snapshot,
      resources: resourcesNow,
      rules: resources.rules,
      maxBatch: config.maxBatchSize,
      inFlight: attempts.inFlight(),
      committedEnergy: attempts.committedEnergy(agent),
      unknownPixels: config.unknownPixels,
      ...(config.freshness === undefined ? {} : { freshness: config.freshness }),
      maxResourceAgeMs: config.maxResourceAgeMs,
      resourcesUncertainSince: attempts.resourcesUncertainSince(agent),
      damageFloor: damage === null ? null : damage.at,
      now,
    });

    switch (plan.status) {
      case 'refused': {
        const codes = plan.refusals.map((r) => r.code);
        if (codes.includes('AGENT_UNAVAILABLE')) {
          const until = resourcesNow.availability.status === 'unavailable' ? resourcesNow.availability.until : null;
          if (until === null) return fail('AGENT_UNAVAILABLE', 'the agent is unavailable with no end date');
          nextAvailabilityAt = until;
          setState('waiting-resources', `agent unavailable until ${until}`);
          return { kind: 'sleep', ms: Math.max(1, Math.min(until - now, config.maxWaitMs)) };
        }
        if (codes.every((c) => c === 'RESOURCES_UNCERTAIN' || c === 'STALE_RESOURCES' || c === 'STALE_SNAPSHOT' || c === 'SNAPSHOT_BEFORE_DAMAGE')) {
          forceObserve = true;
          setState('waiting-resources', `waiting for a newer observation (${codes.join(', ')})`);
          return { kind: 'sleep', ms: config.reconcileRetryMs };
        }
        return fail('PLAN_REFUSED', plan.refusals.map((r) => `${r.code}: ${r.message}`).join('; '));
      }
      case 'nothing-to-do': {
        if (open > 0 || pending > 0) {
          setState('waiting-reconciliation', `${open} attempt(s) still open, waiting for a covering canvas read`);
          return { kind: 'sleep', ms: config.reconcileRetryMs };
        }
        const blocked = plan.unavailableColors.length > 0 ? `${plan.unavailableColors.reduce((n, c) => n + c.pixels, 0)} pixel(s) of colors the agent has not unlocked` : `${progress.unknown} pixel(s) never observed`;
        return fail('BLOCKED', `work left that the agent cannot do: ${blocked}`);
      }
      case 'waiting': {
        if (plan.waitMs === null) return fail('ENERGY_NEVER_SUFFICIENT', 'the agent never regenerates enough energy for one pixel');
        // One wait for the whole minimal batch (not one pixel, then the rest).
        const wanted = Math.max(1, Math.min(config.minBatchSize, plan.candidates));
        const wait = resources.timeUntil(agent, wanted * cost + attempts.committedEnergy(agent), now) ?? plan.waitMs;
        nextAvailabilityAt = now + wait;
        setState('waiting-resources', `waiting for the energy of ${wanted} pixel(s)`);
        return { kind: 'sleep', ms: Math.max(1, Math.min(wait, config.maxWaitMs)) };
      }
      case 'ok': {
        const wanted = Math.min(config.minBatchSize, plan.candidates);
        if (plan.writes.length < wanted) {
          const wait = resources.timeUntil(agent, wanted * cost + attempts.committedEnergy(agent), now);
          if (wait === null) return fail('ENERGY_NEVER_SUFFICIENT', `the agent never holds the energy of ${wanted} pixel(s) (minBatchSize)`);
          nextAvailabilityAt = now + wait;
          setState('waiting-resources', `waiting for the energy of ${wanted} pixel(s)`);
          return { kind: 'sleep', ms: Math.max(1, Math.min(wait, config.maxWaitMs)) };
        }
        setState('running', null);
        return execute(plan, snapshot, now);
      }
    }
  }

  async function sleep(ms: number): Promise<void> {
    wake = new Signal();
    try {
      await clock.sleep(ms, wake);
    } catch {
      // Woken up by pause, resume or stop.
    }
  }

  /** At stop: a started attempt is reconciled when a covering read is possible, otherwise left open (reported). */
  async function settleUncertain(): Promise<void> {
    if (!recovered || !attempts.usable()) return;
    const uncertain = attempts.open().filter((a) => a.state !== 'leased');
    for (const attempt of uncertain) {
      try {
        const read = await canvas.reader.readRegion(boundingRect(attempt));
        await attempts.reconcile(attempt.attemptId, read, clock.now());
        attemptsClosed++;
      } catch (error) {
        recordError('LEFT_UNCERTAIN', `attempt ${attempt.attemptId} stays open (${messageOf(error)}): reconciled at the next start`);
      }
    }
  }

  async function run(): Promise<SchedulerStatus> {
    for (;;) {
      if (stopRequested !== null) break;
      if (pauseRequested) {
        setState('paused', 'pause requested');
        for (const w of pausedWaiters.splice(0)) w();
        await new Promise<void>((resolve) => (resumeWaiter = resolve));
        resumeWaiter = null;
        continue;
      }
      let result: CycleResult;
      try {
        result = await cycle();
      } catch (error) {
        result = fail(codeOf(error), messageOf(error));
      }
      emit({ type: 'cycle', status: status() });
      if (result.kind === 'end') break;
      if (result.kind === 'sleep') await sleep(result.ms);
    }
    if (stopRequested !== null) {
      await settleUncertain();
      setState('stopped', stopRequested.abort === true ? 'stopped (operation aborted)' : 'stop requested');
    }
    for (const w of pausedWaiters.splice(0)) w();
    return status();
  }

  const scheduler: TaskScheduler = {
    async start() {
      if (loop !== null) throw new SchedulerConfigError('the scheduler is already running');
      stopRequested = null;
      pauseRequested = false;
      operation = new Signal();
      await ensureRecovered();
      setState('running', null);
      loop = run().finally(() => {
        loop = null;
      });
    },
    pause() {
      if (loop === null) return Promise.resolve();
      pauseRequested = true;
      wake.abort();
      return new Promise<void>((resolve) => {
        if (state === 'paused') resolve();
        else pausedWaiters.push(resolve);
      });
    },
    resume() {
      pauseRequested = false;
      wake.abort();
      resumeWaiter?.();
    },
    async stop(options = {}) {
      stopRequested = options;
      if (options.abort === true) operation.abort();
      wake.abort();
      resumeWaiter?.();
      if (loop !== null) return loop;
      if (state !== 'stopped') {
        await settleUncertain();
        setState('stopped', 'stop requested');
      }
      return status();
    },
    status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    done() {
      return loop ?? Promise.resolve(status());
    },
    async step() {
      if (loop !== null) throw new SchedulerConfigError('step() is for a scheduler that is not running');
      let result: CycleResult;
      try {
        result = await cycle();
      } catch (error) {
        result = fail(codeOf(error), messageOf(error));
      }
      if (result.kind === 'continue' && state !== 'running' && state !== 'error' && state !== 'completed') setState('running', null);
      emit({ type: 'cycle', status: status() });
      if (result.kind === 'sleep') await clock.sleep(result.ms);
      return status();
    },
  };
  return scheduler;
}
