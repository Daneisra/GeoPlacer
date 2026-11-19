import { describe, expect, it } from 'vitest';
import { burstBudget, type EnergyPolicy } from '../src/geopixels/drawing-energy.js';

const policy: EnergyPolicy = {
    mode: 'bursts', start: { units: 200, percent: 80 },
    restart: { units: 150, percent: 50 }, reserve: { units: 10, percent: 5 },
};

describe('Salves énergétiques', () => {
    it('uses the highest absolute or percentage threshold and rounds reserves up', () => {
        expect(burstBudget(policy, 'start', 200, 301)).toMatchObject({ spendable: 0, target: 241, reserve: 16 });
        expect(burstBudget(policy, 'start', 241, 301)).toMatchObject({ phase: 'draining', spendable: 225 });
        expect(burstBudget(policy, 'draining', 40, 301)).toMatchObject({ phase: 'draining', spendable: 24 });
        expect(burstBudget(policy, 'draining', 16, 301)).toMatchObject({ phase: 'recharge', spendable: 0, target: 151 });
        expect(burstBudget(policy, 'recharge', 17, 301).spendable).toBe(0);
        expect(burstBudget(policy, 'recharge', 151, 301).spendable).toBe(135);
    });
    it('waits for capacity and explains impossible thresholds', () => {
        expect(burstBudget(policy, 'start', 20, null).reason).toMatch(/capacité observée/);
        expect(burstBudget(policy, 'start', 150, 150).reason).toMatch(/incompatible/);
    });
    it('interprets a blank threshold as a full reserve and a blank reserve as zero', () => {
        const empty = { units: 0, percent: 0 };
        const full: EnergyPolicy = { mode: 'bursts', start: empty, restart: empty, reserve: empty };
        expect(burstBudget(full, 'start', 289, 290)).toMatchObject({ target: 290, spendable: 0 });
        expect(burstBudget(full, 'start', 290, 290)).toMatchObject({ reserve: 0, spendable: 290 });
        expect(burstBudget({ mode: 'continuous' }, 'start', 1, 290).spendable).toBe(1);
    });
});
