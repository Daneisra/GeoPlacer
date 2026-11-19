import { Link } from 'react-router-dom';
import { formatTime } from '../../lib/engine';
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
    canReconcile,
    onReconcile,
}: {
    batch?: BatchView;
    canReconcile: boolean;
    onReconcile: () => void;
}) {
    const history = batch?.history ?? [];
    return (
        <section className="studio-card space-y-5">
            <div className="studio-card-heading">
                <div>
                    <h2>Travail courant</h2>
                    <p>{batch ? (labels[batch.state] ?? batch.state) : 'État indisponible'}</p>
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
