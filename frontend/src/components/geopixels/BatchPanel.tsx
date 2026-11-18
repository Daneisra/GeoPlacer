import { useState } from 'react';
import { engineHttp } from '../../lib/engine';

export type BatchView = {
    id: string | null;
    digest: string | null;
    state: string;
    mode: 'fake' | 'real' | null;
    execution?: 'sequential' | 'grouped' | 'session' | 'continuous' | 'autonomous';
    energyCost?: number;
    limits?: {maxGroupPixels:number;commandBytes:number};
    adaptiveGroupSize?:number;
    budgets?: { pixels: number; energy: number };
    scope?: { region: { x: number; y: number; width: number; height: number }; durationMs: number | null; groupSize?: number; upgrades?:{maxBudget:number;minimumReserve:number;priority:string[]} } | null;
    spent?: number;
    resources?: { available: number; capturedAt: number } | null;
    regionProgress?: { correct: number; incorrect: number; unknown: number; percent: number | null } | null;
    history?: {
        attemptId: string;
        state: string;
        pixels: number;
        startedAt: number | null;
        closedAt: number | null;
        accepted: boolean;
    }[];
    acceptedRequests?: number;
    targets: {
        x: number;
        y: number;
        color: number;
        state: string;
        confirmed: boolean;
        observation?: 'unknown' | 'pending' | 'correct' | 'different';
        observedColor?: number | null;
        capturedAt?: number | null;
        sourceAt?: number | null;
    }[];
    verification?: { correct: number; different: number; unknown: number; pending: number; sourceUnverified: boolean };
    confirmed: number;
    total: number;
    uncertain: number;
    expires: number | null;
    remainingMs?: number | null;
    scheduler: string | null;
    error: string | null;
};
const labels: Record<string, string> = {
    idle: 'Aucun lot',
    prepared: 'Préparé — aucun envoi',
    running: 'En cours',
    paused: 'En pause',
    interrupted: 'Interrompu — nouvelle autorisation nécessaire',
    blocked: 'Bloqué',
    completed: 'Envois terminés — résultat à observer',
    stopped: 'Arrêté',
    waiting: 'En attente',
    started: 'Résultat attendu',
    'needs-reconciliation': 'Incertain — aucun renvoi',
    failed: 'Non envoyé',
    cancelled: 'Annulé',
    finished: 'Réconcilié par observation',
};
export function BatchPanel({
    view,
    approvalKey,
    fake,
    ready,
    groupedReady,
    sessionReady,
    continuousReady,
    project,
    refresh,
}: {
    view: BatchView;
    approvalKey: string;
    fake: boolean;
    ready: boolean;
    groupedReady: boolean;
    sessionReady: boolean;
    continuousReady: boolean;
    project: { width: number; height: number; gridX: number; gridY: number } | null;
    refresh: () => Promise<void>;
}) {
    const [limit, setLimit] = useState(25);
    const [energyBudget, setEnergyBudget] = useState(25);
    const [execution, setExecution] = useState<'grouped' | 'sequential' | 'session' | 'continuous'>('session');
    const [region, setRegion] = useState({ x: 0, y: 0, width: project?.width ?? 1, height: project?.height ?? 1 });
    const [duration, setDuration] = useState(120);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const active = ['running', 'paused'].includes(view.state);
    const locked = ['prepared', 'running', 'paused', 'interrupted', 'blocked'].includes(view.state);
    const selectedExecution = locked ? (view.execution ?? 'sequential') : execution;
    const continuous = selectedExecution === 'continuous';
    const scoped = view.scope?.region ?? region;
    const invalidScope =
        !project ||
        !Object.values(region).every(Number.isInteger) ||
        region.x < 0 ||
        region.y < 0 ||
        region.width < 1 ||
        region.height < 1 ||
        region.x + region.width > project.width ||
        region.y + region.height > project.height;
    const enabled = ready && !!approvalKey && !busy;
    async function command(path: string, body: object) {
        setBusy(true);
        setError('');
        try {
            await engineHttp.post('/connector/batch/' + path, body, {
                headers: { 'X-GeoPlacer-Approval': approvalKey },
            });
            await refresh();
        } catch {
            setError(
                'Commande refusée ou réponse absente. Vérifiez l’état du lot avant de poursuivre. Aucun renvoi automatique.'
            );
        } finally {
            setBusy(false);
        }
    }
    const approval = { batchId: view.id, digest: view.digest, approved: true };
    return (
        <fieldset className="rounded border border-amber-500 p-4 space-y-3" data-batch-state={view.state}>
            <legend>
                3. Dessiner un lot ou une session{' '}
                {view.mode === 'fake' || (view.mode === null && fake) ? '— fournisseur factice' : 'sur GeoPixels'}
            </legend>
            <p>
                <strong>
                    {view.mode === 'fake' ? 'Simulation · ' : ''}
                    {labels[view.state] ?? view.state}
                </strong>{' '}
                · {view.confirmed} / {view.total}{' '}
                {view.mode === 'fake'
                    ? 'cibles couvertes par des résultats factices'
                    : 'cibles couvertes par un accusé'}{' '}
                · {view.acceptedRequests ?? 0} requête(s) acceptée(s)
                {view.uncertain > 0 ? ` · ${view.uncertain} opération(s) incertaine(s)` : ''}.
            </p>
            {view.confirmed > 0 && (
                <p id="batchObservedResult" role="status">
                    Cache après envoi : {view.verification?.correct ?? 0} conforme(s) ·{' '}
                    {view.verification?.different ?? 0} différent(s) ·{' '}
                    {(view.verification?.unknown ?? view.confirmed) + (view.verification?.pending ?? 0)} à observer de
                    nouveau.{' '}
                    {view.verification?.sourceUnverified
                        ? 'Fraîcheur source non vérifiée.'
                        : 'Ces observations restent distinctes des accusés.'}
                    {(view.verification?.different ?? 0) > 0 &&
                        ' Un accusé ne prouve pas la couleur finale. Aucun renvoi automatique.'}
                </p>
            )}
            {!ready && <p>Connectez le lecteur 0.8.0, observez puis liez le modèle dans les étapes 1 et 2.</p>}
            {!approvalKey && <p>Saisissez la clé locale dans les réglages de connexion.</p>}
            <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1">
                    Mode d’envoi{' '}
                    <select
                        aria-label="Mode d’envoi"
                        value={selectedExecution}
                        disabled={locked || busy}
                        onChange={(e) => {
                            const value = e.target.value as 'grouped' | 'sequential' | 'session' | 'continuous';
                            setExecution(value);
                            setLimit(value === 'continuous' ? 100 : value === 'session' ? 25 : 5);
                            setEnergyBudget(value === 'continuous' ? 100 : 25);
                            if (project) setRegion({ x: 0, y: 0, width: project.width, height: project.height });
                        }}
                    >
                        <option value="continuous">Dessin continu — zone et budgets autorisés</option>
                        <option value="session">Session supervisée — 25 pixels maximum</option>
                        <option value="grouped">Groupé natif — une requête</option>
                        <option value="sequential">Séquentiel — solution de repli</option>
                    </select>
                </label>
                {selectedExecution === 'grouped' && !groupedReady && (
                    <p>Installer et coupler le lecteur 0.7.0 pour le mode groupé.</p>
                )}
                {selectedExecution === 'session' && !sessionReady && (
                    <p>Installer et coupler le lecteur 0.8.0 pour une session supervisée.</p>
                )}
                <label className="flex flex-col gap-1">
                    Nombre maximal de pixels{' '}
                    <input
                        aria-label="Nombre maximal de pixels"
                        type="number"
                        min={1}
                        max={continuous ? 1000 : selectedExecution === 'session' ? 25 : 5}
                        value={locked ? (view.budgets?.pixels ?? view.total) : limit}
                        disabled={locked || busy}
                        onChange={(e) => setLimit(Number(e.target.value))}
                    />
                </label>{' '}
                {['session', 'continuous'].includes(selectedExecution) && (
                    <label className="flex flex-col gap-1">
                        Budget maximal d’énergie{' '}
                        <input
                            aria-label="Budget maximal d’énergie"
                            type="number"
                            min={1}
                            max={continuous ? 1000 : 25}
                            value={locked ? (view.budgets?.energy ?? view.energyCost) : energyBudget}
                            disabled={locked || busy}
                            onChange={(e) => setEnergyBudget(Number(e.target.value))}
                        />
                    </label>
                )}
                {continuous && (
                    <>
                        {(['x', 'y', 'width', 'height'] as const).map((k) => (
                            <label className="flex flex-col gap-1" key={k}>
                                {
                                    {
                                        x: 'Zone X (image)',
                                        y: 'Zone Y (image)',
                                        width: 'Largeur de zone',
                                        height: 'Hauteur de zone',
                                    }[k]
                                }
                                <input
                                    aria-label={
                                        {
                                            x: 'Zone X',
                                            y: 'Zone Y',
                                            width: 'Largeur de zone',
                                            height: 'Hauteur de zone',
                                        }[k]
                                    }
                                    type="number"
                                    min={k === 'x' || k === 'y' ? 0 : 1}
                                    value={locked ? scoped[k] : region[k]}
                                    disabled={locked || busy}
                                    onChange={(e) => setRegion({ ...region, [k]: Number(e.target.value) })}
                                />
                            </label>
                        ))}
                        <label className="flex flex-col gap-1">
                            Durée maximale (secondes)
                            <input
                                aria-label="Durée maximale"
                                type="number"
                                min={30}
                                max={600}
                                value={locked ? (view.scope?.durationMs ?? 120000) / 1000 : duration}
                                disabled={locked || busy}
                                onChange={(e) => setDuration(Number(e.target.value))}
                            />
                        </label>
                        {!continuousReady && <p>Installer et coupler le lecteur 0.9.0.</p>}
                    </>
                )}
                <button
                    disabled={
                        !enabled ||
                        (execution === 'grouped' && !groupedReady) ||
                        (execution === 'continuous' &&
                            (!continuousReady ||
                                invalidScope ||
                                !Number.isInteger(duration) ||
                                duration < 30 ||
                                duration > 600 ||
                                !Number.isInteger(energyBudget) ||
                                energyBudget < 1 ||
                                energyBudget > 1000)) ||
                        (execution === 'session' &&
                            (!sessionReady ||
                                !Number.isInteger(energyBudget) ||
                                energyBudget < 1 ||
                                energyBudget > 25)) ||
                        active ||
                        view.uncertain > 0 ||
                        !Number.isInteger(limit) ||
                        limit < 1 ||
                        limit > (execution === 'continuous' ? 1000 : execution === 'session' ? 25 : 5) ||
                        ['prepared', 'interrupted', 'blocked'].includes(view.state)
                    }
                    onClick={() =>
                        void command('prepare', {
                            mode: fake ? 'fake' : 'real',
                            limit,
                            execution,
                            ...(['session', 'continuous'].includes(execution) ? { energyBudget } : {}),
                            ...(execution === 'continuous' ? { scope: { region, durationMs: duration * 1000 } } : {}),
                        })
                    }
                >
                    {['session', 'continuous'].includes(execution) ? 'Prévisualiser la session' : 'Préparer le lot'}
                </button>
            </div>
            {view.execution === 'continuous' && view.scope && project && (
                <div className="rounded border p-3 space-y-2" aria-label="Autorisation continue">
                    <p>
                        Modèle lié · couche de base · zone image ({scoped.x}, {scoped.y}) · {scoped.width} ×{' '}
                        {scoped.height}.
                    </p>
                    <p>
                        Rectangle natif : ({project.gridX + scoped.x}, {project.gridY - scoped.y}) à (
                        {project.gridX + scoped.x + scoped.width - 1}, {project.gridY - scoped.y - scoped.height + 1}).
                    </p>
                    <p>
                        Autorisation : {view.scope.durationMs === null ? 'jusqu’à l’arrêt ou la fin' : `${view.scope.durationMs / 1000} s maximum`} · {view.budgets?.pixels} pixels
                        distincts · {view.budgets?.energy} énergie maximum. Groupes de cinq maximum, choisis
                        dynamiquement dans cette zone.
                    </p>
                    <p>
                        Quota consommé ou réservé : {view.spent ?? 0}. Énergie exploitable :{' '}
                        {view.resources
                            ? `${view.resources.available} (réponse native reçue à ${new Date(view.resources.capturedAt).toLocaleTimeString('fr-FR')})`
                            : 'indisponible ou expirée — attente d’une nouvelle réponse native'}
                        . Aucune recharge estimée.
                    </p>
                    <p>
                        État :{' '}
                        {view.scheduler === 'waiting-resources'
                            ? 'Attente de ressources observables'
                            : view.scheduler === 'waiting-observation'
                              ? 'Attente de pixels incorrects connus'
                              : (labels[view.state] ?? view.state)}
                        .
                    </p>
                    <p>
                        Zone observée :{' '}
                        {view.regionProgress
                            ? `${view.regionProgress.correct} corrects · ${view.regionProgress.incorrect} incorrects · ${view.regionProgress.unknown} inconnus · ${view.regionProgress.percent == null ? 'progression indéterminée' : view.regionProgress.percent.toFixed(1) + ' %'}`
                            : 'indisponible'}
                        . Fraîcheur du cache non vérifiée ; un accusé reste distinct de cette mesure.
                    </p>
                </div>
            )}
            {(view.targets.length > 0 || view.scope) && (
                <>
                    <p>
                        Vérifiez les destinations exactes : couche de base ·{' '}
                        {view.mode === 'fake'
                            ? 'simulation, aucun envoi au site'
                            : view.execution === 'continuous'
                              ? 'cibles dynamiques dans la zone autorisée ; les lignes ci-dessous sont les opérations déjà réservées'
                              : ['session', 'continuous'].includes(view.execution ?? '')
                                ? 'groupes automatiques de cinq maximum, limités aux destinations ci-dessous'
                                : view.execution === 'grouped'
                                  ? 'une requête groupée pour toutes les lignes'
                                  : 'un envoi réel par ligne'}
                        . Coût maximal : {view.energyCost ?? view.total} énergie (1 par pixel).
                    </p>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left" aria-label="Pixels du lot">
                            <thead>
                                <tr>
                                    <th>X</th>
                                    <th>Y</th>
                                    <th>Couleur</th>
                                    <th>Envoi</th>
                                    <th>Observation du cache</th>
                                </tr>
                            </thead>
                            <tbody>
                                {view.targets.map((t) => (
                                    <tr key={`${t.x},${t.y}`}>
                                        <td>{t.x}</td>
                                        <td>{t.y}</td>
                                        <td>#{t.color.toString(16).padStart(6, '0')}</td>
                                        <td>
                                            {t.confirmed
                                                ? view.mode === 'fake'
                                                    ? 'Simulation confirmée'
                                                    : 'Accusé reçu'
                                                : (labels[t.state] ?? t.state)}
                                        </td>
                                        <td>
                                            {t.observation === 'correct'
                                                ? 'Couleur conforme'
                                                : t.observation === 'different'
                                                  ? 'Couleur différente'
                                                  : t.observation === 'pending'
                                                    ? 'À réobserver après envoi'
                                                    : 'Inconnue ou expirée'}
                                            {t.observedColor != null && (
                                                <>
                                                    {' '}
                                                    ·{' '}
                                                    {t.observedColor === -1
                                                        ? 'transparent'
                                                        : '#' + t.observedColor.toString(16).padStart(6, '0')}
                                                </>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {['prepared', 'interrupted', 'blocked'].includes(view.state) && view.uncertain === 0 && (
                        <button
                            disabled={
                                !enabled ||
                                (view.execution === 'grouped' && !groupedReady) ||
                                (view.execution === 'session' && !sessionReady) ||
                                (view.execution === 'continuous' && !continuousReady)
                            }
                            onClick={() => void command('approve', approval)}
                        >
                            {view.state === 'prepared'
                                ? ['session', 'continuous'].includes(view.execution ?? '')
                                    ? 'Autoriser et démarrer la session'
                                    : 'Autoriser et démarrer le lot'
                                : 'Autoriser les pixels restants'}
                        </button>
                    )}
                    {view.state === 'running' && (
                        <button disabled={!enabled} onClick={() => void command('pause', {})}>
                            {['session', 'continuous'].includes(view.execution ?? '')
                                ? 'Mettre la session en pause'
                                : 'Mettre le lot en pause'}
                        </button>
                    )}
                    {view.state === 'paused' && (
                        <button
                            disabled={
                                !enabled ||
                                (view.execution === 'grouped' && !groupedReady) ||
                                view.scheduler !== 'paused' ||
                                view.uncertain > 0 ||
                                (view.execution === 'session' && !sessionReady) ||
                                (view.execution === 'continuous' && !continuousReady)
                            }
                            onClick={() => void command('resume', approval)}
                        >
                            {['session', 'continuous'].includes(view.execution ?? '')
                                ? 'Reprendre la session autorisée'
                                : 'Reprendre le lot autorisé'}
                        </button>
                    )}
                    <button disabled={!approvalKey} onClick={() => void command('stop', {})}>
                        {['session', 'continuous'].includes(view.execution ?? '')
                            ? 'Arrêter la session immédiatement'
                            : 'Arrêter le lot immédiatement'}
                    </button>
                    {view.uncertain > 0 && (
                        <button disabled={!enabled} onClick={() => void command('reconcile', {})}>
                            Réconcilier depuis une source datée vérifiable
                        </button>
                    )}
                    {view.expires && (
                        <p>
                            Autorisation de dessin : {Math.ceil((view.remainingMs ?? 0) / 1000)} s
                            restantes, jusqu’à {new Date(view.expires).toLocaleTimeString('fr-FR')} ; aucun
                            renouvellement automatique.
                        </p>
                    )}
                </>
            )}
            <p>
                Les envois s’enchaînent après une seule autorisation. La progression observée reste mesurée séparément
                ci-dessous.
            </p>
            {!!view.history?.length && (
                <details>
                    <summary>Historique des groupes ({view.history.length} opérations)</summary>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left" aria-label="Historique des groupes">
                            <thead>
                                <tr>
                                    <th>Début</th>
                                    <th>Pixels</th>
                                    <th>Résultat de la requête</th>
                                </tr>
                            </thead>
                            <tbody>
                                {view.history.map((h) => (
                                    <tr key={h.attemptId}>
                                        <td>
                                            {h.startedAt
                                                ? new Date(h.startedAt).toLocaleTimeString('fr-FR')
                                                : 'Non démarrée'}
                                        </td>
                                        <td>{h.pixels}</td>
                                        <td>{h.accepted ? 'Acceptée' : (labels[h.state] ?? h.state)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </details>
            )}
            <details>
                <summary>Sécurité et interruptions</summary>
                <p>
                    Le dessin continu autorise une zone, 30 à 600 secondes et jusqu’à 1 000 pixels/énergie. Une session
                    fixe reste limitée à 25. Chaque groupe contient cinq pixels maximum. En séquentiel : une seconde
                    minimum entre envois. Aucun achat. Le navigateur vérifie l’énergie et les couleurs du compte avant
                    chaque envoi.
                </p>
                <p>
                    Arrêter révoque le lot ; un envoi déjà parti ne peut pas être annulé. Un résultat incertain bloque
                    la suite et ne sera jamais renvoyé automatiquement. Au redémarrage, une nouvelle autorisation est
                    requise.
                </p>
                <p>
                    Un cache relu peut être ancien. Les confirmations évitent de choisir deux fois une cible déjà
                    envoyée ; elles ne prouvent pas l’état actuel de la toile.
                </p>
            </details>
            {(error || view.error) && <p role="status">{error || view.error}</p>}
        </fieldset>
    );
}
