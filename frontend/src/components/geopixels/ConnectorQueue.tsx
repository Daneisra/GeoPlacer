import { Link } from 'react-router-dom';
import { formatTime, STRATEGY_LABELS } from '../../lib/engine';
import { translateReason } from '../../lib/i18n';
import type { BatchView } from './BatchPanel';

const labels: Record<string, string> = {
    idle: 'Aucun travail',
    prepared: 'Préparé',
    running: 'En cours',
    paused: 'En pause',
    stopped: 'Arrêté',
    completed: 'Envois terminés',
    blocked: 'Bloqué',
    interrupted: 'Interrompu',
    finished: 'Terminée',
    leased: 'Réservée',
    started: 'Envoyée',
    failed: 'Refusée',
    cancelled: 'Annulée',
    'needs-reconciliation': 'À réconcilier',
};

export function ConnectorQueue({
    batch,
    drawing,
    canReconcile,
    onReconcile,
}: {
    batch?: BatchView;
    drawing?: string;
    canReconcile: boolean;
    onReconcile: () => void;
}) {
    const history = batch?.history ?? [];
    const group = batch?.nextGroup;
    const waiting = batch?.scheduler?.startsWith('waiting-') ? translateReason(batch.schedulerReason ?? null) : null;
    const remaining = batch?.budgets ? Math.max(0, Math.min(batch.budgets.energy, batch.budgets.pixels) - (batch.spent ?? 0)) : null;
    return (
        <section className="studio-card space-y-5">
            <div className="studio-card-heading">
                <div>
                    <h2>Travail courant</h2>
                    <p>{drawing ?? (batch?.id ? 'Dernier travail enregistré' : 'Aucun dessin en cours')} · {batch ? (labels[batch.state] ?? batch.state) : 'État indisponible'}</p>
                    {batch?.scope?.strategy && <p>Mode {STRATEGY_LABELS[batch.scope.strategy]}</p>}
                </div>
                <Link className="studio-link" to="/">
                    Ouvrir les commandes
                </Link>
            </div>
            <dl className="studio-metrics">
                <div>
                    <dt>Cibles acquittées</dt>
                    <dd>{batch?.confirmed.toLocaleString('fr-FR') ?? '—'}</dd>
                </div>
                <div>
                    <dt>Requêtes acceptées</dt>
                    <dd>{batch?.acceptedRequests ?? '—'}</dd>
                </div>
                <div>
                    <dt>Tentatives incertaines</dt>
                    <dd>{batch?.uncertain ?? '—'}</dd>
                </div>
            </dl>
            {batch?.error && <p role="status">{batch.error}</p>}
            {waiting && <p role="status">{waiting}</p>}
            <section className="space-y-2" aria-label="Groupes de dessin">
                <h3>{group?.state === 'delivered' ? 'Groupe transmis au lecteur' : 'Prochain groupe'}</h3>
                {group ? <>
                    <p>{group.pixels.length.toLocaleString('fr-FR')} cibles · {group.state === 'delivered' ? 'Résultat attendu' : group.state === 'ready' ? 'Prêt à être pris par le lecteur' : 'Réservation en cours'}</p>
                    <details><summary>Coordonnées et couleurs</summary>
                        <ul>{group.pixels.map((pixel) => <li key={`${pixel.gridX},${pixel.gridY}`}>
                            ({pixel.gridX}, {pixel.gridY}) · #{pixel.color.toString(16).padStart(6, '0')}
                        </li>)}</ul>
                    </details>
                </> : <p>Le planificateur affichera ici le prochain groupe dès sa réservation.</p>}
                {batch?.state === 'running' && batch.adaptiveGroupSize !== undefined && remaining !== null && (
                    <p>Jusqu’à {Math.min(batch.adaptiveGroupSize, remaining).toLocaleString('fr-FR')} pixels par prochain groupe · budget restant {remaining.toLocaleString('fr-FR')}</p>
                )}
            </section>
            {!!batch?.uncertain && (
                <div className="space-y-2">
                    <p>Une observation datée et postérieure à l’envoi doit couvrir les cibles concernées.</p>
                    <button disabled={!canReconcile} onClick={onReconcile}>
                        Réconcilier par observation
                    </button>
                </div>
            )}
            <h3>Dernières tentatives</h3>
            {history.length ? (
                <div className="observation-table">
                    <table>
                        <thead>
                            <tr>
                                <th scope="col">Début</th>
                                <th scope="col">Cibles</th>
                                <th scope="col">État</th>
                            </tr>
                        </thead>
                        <tbody>
                            {[...history].reverse().map((row) => (
                                <tr key={row.attemptId}>
                                    <td>{formatTime(row.startedAt)}</td>
                                    <td>{row.pixels}</td>
                                    <td>{row.accepted ? 'Requête acceptée' : (labels[row.state] ?? row.state)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <p className="text-muted-foreground">Les tentatives du travail courant apparaîtront ici.</p>
            )}
        </section>
    );
}
