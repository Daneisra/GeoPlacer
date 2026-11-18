import { useState } from 'react';
import { engineHttp } from '../../lib/engine';

export type BatchView = {
    id: string | null;
    digest: string | null;
    state: string;
    mode: 'fake' | 'real' | null;
    execution?: 'sequential' | 'grouped';
    energyCost?: number;
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
    refresh,
}: {
    view: BatchView;
    approvalKey: string;
    fake: boolean;
    ready: boolean;
    groupedReady: boolean;
    refresh: () => Promise<void>;
}) {
    const [limit, setLimit] = useState(5);
    const [execution, setExecution] = useState<'grouped' | 'sequential'>('grouped');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const active = ['running', 'paused'].includes(view.state);
    const locked = ['prepared', 'running', 'paused', 'interrupted', 'blocked'].includes(view.state);
    const selectedExecution = locked ? (view.execution ?? 'sequential') : execution;
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
                3. Dessiner un petit lot{' '}
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
            {!ready && <p>Connectez le lecteur 0.7.0, observez puis liez le modèle dans les étapes 1 et 2.</p>}
            {!approvalKey && <p>Saisissez la clé locale dans les réglages de connexion.</p>}
            <label>
                Mode d’envoi{' '}
                <select
                    aria-label="Mode d’envoi"
                    value={selectedExecution}
                    disabled={locked || busy}
                    onChange={(e) => setExecution(e.target.value as 'grouped' | 'sequential')}
                >
                    <option value="grouped">Groupé natif — une requête</option>
                    <option value="sequential">Séquentiel — solution de repli</option>
                </select>
            </label>
            {selectedExecution === 'grouped' && !groupedReady && (
                <p>Installer et coupler le lecteur 0.7.0 pour le mode groupé.</p>
            )}
            <label>
                Nombre maximal de pixels{' '}
                <input
                    aria-label="Nombre maximal de pixels"
                    type="number"
                    min={1}
                    max={5}
                    value={limit}
                    disabled={locked || busy}
                    onChange={(e) => setLimit(Number(e.target.value))}
                />
            </label>{' '}
            <button
                disabled={
                    !enabled ||
                    (execution === 'grouped' && !groupedReady) ||
                    active ||
                    view.uncertain > 0 ||
                    !Number.isInteger(limit) ||
                    limit < 1 ||
                    limit > 5 ||
                    ['prepared', 'interrupted', 'blocked'].includes(view.state)
                }
                onClick={() => void command('prepare', { mode: fake ? 'fake' : 'real', limit, execution })}
            >
                Préparer le lot
            </button>
            {view.targets.length > 0 && (
                <>
                    <p>
                        Vérifiez les destinations exactes : couche de base ·{' '}
                        {view.mode === 'fake'
                            ? 'simulation, aucun envoi au site'
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
                            disabled={!enabled || (view.execution === 'grouped' && !groupedReady)}
                            onClick={() => void command('approve', approval)}
                        >
                            {view.state === 'prepared'
                                ? 'Autoriser et démarrer le lot'
                                : 'Autoriser les pixels restants'}
                        </button>
                    )}
                    {view.state === 'running' && (
                        <button disabled={!enabled} onClick={() => void command('pause', {})}>
                            Mettre le lot en pause
                        </button>
                    )}
                    {view.state === 'paused' && (
                        <button
                            disabled={
                                !enabled ||
                                (view.execution === 'grouped' && !groupedReady) ||
                                view.scheduler !== 'paused' ||
                                view.uncertain > 0
                            }
                            onClick={() => void command('resume', approval)}
                        >
                            Reprendre le lot autorisé
                        </button>
                    )}
                    <button disabled={!approvalKey} onClick={() => void command('stop', {})}>
                        Arrêter le lot immédiatement
                    </button>
                    {view.uncertain > 0 && (
                        <button disabled={!enabled} onClick={() => void command('reconcile', {})}>
                            Réconcilier depuis une source datée vérifiable
                        </button>
                    )}
                    {view.expires && (
                        <p>
                            Autorisation jusqu’à {new Date(view.expires).toLocaleTimeString('fr-FR')} ; aucun
                            renouvellement automatique.
                        </p>
                    )}
                </>
            )}
            <p>
                Les envois s’enchaînent après une seule autorisation. La progression observée reste mesurée séparément
                ci-dessous.
            </p>
            <details>
                <summary>Sécurité et interruptions</summary>
                <p>
                    Cinq pixels maximum. En séquentiel : une seconde minimum entre envois. Aucun achat. Le navigateur
                    vérifie l’énergie et les couleurs du compte avant chaque envoi.
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
