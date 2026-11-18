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
    blockedReason,
}: {
    view: SinglePixelView;
    approvalKey: string;
    fake: boolean;
    ready: boolean;
    blockedReason: string | null;
    refresh: () => Promise<void>;
}) {
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
            <legend>3. Tester un pixel {fake ? '— simulation' : 'sur GeoPixels'}</legend>
            <p>
                État :{' '}
                <strong>
                    {view.mode === 'fake' ? 'Simulée · ' : ''}
                    {view.reconciled
                        ? 'Réconciliée par observation — attribution du placement inconnue'
                        : (labels[view.state] ?? view.state)}
                </strong>
                {view.armed && ' · Dans GeoPixels, cliquez maintenant sur « Placer le pixel préparé ».'}
            </p>
            <p>{blockedReason ?? 'Préparez le pixel, vérifiez sa destination, puis autorisez cet essai unique.'}</p>
            <button
                disabled={
                    busy || !ready || !approvalKey || ['leased', 'started', 'needs-reconciliation'].includes(view.state)
                }
                onClick={() => {
                    void command('prepare', { mode: fake ? 'fake' : 'real' });
                }}
            >
                Préparer un pixel
            </button>
            {destination && (
                <>
                    <p>
                        Destination native : couche de base · ({destination.gridX}, {destination.gridY}) · couleur #
                        {destination.color.toString(16).padStart(6, '0')}.
                    </p>
                    {view.state === 'leased' && (
                        <>
                            <button
                                disabled={busy || !ready || !approvalKey || view.armed}
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
                                {fake ? 'Exécuter sur le fournisseur factice' : 'Autoriser ce pixel'}
                            </button>
                        </>
                    )}
                </>
            )}
            <button disabled={!approvalKey} onClick={() => void command('stop', {})}>
                Arrêter l’essai
            </button>
            {view.state === 'needs-reconciliation' && (
                <button disabled={busy || !ready || !approvalKey} onClick={() => void command('reconcile', {})}>
                    Réconcilier depuis une source datée vérifiable
                </button>
            )}
            <details>
                <summary>Détails de sécurité et de reprise</summary>
                <p>
                    L’autorisation porte sur un seul pixel, à la destination affichée. La confirmation finale se fait
                    dans GeoPixels. Aucun achat.
                </p>
                <p>
                    Le cache peut être ancien. Un résultat incertain reste réservé, sans renvoi automatique. Arrêter
                    retire l’autorisation mais ne peut pas annuler un envoi déjà parti.
                </p>
                <p>
                    La réservation est une autorisation locale, pas une mesure de l’énergie du compte. La progression
                    reste calculée par le lecteur.
                </p>
            </details>
            {(error || (view.error && !['idle', 'cancelled'].includes(view.state))) && (
                <p role="status">{error || view.error}</p>
            )}
        </fieldset>
    );
}
