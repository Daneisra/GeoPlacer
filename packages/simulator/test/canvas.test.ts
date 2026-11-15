import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AgentId, AttemptId, PixelWrite, ReadWriteCanvasProvider, ResourceRules, Rgb, TaskId } from '@geoplacer/core';
import { TRANSPARENT, UNKNOWN } from '@geoplacer/core';
import { SimulatedCanvasError, SimulatedCanvasProvider, createManualClock } from '../src/index.js';

const RED = 0xff0000 as Rgb;
const GREEN = 0x00ff00 as Rgb;
const BLUE = 0x0000ff as Rgb;
const A = 'agent-1' as AgentId;

// SYNTHETIC rules (tests only, not a real service).
const RULES: ResourceRules = {
  schemaVersion: 1,
  id: 'test-simulator',
  version: 1,
  energy: { costPerPixel: 1, baseCapacity: 10, capacityLimit: 10, regenAmount: 1, regenIntervalMs: 1000, aboveCapacity: 'keep' },
  palette: { initialColors: [RED, GREEN], unlockable: [] },
  upgrades: { maxEnergy: [], regenSpeed: [], energyPack: { cost: 1, energy: 1, maxPurchases: 0 } },
  currency: { maxSpendPerOperation: 1 },
};

function world(options: { idempotent?: boolean; yAxis?: 'up' | 'down' } = {}) {
  const clock = createManualClock(1_000);
  const canvas = new SimulatedCanvasProvider({ bounds: { minX: -2, minY: 10, width: 4, height: 3 }, coordinateSystem: { yAxis: options.yAxis ?? 'down' }, rules: RULES, clock, idempotentWrites: options.idempotent ?? false });
  canvas.addAgent({ agent: A, energy: 5, unlockedColors: [RED, GREEN] });
  return { clock, canvas };
}
const w = (x: number, y: number, color: Rgb = RED, id = `${x},${y}`): PixelWrite => ({ taskId: id as TaskId, point: { x, y }, color });
const att = (n: number): { attemptId: AttemptId } => ({ attemptId: `att-${n}` as AttemptId });

describe('SimulatedCanvasProvider: contracts and reading', () => {
  it('is a read-write canvas provider', () => {
    const { canvas } = world();
    expectTypeOf(canvas).toMatchTypeOf<ReadWriteCanvasProvider>();
    expect(canvas.mode).toBe('read-write');
    expect(canvas.reader.coordinateSystem).toEqual({ yAxis: 'down' });
  });

  it('reads a region: dated by the clock, copied, UNKNOWN outside the bounds, readRow = get', async () => {
    const { clock, canvas } = world({ yAxis: 'up' });
    canvas.paint({ x: -2, y: 10 }, BLUE);
    clock.advance(5);
    const snap = await canvas.reader.readRegion({ minX: -3, minY: 9, width: 6, height: 5 });
    expect(snap).toMatchObject({ observedAt: 1_005, source: 'simulated', coordinateSystem: { yAxis: 'up' } });
    expect(snap.get({ x: -2, y: 10 })).toBe(BLUE);
    expect(snap.get({ x: -1, y: 10 })).toBe(TRANSPARENT);
    expect(snap.get({ x: -3, y: 10 })).toBe(UNKNOWN); // outside the canvas bounds
    expect(snap.get({ x: 2, y: 10 })).toBe(UNKNOWN);
    expect(snap.get({ x: 0, y: 13 })).toBe(UNKNOWN);
    for (let y = 9; y < 14; y++) {
      const row = new Int32Array(6);
      snap.readRow!(y, -3, 3, row);
      expect([...row]).toEqual(Array.from({ length: 6 }, (_, k) => snap.get({ x: -3 + k, y })));
    }
    canvas.paint({ x: -2, y: 10 }, GREEN);
    expect(snap.get({ x: -2, y: 10 })).toBe(BLUE); // a snapshot does not change afterwards
    const aborted = { aborted: true, addEventListener() {} };
    await expect(canvas.reader.readRegion({ minX: 0, minY: 10, width: 1, height: 1 }, aborted)).rejects.toThrow(SimulatedCanvasError);
  });
});

