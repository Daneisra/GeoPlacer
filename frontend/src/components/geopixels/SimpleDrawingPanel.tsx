import { useEffect, useRef, useState } from 'react';
import { engineHttp, type TemplateInfo } from '../../lib/engine';
import { PERSONAL_GEOPIXELS_PALETTE, parsePaletteText } from '../../lib/ghost-palettes';
import type { BatchView } from './BatchPanel';
type DrawingView = {
    connected: boolean;
    bound: boolean;
    selection: TemplateInfo | null;
    project: { id: string; generation?: string; width: number; height: number; gridX: number; gridY: number } | null;
    batch: BatchView;
    monitoring: { inFlight: unknown };
    progress: { correct: number; incorrect: number; unknown: number; total: number } | null;
};
const errorMessage = (e: unknown) => {
    const v = e as { response?: { data?: { error?: { message?: string } } } };
    return (
        v.response?.data?.error?.message ??
        'Serveur indisponible : vérifier la connexion et l’état avant de poursuivre.'
    );
};
/** Default workflow. Authority is granted only by the explicit launch/resume buttons. */
export function SimpleDrawingPanel({
    view,
    approvalKey,
    refresh,
}: {
    view: DrawingView | null;
    approvalKey: string;
    refresh: () => Promise<void>;
}) {
    const [file, setFile] = useState<File | null>(null),
        [busy, setBusy] = useState(false),
        [error, setError] = useState('');
    const [groupSize, setGroupSize] = useState(5),
        [budget, setBudget] = useState(''),
        [palette, setPalette] = useState(PERSONAL_GEOPIXELS_PALETTE.join('\n'));
    const attempted = useRef('');
    const batch = view?.batch,
        selected = view?.selection,
        active = !!batch && ['running', 'paused'].includes(batch.state);
    const imageUrl = selected ? `/api/v1/connector/drawing/${selected.templateId}/image` : null;
    async function action(fn: () => Promise<unknown>) {
        setBusy(true);
        setError('');
        try {
            await fn();
            await refresh();
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    }
    async function importImage() {
        if (!file) return;
        const colors = parsePaletteText(palette);
        if (colors.invalid.length || !colors.colors.length) {
            setError('Palette invalide : codes #RRGGBB requis.');
            return;
        }
        await action(async () => {
            const data = await new Promise<string>((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(String(r.result).split(',')[1]!);
                r.onerror = reject;
                r.readAsDataURL(file);
            });
            await engineHttp.post(
                '/connector/drawing/import',
                { name: file.name.replace(/\.png$/i, ''), pngBase64: data, palette: colors.colors },
                { headers: { 'X-GeoPlacer-Approval': approvalKey } }
            );
            attempted.current = '';
        });
    }
    const previewIdentity =
        selected && view?.project
            ? JSON.stringify([selected.templateId, view.project, groupSize, budget, approvalKey])
            : '';
    const viewConnected = !!view?.connected;
    const canPreview = !!approvalKey && !!view?.connected && !active && !busy && !batch?.uncertain;
    useEffect(() => {
        if (!previewIdentity || !viewConnected) {
            attempted.current = '';
            return;
        }
        if (!canPreview || attempted.current === previewIdentity) return;
        attempted.current = previewIdentity;
        void engineHttp
            .post(
                '/connector/drawing/preview',
                { groupSize, ...(budget ? { pixelBudget: Number(budget) } : {}) },
                { headers: { 'X-GeoPlacer-Approval': approvalKey } }
            )
            .then(() => {
                if (attempted.current === previewIdentity) {
                    setError('');
                    void refresh();
                }
            })
            .catch((e) => {
                if (attempted.current === previewIdentity) setError(errorMessage(e));
            });
    }, [approvalKey, previewIdentity, canPreview, groupSize, budget, refresh, viewConnected]);
    const consent = { batchId: batch?.id, digest: batch?.digest, approved: true };
    return (
        <div className="space-y-4" id="simpleDrawing">
            <div className="rounded border p-4 space-y-3">
                <h3 className="text-lg font-semibold">1. Importer votre image</h3>
                <p>
                    Le PNG préparé est le modèle qui sera dessiné. Chargez ce même fichier comme fantôme dans GeoPixels.
                </p>
                <input
                    aria-label="Image à dessiner"
                    type="file"
                    accept="image/png"
                    disabled={active || busy}
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                <button disabled={!file || active || busy} onClick={() => void importImage()}>
                    Importer l’image
                </button>
                {selected && imageUrl && (
                    <div className="flex flex-wrap items-center gap-4">
                        <img
                            src={imageUrl}
                            alt={`Modèle préparé : ${selected.name}`}
                            className="max-h-48 max-w-full object-contain bg-slate-700 [image-rendering:pixelated]"
                            style={{ width: Math.min(320, selected.width * 8) }}
                        />
                        <div>
                            <p>
                                {selected.name} · {selected.width} × {selected.height}
                            </p>
                            <a href={imageUrl} download>
                                Télécharger le fantôme pour GeoPixels
                            </a>
                        </div>
                    </div>
                )}
            </div>
            <div className="rounded border border-amber-500 p-4 space-y-3">
                <h3 className="text-lg font-semibold">2. Vérifier et lancer le dessin</h3>
                {!view?.connected ? (
                    <p>
                        Chargez le fantôme sur GeoPixels, puis effectuez le couplage ci-dessous. Le lecteur observe
                        automatiquement le modèle.
                    </p>
                ) : !view.bound || batch?.execution !== 'autonomous' ? (
                    <p>
                        Vérification du fantôme : image, couleurs, dimensions et position doivent correspondre au PNG
                        préparé.
                    </p>
                ) : (
                    <>
                        <p>
                            Fantôme correspondant vérifié · couche de base · image entière {view.project?.width} ×{' '}
                            {view.project?.height}.
                        </p>
                        <p>
                            Destination native : ({view.project?.gridX}, {view.project?.gridY}) à (
                            {view.project ? view.project.gridX + view.project.width - 1 : '?'},{' '}
                            {view.project ? view.project.gridY - view.project.height + 1 : '?'}).
                        </p>
                        <p>
                            Au maximum {batch.budgets?.pixels} pixels distincts et {batch.budgets?.energy} énergie pour
                            ce travail, par groupes de {groupSize} maximum. Autorisation jusqu’à la fin, l’arrêt ou la
                            révocation ; le transport seul peut être renouvelé automatiquement.
                        </p>
                    </>
                )}
                <p>
                    Vérifiez l’image et sa destination avant de lancer : les envois suivants seront automatiques dans ce
                    périmètre.
                </p>
                <div className="flex flex-wrap gap-3">
                    <button
                        className="font-semibold"
                        disabled={
                            busy ||
                            !approvalKey ||
                            !!view?.monitoring.inFlight ||
                            !view?.bound ||
                            batch?.execution !== 'autonomous' ||
                            !['prepared', 'interrupted', 'blocked'].includes(batch.state) ||
                            batch.uncertain > 0
                        }
                        onClick={() =>
                            void action(() =>
                                engineHttp.post('/connector/batch/approve', consent, {
                                    headers: { 'X-GeoPlacer-Approval': approvalKey },
                                })
                            )
                        }
                    >
                        Lancer le dessin
                    </button>
                    {batch?.state === 'running' && (
                        <button
                            disabled={busy}
                            onClick={() =>
                                void action(() =>
                                    engineHttp.post(
                                        '/connector/batch/pause',
                                        {},
                                        { headers: { 'X-GeoPlacer-Approval': approvalKey } }
                                    )
                                )
                            }
                        >
                            Mettre le dessin en pause
                        </button>
                    )}
                    {batch?.state === 'paused' && (
                        <button
                            disabled={busy || batch.scheduler !== 'paused' || !view?.connected}
                            onClick={() =>
                                void action(() =>
                                    engineHttp.post('/connector/batch/resume', consent, {
                                        headers: { 'X-GeoPlacer-Approval': approvalKey },
                                    })
                                )
                            }
                        >
                            Reprendre le dessin
                        </button>
                    )}
                    {view?.connected && batch?.uncertain === 0 && ['stopped', 'completed'].includes(batch.state) && (
                        <button
                            disabled={busy}
                            onClick={() =>
                                void action(() =>
                                    engineHttp.post(
                                        '/connector/drawing/preview',
                                        { groupSize, ...(budget ? { pixelBudget: Number(budget) } : {}) },
                                        { headers: { 'X-GeoPlacer-Approval': approvalKey } }
                                    )
                                )
                            }
                        >
                            Préparer la suite
                        </button>
                    )}
                    {batch && batch.state !== 'idle' && (
                        <button
                            disabled={!approvalKey || busy}
                            onClick={() =>
                                void action(() =>
                                    engineHttp.post(
                                        '/connector/batch/stop',
                                        {},
                                        { headers: { 'X-GeoPlacer-Approval': approvalKey } }
                                    )
                                )
                            }
                        >
                            Arrêter le dessin
                        </button>
                    )}
                </div>
                {batch && (
                    <div role="status">
                        <p>
                            {batch.state === 'completed'
                                ? 'Envois terminés — vérifier les observations'
                                : batch.state === 'paused'
                                  ? 'Dessin en pause'
                                  : batch.state === 'running'
                                    ? batch.scheduler === 'waiting-resources'
                                        ? 'Attente d’énergie observée ou de couleurs disponibles'
                                        : batch.scheduler === 'waiting-observation'
                                          ? 'Attente de pixels connus dans les régions chargées'
                                          : 'Dessin en cours'
                                    : batch.state === 'prepared'
                                      ? 'Prêt — aucun envoi autorisé'
                                      : batch.state === 'stopped'
                                        ? 'Dessin arrêté'
                                        : batch.state === 'interrupted'
                                          ? 'Travail interrompu — nouvel accord requis'
                                          : 'Aucun dessin lancé'}
                        </p>
                        <p>
                            {batch.confirmed} cibles acquittées · {batch.acceptedRequests ?? 0} requêtes acceptées ·{' '}
                            {batch.uncertain} tentative(s) incertaine(s).
                        </p>
                        <p>
                            Énergie exploitable :{' '}
                            {batch.resources?.available ?? 'indisponible — attente d’une nouvelle réponse native'}.
                            Aucune recharge estimée.
                        </p>
                        {view?.progress && (
                            <p>
                                Cache observé : {view.progress.correct} corrects · {view.progress.incorrect} incorrects
                                · {view.progress.unknown} inconnus. La réception récente ne prouve pas la fraîcheur
                                serveur des tuiles.
                            </p>
                        )}
                        {batch.error && <p>{batch.error}</p>}
                    </div>
                )}
                {error && <p role="alert">{error}</p>}
            </div>
            <details>
                <summary>Options du dessin</summary>
                <div className="grid gap-3 p-3 md:grid-cols-2">
                    <label>
                        Pixels par requête (1 à 5, capacité validée)
                        <input
                            aria-label="Pixels par requête"
                            type="number"
                            min={1}
                            max={5}
                            value={groupSize}
                            disabled={active || busy}
                            onChange={(e) => setGroupSize(Number(e.target.value))}
                        />
                    </label>
                    <label>
                        Budget de pixels (vide : image entière)
                        <input
                            aria-label="Budget du dessin"
                            type="number"
                            min={1}
                            value={budget}
                            disabled={active || busy}
                            onChange={(e) => setBudget(e.target.value)}
                        />
                    </label>
                    <label className="md:col-span-2">
                        Palette locale (#RRGGBB)
                        <textarea
                            aria-label="Palette du dessin"
                            value={palette}
                            disabled={active || busy}
                            onChange={(e) => setPalette(e.target.value)}
                        />
                    </label>
                </div>
            </details>
        </div>
    );
}
