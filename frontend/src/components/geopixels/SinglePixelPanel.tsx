import { useState } from 'react';
import { engineHttp } from '../../lib/engine';

export type SinglePixelView = {
    mode: 'fake' | 'real' | null;
    state: string;
    armed: boolean;
    reconciled: boolean;
    destination: { attemptId: string; gridX: number; gridY: number; color: number; deadline: number } | null;
    error: string | null;
};
const labels: Record<string, string> = {
    idle: 'Aucune opération',
    leased: 'Préparée — réservation durable',
    started: 'Exécution commencée — résultat attendu',
    'needs-reconciliation': 'Incertaine — aucun renvoi autorisé',
    finished: 'Confirmée',
    failed: 'Non envoyée',
    cancelled: 'Annulée',
};
export function SinglePixelPanel({
    view,
    approvalKey,
    fake,
    ready,
    refresh,
}: {
    view: SinglePixelView;
    approvalKey: string;
    fake: boolean;
    ready: boolean;
    refresh: () => Promise<void>;
}) {
    const [approved, setApproved] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const destination = view.destination;
    const authorize = { headers: { 'X-GeoPlacer-Approval': approvalKey } };
    async function command(path: string, body: object) {
        setBusy(true);
        setError('');
        try {
            await engineHttp.post('/connector/pixel/' + path, body, authorize);
            await refresh();
        } catch {
            setError(
                'Commande refusée ou résultat absent. Relire l’état avant de poursuivre ; ne pas renvoyer le pixel.'
            );
        } finally {
            setBusy(false);
        }
    }
    return (
        <fieldset className="rounded border border-amber-500 p-4 space-y-2">
            <legend>Essai d’un pixel — {fake ? 'fournisseur factice' : 'écrivain GeoPixels expérimental'}</legend>
            <p>
                État :{' '}
                <strong>
                    {view.mode === 'fake' ? 'Simulée · ' : ''}
                    {view.reconciled
                        ? 'Réconciliée par observation — attribution du placement inconnue'
                        : (labels[view.state] ?? view.state)}
                </strong>
                {view.armed && ' · Autorisation ponctuelle donnée ; confirmation dans le navigateur encore nécessaire.'}
            </p>
            <p>
                Le candidat provient du cache, dont la fraîcheur source peut être inconnue. Le lecteur reste passif.
                Aucun achat. Un seul envoi volontaire ; aucun renvoi automatique.
            </p>
            <button
                disabled={
                    busy || !ready || !approvalKey || ['leased', 'started', 'needs-reconciliation'].includes(view.state)
                }
                onClick={() => {
                    setApproved('');
                    void command('prepare', { mode: fake ? 'fake' : 'real' });
                }}
            >
                Préparer un pixel avec le planificateur
            </button>
            {destination && (
                <>
                    <p>
                        Destination native : couche de base · ({destination.gridX}, {destination.gridY}) · couleur #
                        {destination.color.toString(16).padStart(6, '0')}.
                    </p>
                    <p>
                        Réservation locale : une autorisation d’exécution. Ce nombre n’est pas l’énergie du compte. Le
                        navigateur vérifiera sa session, son énergie et sa couleur avant l’envoi.
                    </p>
                    {view.state === 'leased' && (
                        <>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={approved === destination.attemptId}
                                    onChange={(e) => setApproved(e.target.checked ? destination.attemptId : '')}
                                />
                                {fake
                                    ? ' Je valide cette opération factice.'
                                    : ' J’autorise explicitement cet unique pixel réel à cette destination et dans cette couleur.'}
                            </label>
                            <button
                                disabled={busy || approved !== destination.attemptId || view.armed}
                                onClick={() =>
                                    void command('confirm', {
                                        ...Object.fromEntries(
                                            ['attemptId', 'gridX', 'gridY', 'color'].map((k) => [
                                                k,
                                                destination[k as keyof typeof destination],
                                            ])
                                        ),
                                        approved: true,
                                    })
                                }
                            >
                                {fake
                                    ? 'Exécuter sur le fournisseur factice'
                                    : 'Autoriser cet essai — confirmer ensuite dans Tampermonkey'}
                            </button>
                        </>
                    )}
                </>
            )}
            <button disabled={!approvalKey} onClick={() => void command('stop', {})}>
                Arrêt immédiat de l’essai
            </button>
            <p>
                L’arrêt retire l’autorisation ; un envoi déjà parti reste incertain et ne peut pas être annulé sur le
                service.
            </p>
            {view.state === 'needs-reconciliation' && (
                <button disabled={busy || !ready || !approvalKey} onClick={() => void command('reconcile', {})}>
                    Réconcilier depuis une source datée vérifiable
                </button>
            )}
            <p>
                Une réponse « Ok » confirme l’envoi ; la progression reste mesurée par le lecteur. Un cache sans date
                source ne lève pas une incertitude d’exécution.
            </p>
            {(error || view.error) && <p role="status">{error || view.error}</p>}
        </fieldset>
    );
}