describe('SimulatedCanvasProvider: writes', () => {
  it('applies in order: bounds, color, already correct (free), energy; reports the resources after', async () => {
    const { canvas } = world();
    canvas.paint({ x: 1, y: 11 }, GREEN);
    const result = await canvas.writer.applyPixels(A, [w(5, 5), w(0, 10, BLUE), w(1, 11, GREEN), w(0, 10), w(1, 10), w(-1, 10), w(-2, 10), w(-2, 11), w(-1, 11)], att(1));
    expect(result.outcomes.map((o) => (o.status === 'rejected' ? o.reason : o.status))).toEqual(['out-of-bounds', 'color-locked', 'already-correct', 'applied', 'applied', 'applied', 'applied', 'applied', 'no-energy']);
    expect(result.resources).toMatchObject({ agent: A, energy: 0, observedAt: 1_000 });
    expect(canvas.at({ x: -1, y: 11 })).toBe(TRANSPARENT);
  });

  it('regenerates energy with the core rules and the injected clock', async () => {
    const { clock, canvas } = world();
    await canvas.writer.applyPixels(A, [w(-2, 10), w(-1, 10), w(0, 10), w(1, 10), w(-2, 11)], att(1));
    expect(canvas.observe(A).energy).toBe(0);
    clock.advance(2_500);
    expect(canvas.observe(A)).toMatchObject({ energy: 2, regenProgressMs: 500 });
    const r = await canvas.writer.applyPixels(A, [w(-1, 11), w(0, 11), w(1, 11)], att(2));
    expect(r.outcomes.map((o) => o.status)).toEqual(['applied', 'applied', 'rejected']);
  });

  it('idempotency by attempt id, when enabled: a repeated attempt is not applied again', async () => {
    for (const idempotent of [true, false]) {
      const { canvas } = world({ idempotent });
      const first = await canvas.writer.applyPixels(A, [w(0, 10)], att(1));
      canvas.erase({ x: 0, y: 10 });
      const again = await canvas.writer.applyPixels(A, [w(0, 10)], att(1));
      expect({ idempotent, again: again.outcomes[0]!.status, count: canvas.appliedCount({ x: 0, y: 10 }) }).toEqual({ idempotent, again: 'applied', count: idempotent ? 1 : 2 });
      expect(again === first).toBe(idempotent);
    }
  });

  it('deterministic faults: before, partial, answer lost, rejected, unknown outcomes', async () => {
    const { canvas } = world();
    canvas.injectFaults({ kind: 'fail-before' }, { kind: 'partial', applied: 2 }, { kind: 'answer-lost' }, { kind: 'reject', reason: 'rate-limited' }, { kind: 'unknown-outcomes' });
    const writes = [w(-2, 10), w(-1, 10), w(0, 10)];
    await expect(canvas.writer.applyPixels(A, writes, att(1))).rejects.toMatchObject({ fault: 'fail-before' });
    expect(canvas.events).toEqual([]);
    await expect(canvas.writer.applyPixels(A, writes, att(2))).rejects.toMatchObject({ fault: 'partial' });
    expect([canvas.at({ x: -2, y: 10 }), canvas.at({ x: -1, y: 10 }), canvas.at({ x: 0, y: 10 })]).toEqual([RED, RED, TRANSPARENT]);
    await expect(canvas.writer.applyPixels(A, [w(1, 10)], att(3))).rejects.toMatchObject({ fault: 'answer-lost' });
    expect(canvas.at({ x: 1, y: 10 })).toBe(RED);
    const rejected = await canvas.writer.applyPixels(A, [w(-2, 11)], att(4));
    expect(rejected.outcomes).toEqual([{ taskId: '-2,11', status: 'rejected', reason: 'rate-limited' }]);
    expect(canvas.at({ x: -2, y: 11 })).toBe(TRANSPARENT);
    const unknown = await canvas.writer.applyPixels(A, [w(-1, 11)], att(5));
    expect(unknown.outcomes).toEqual([{ taskId: '-1,11', status: 'unknown' }]);
    expect(canvas.at({ x: -1, y: 11 })).toBe(RED);
    expect(canvas.pendingFaults).toBe(0);
    expect(canvas.writeCalls).toBe(5);
  });

  it('external actors paint and erase; a batch over the limit is refused', async () => {
    const clock = createManualClock(0);
    const canvas = new SimulatedCanvasProvider({ bounds: { minX: 0, minY: 0, width: 2, height: 2 }, coordinateSystem: { yAxis: 'down' }, rules: RULES, clock, maxPixelsPerWrite: 1 });
    canvas.addAgent({ agent: A, energy: 5, unlockedColors: [RED] });
    canvas.paint({ x: 1, y: 1 }, BLUE);
    canvas.erase({ x: 1, y: 1 });
    expect(canvas.events.map((e) => [e.kind, e.color])).toEqual([
      ['external', BLUE],
      ['external', TRANSPARENT],
    ]);
    expect(() => canvas.paint({ x: 2, y: 0 }, BLUE)).toThrow();
    await expect(canvas.writer.applyPixels(A, [w(0, 0), w(1, 0)], att(1))).rejects.toThrow(/at most 1/);
    expect(() => clock.set(-1)).toThrow();
  });
});
