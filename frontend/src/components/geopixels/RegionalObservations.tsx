import { useState } from 'react';

export type ObservationRegion = {
    id: string;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    priority: 'primary' | 'secondary';
    enabled: boolean;
};
export type RegionView = ObservationRegion & {
    progress: { total: number; correct: number; incorrect: number; unknown: number };
    captureRange: { oldest: number; newest: number } | null;
    sourceRange: { oldest: number; newest: number } | null;
    lastOwnCapture: number | null;
    ownCaptureExpired: boolean;
};
const n = (v: number) => v.toLocaleString('fr-FR');
const time = (v: number | null) => (v === null ? 'Aucune' : new Date(v).toLocaleTimeString('fr-FR'));

export function RegionalObservations({
    regions,
    views,
    history,
    activeId,
    editable,
    busy,
    width,
    height,
    saved,
    onSave,
    onRestore,
    onObserve,
}: {
    regions: ObservationRegion[];
    views: RegionView[];
    activeId: string | null;
    history: { regionId?: string; durationMs: number }[];
    editable: boolean;
    busy: boolean;
    width: number;
    height: number;
    saved: { available: boolean; matching: boolean; count: number };
    onSave: (regions: ObservationRegion[]) => void;
    onRestore: () => void;
    onObserve: (id: string) => void;
}) {
    const [draft, setDraft] = useState<ObservationRegion[]>(regions);
    const update = (index: number, patch: Partial<ObservationRegion>) =>
        setDraft((values) => values.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    return (
        <section className="observation-supervision" aria-labelledby="regionalTitle">
            <h3 id="regionalTitle">Régions d’observation</h3>
            <p>
                Rectangles dans l’image : X vers la droite, Y vers le bas, origine (0, 0) au coin supérieur gauche. Un
                seul modèle ; les chevauchements ne doublent pas la progression globale.
            </p>
            <p>
                Sans région personnalisée, le lecteur observe le modèle entier. Mettre en pause et attendre la fin ou
                l’interruption de la capture pour modifier les régions.
            </p>
            <div className="observation-table">
                <table>
                    <thead>
                        <tr>
                            <th>Nom</th>
                            <th>X</th>
                            <th>Y</th>
                            <th>Largeur</th>
                            <th>Hauteur</th>
                            <th>Priorité</th>
                            <th>Active</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {draft.map((r, i) => (
                            <tr key={r.id}>
                                <td>
                                    <input
                                        aria-label={`Nom région ${i + 1}`}
                                        maxLength={60}
                                        value={r.name}
                                        disabled={!editable || busy}
                                        onChange={(e) => update(i, { name: e.target.value })}
                                    />
                                </td>
                                {(['x', 'y', 'width', 'height'] as const).map((key) => (
                                    <td key={key}>
                                        <input
                                            style={{ width: '6rem' }}
                                            aria-label={`${key} région ${i + 1}`}
                                            type="number"
                                            min={key === 'x' || key === 'y' ? 0 : 1}
                                            max={key === 'x' || key === 'width' ? width : height}
                                            disabled={!editable || busy}
                                            value={r[key]}
                                            onChange={(e) => update(i, { [key]: Number(e.target.value) })}
                                        />
                                    </td>
                                ))}
                                <td>
                                    <select
                                        aria-label={`Priorité région ${i + 1}`}
                                        value={r.priority}
                                        disabled={!editable || busy}
                                        onChange={(e) =>
                                            update(i, { priority: e.target.value as ObservationRegion['priority'] })
                                        }
                                    >
                                        <option value="primary">Principale</option>
                                        <option value="secondary">Secondaire</option>
                                    </select>
                                </td>
                                <td>
                                    <input
                                        aria-label={`Activer région ${i + 1}`}
                                        type="checkbox"
                                        checked={r.enabled}
                                        disabled={!editable || busy}
                                        onChange={(e) => update(i, { enabled: e.target.checked })}
                                    />
                                </td>
                                <td>
                                    <button
                                        disabled={!editable || busy}
                                        onClick={() => setDraft((values) => values.filter((v) => v.id !== r.id))}
                                    >
                                        Retirer de la configuration
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="observation-controls">
                <button
                    disabled={!editable || busy || draft.length >= 16}
                    onClick={() =>
                        setDraft((values) => [
                            ...values,
                            {
                                id: `region-${crypto.randomUUID().slice(0, 8)}`,
                                name: `Région ${values.length + 1}`,
                                x: 0,
                                y: 0,
                                width: Math.min(width, 64),
                                height: Math.min(height, 64),
                                priority: 'secondary',
                                enabled: true,
                            },
                        ])
                    }
                >
                    Ajouter une région
                </button>
                <button disabled={!editable || busy} onClick={() => onSave(draft)}>
                    Enregistrer les régions
                </button>
                <button disabled={!editable || busy} onClick={() => onSave([])}>
                    Observer le modèle entier
                </button>
                <button disabled={!editable || busy || !saved.matching} onClick={onRestore}>
                    Restaurer les régions sauvegardées ({saved.count})
                </button>
            </div>
            {saved.available && !saved.matching && (
                <p>Configuration sauvegardée pour une autre identité ou position : restauration refusée.</p>
            )}
            <p>
                Équité : trois captures principales pour une secondaire à coût égal. Une capture interrompue n’avance
                pas cette rotation. Les régions désactivées sont suspendues.
            </p>
            <ul>
                {views.map((r) => {
                    const captures = history.filter((p) => p.regionId === r.id);
                    const average = captures.length
                        ? captures.reduce((sum, p) => sum + p.durationMs, 0) / captures.length
                        : null;
                    return (
                        <li key={r.id} data-region-id={r.id}>
                            <strong>{r.name}</strong> — {r.x}, {r.y} · {r.width} × {r.height} ·{' '}
                            {r.priority === 'primary' ? 'principale' : 'secondaire'} ·{' '}
                            {!r.enabled
                                ? 'Suspendue'
                                : activeId === r.id
                                  ? 'Capture en cours'
                                  : r.ownCaptureExpired
                                    ? 'Capture propre expirée'
                                    : 'En attente'}
                            .
                            <p>
                                Dernière capture propre : {time(r.lastOwnCapture)}. Couverture actuelle des cibles :{' '}
                                {n(r.progress.correct + r.progress.incorrect)} / {n(r.progress.total)}. Corrects :{' '}
                                {n(r.progress.correct)} ; incorrects : {n(r.progress.incorrect)} ; inconnus :{' '}
                                {n(r.progress.unknown)}.
                            </p>
                            <p>
                                Fenêtre des captures valides : {r.captureRange ? `${time(r.captureRange.oldest)} à ${time(r.captureRange.newest)}` : 'aucune'}.
                                Source : {r.sourceRange ? `${time(r.sourceRange.oldest)} à ${time(r.sourceRange.newest)}` : 'non datée ou inconnue'}.
                                Réception moyenne des bandes :{' '}
                                {average === null ? 'indisponible' : `${n(Math.round(average))} ms`}. Ces durées
                                excluent le décodage précédant la première bande. Les pixels peuvent provenir de
                                captures différentes, y compris de régions voisines. Source non datée sauf indication
                                explicite.
                            </p>
                            <button disabled={!editable || busy || !r.enabled} onClick={() => onObserve(r.id)}>
                                Observer cette région
                            </button>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
