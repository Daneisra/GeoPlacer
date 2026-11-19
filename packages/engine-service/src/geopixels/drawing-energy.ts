export type Threshold = { units: number; percent: number };
export type EnergyPolicy = { mode: 'continuous' } | {
    mode: 'bursts'; start: Threshold; restart: Threshold; reserve: Threshold;
};
export type GroupPolicy = { mode: 'adaptive' | 'manual'; minimum: number; allowFinal: boolean };
export type BurstPhase = 'start' | 'draining' | 'recharge';

export function validEnergyPolicy(policy: EnergyPolicy): boolean {
    if (policy?.mode === 'continuous') return Object.keys(policy).length === 1;
    return policy?.mode === 'bursts' && Object.keys(policy).length === 4 &&
        [policy.start, policy.restart, policy.reserve].every(t => t && Object.keys(t).length === 2 &&
            Number.isSafeInteger(t.units) && t.units >= 0 && t.units <= 1e9 &&
            Number.isSafeInteger(t.percent) && t.percent >= 0 && t.percent <= 100);
}

/** A balance observation gates writes; an elapsed local timer grants no energy. */
export function burstBudget(policy: EnergyPolicy | undefined, phase: BurstPhase, available: number | null, capacity: number | null) {
    const result = (nextPhase: BurstPhase, spendable: number, reserve: number | null, target: number | null, reason: string | null) =>
        ({ phase: nextPhase, spendable, reserve, target, reason });
    if (!policy || policy.mode === 'continuous')
        return result(phase, available ?? 0, 0, null, available === null ? 'Attente d’une lecture d’énergie.' : null);
    const threshold = phase === 'start' ? policy.start : policy.restart;
    const percent = threshold.units === 0 && threshold.percent === 0 ? 100 : threshold.percent;
    if (capacity === null && (percent > 0 || policy.reserve.percent > 0))
        return result(phase, 0, null, null, 'Attente de la capacité observée pour calculer les pourcentages.');
    const reserve = Math.max(policy.reserve.units, Math.ceil((capacity ?? 0) * policy.reserve.percent / 100));
    const target = Math.max(threshold.units, Math.ceil((capacity ?? 0) * percent / 100));
    if (available === null) return result(phase, 0, reserve, target, 'Attente d’une lecture d’énergie.');
    if (phase === 'draining' && available > reserve) return result(phase, available - reserve, reserve, null, null);
    const nextPhase = phase === 'draining' ? 'recharge' : phase;
    if (target <= reserve || (capacity !== null && target > capacity && available < target))
        return result(nextPhase, 0, reserve, target, `Seuil ${target} incompatible avec la capacité ou la réserve ${reserve}.`);
    if (available < target) return result(nextPhase, 0, reserve, target, `Attente de la salve à ${target} énergies (${available} disponibles).`);
    return result('draining', available - reserve, reserve, null, null);
}
