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
    tileEvidence?:{total:number;nativeUpdated:number;nativeChecked:number;missing:number;sourceDateKnown:boolean};
    upgrades?:{error?:string|null;uncertain:number;history:{id:string;kind:string;cost:number;state:string;at:number}[]};
    progress: { correct: number; incorrect: number; unknown: number; total: number } | null;
};
const errorMessage = (e: unknown) => {
    const v = e as { response?: { status?: number; data?: { error?: { message?: string } } } };
    if (v.response?.status === 413) return 'Image trop volumineuse pour le serveur.';
    if (v.response?.status === 404)
        return 'Le serveur doit être redémarré pour activer l’import. Redémarrer GeoPlacer puis réessayer.';
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
    readerReady=true,
}: {
    view: DrawingView | null;
    approvalKey: string;
    refresh: () => Promise<void>;
    readerReady?:boolean;
}) {
    const [file, setFile] = useState<File | null>(null),
        [busy, setBusy] = useState(false),
        [error, setError] = useState('');
    const [groupSize, setGroupSize] = useState(0),
        [budget, setBudget] = useState(''),
        [palette, setPalette] = useState(PERSONAL_GEOPIXELS_PALETTE.join('\n'));
    const [importNotice, setImportNotice] = useState<{ kind: 'loading' | 'success' | 'error'; text: string } | null>(
        null
    );
    const [autoUpgrades,setAutoUpgrades]=useState(false),[coinBudget,setCoinBudget]=useState(0),[coinReserve,setCoinReserve]=useState(50),[targetCapacity,setTargetCapacity]=useState(300),[energyBelow,setEnergyBelow]=useState(5),[upgradeKinds,setUpgradeKinds]=useState<string[]>(['energy-pack']),[upgradePriority,setUpgradePriority]=useState('energy-pack');
    const upgradeJson=autoUpgrades?JSON.stringify({maxBudget:coinBudget,minimumReserve:coinReserve,targetCapacity,energyBelow,priority:[upgradePriority,...upgradeKinds.filter(k=>k!==upgradePriority)].filter(k=>upgradeKinds.includes(k))}):'';
    const kindLabels:Record<string,string>={'energy-pack':'Recharge (+20 énergie, 10 monnaies)','max-energy':'Capacité (+5, 50 monnaies)','regen-speed':'Récupération (−1 s, 500 monnaies)','color-unlock':'Couleurs nécessaires (gratuité vérifiée ou 100 monnaies)'};
    const importing = importNotice?.kind === 'loading';
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
        if (!file || busy) return;
        const colors = parsePaletteText(palette);
        if (colors.invalid.length || !colors.colors.length) {
            setImportNotice({ kind: 'error', text: 'Palette invalide : codes #RRGGBB requis.' });
            return;
        }
        setBusy(true);
        setImportNotice({ kind: 'loading', text: 'Importation de l’image en cours…' });
        try {
            const data = await new Promise<string>((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(String(r.result).split(',')[1]!);
                r.onerror = () => reject(new Error('Lecture du PNG impossible.'));
                r.onabort = () => reject(new Error('Lecture du PNG interrompue.'));
                r.readAsDataURL(file);
            });
            const { data: imported } = await engineHttp.post<TemplateInfo>('/connector/drawing/import', {
                name: file.name.replace(/\.png$/i, ''),
                pngBase64: data,
                palette: colors.colors,
            }); // Local preparation does not require pairing or a private approval key.
            attempted.current = '';
            setImportNotice({
                kind: 'success',
                text: `Image importée : ${imported.name} (${imported.width} × ${imported.height}).`,
            });
            try {
                await refresh();
            } catch {
                setError('Image enregistrée ; actualiser le dashboard pour afficher le modèle.');
            }
        } catch (e) {
            setImportNotice({
                kind: 'error',
                text: e instanceof Error && !('response' in e) && !('isAxiosError' in e) ? e.message : errorMessage(e),
            });
        } finally {
            setBusy(false);
        }
    }
    const previewIdentity =
        selected && view?.project
            ? JSON.stringify([selected.templateId, view.project, groupSize, budget, upgradeJson, approvalKey])
            : '';
    const viewConnected = !!view?.connected;
    const canPreview = readerReady && !!approvalKey && !!view?.connected && !active && !busy && !batch?.uncertain;
    useEffect(() => {
        if (!previewIdentity || !viewConnected) {
            attempted.current = '';
            return;
        }
        if (!canPreview || attempted.current === previewIdentity) return;
        const timer=setTimeout(()=>{
        attempted.current = previewIdentity;
        void engineHttp
            .post(
                '/connector/drawing/preview',
                { groupSize, ...(upgradeJson?{upgrades:JSON.parse(upgradeJson)}:{}), ...(budget ? { pixelBudget: Number(budget) } : {}) },
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
        },300);
        return ()=>clearTimeout(timer);
    }, [approvalKey, previewIdentity, canPreview, groupSize, budget, upgradeJson, refresh, viewConnected]);
    const consent = { batchId: batch?.id, digest: batch?.digest, approved: true };
    const preparedGroup=batch?.scope?.groupSize ?? 5;
    const previewReady=preparedGroup===groupSize && JSON.stringify(batch?.scope?.upgrades??null)===JSON.stringify(upgradeJson?JSON.parse(upgradeJson):null) && (!budget || batch?.budgets?.pixels===Number(budget));
    return (
        <div className="space-y-4" id="simpleDrawing">
            <div className="rounded border p-4 space-y-3" aria-busy={importing}>
                <h3 className="text-lg font-semibold">1. Importer votre image</h3>
                <p>
                    Le PNG préparé est le modèle qui sera dessiné. Chargez ce même fichier comme fantôme dans GeoPixels.
                </p>
                <input
                    aria-label="Image à dessiner"
                    type="file"
                    accept="image/png"
                    disabled={active || busy}
                    onChange={(e) => {
                        setFile(e.target.files?.[0] ?? null);
                        setImportNotice(null);
                    }}
                />
                <button disabled={!file || active || busy} onClick={() => void importImage()}>
                    {importing ? 'Importation en cours…' : 'Importer l’image'}
                </button>
                {importNotice && (
                    <p id="drawingImportNotice" role={importNotice.kind === 'error' ? 'alert' : 'status'}>
                        {importNotice.text}
                    </p>
                )}
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
                {view?.connected && !readerReady && <p>Installez le lecteur 1.1.0 proposé ci-dessous et refaites le couplage pour utiliser les groupes adaptatifs et les améliorations configurables.</p>}
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
                            ce travail, par groupes {preparedGroup===0?'adaptés à l’énergie et au transport':`de ${preparedGroup} maximum`}. Autorisation jusqu’à la fin, l’arrêt ou la
                            révocation ; le transport seul peut être renouvelé automatiquement.
                        </p>
                    </>
                )}
                <p>
                    Vérifiez l’image et sa destination avant de lancer : les envois suivants seront automatiques dans ce
                    périmètre.
                </p>
                {batch?.scope?.upgrades && <p>Améliorations autorisées avec le lancement : budget maximal {batch.scope.upgrades.maxBudget} monnaies du jeu, réserve minimale {batch.scope.upgrades.minimumReserve}. Aucun paiement en argent réel.</p>}
                <div className="flex flex-wrap gap-3">
                    <button
                        className="font-semibold"
                        disabled={
                            busy ||
                            !previewReady ||
                            !readerReady ||
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
                                        { groupSize, ...(upgradeJson?{upgrades:JSON.parse(upgradeJson)}:{}), ...(budget ? { pixelBudget: Number(budget) } : {}) },
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
                            <div className="space-y-1">
                                <p>Couverture : {(view.progress.total-view.progress.unknown).toLocaleString('fr-FR')} / {view.progress.total.toLocaleString('fr-FR')} cibles connues. {view.progress.correct.toLocaleString('fr-FR')} conformes · {view.progress.incorrect.toLocaleString('fr-FR')} à corriger · {view.progress.unknown.toLocaleString('fr-FR')} inconnues.</p>
                                <p>{view.tileEvidence?.nativeUpdated ?? 0} tuile(s) remplacée(s) par une réponse native récente · {view.tileEvidence?.nativeChecked ?? 0} vérifiée(s) sans changement · {view.tileEvidence?.missing ?? 0} absente(s) du cache observé.</p>
                                {view.progress.unknown>0 && <p>Les régions chargées continuent d’être parcourues. Pour élargir la couverture, affichez les zones manquantes sur GeoPixels.</p>}
                                <details><summary>Actualisation et confirmations</summary><p>Un accusé accepte la requête. La conformité est mesurée séparément dans le cache. Une réponse native récente signifie reçue depuis moins de 30 s ; son curseur n’est pas une date serveur. Une relecture locale ne renouvelle jamais cette preuve. Les tuiles fusionnées sans preuve corrélée restent non vérifiées.</p></details>
                            </div>
                        )}
                        <p>Prochain groupe : jusqu’à {batch.adaptiveGroupSize ?? 0} pixels, selon l’énergie et le réglage autorisé.</p>
                        {!!view?.upgrades?.history.length && <details><summary>Améliorations du dessin ({view.upgrades.history.length})</summary>{view.upgrades.history.map(r=><p key={r.id}>{kindLabels[r.kind]??r.kind} · {r.cost} monnaies · {({verified:'Effet et débit observés',accepted:'Acceptée, effet à vérifier',uncertain:'Incertaine — achats concernés bloqués',delivered:'Résultat attendu',prepared:'Préparée',refused:'Refusée',cancelled:'Annulée'} as Record<string,string>)[r.state]}</p>)}</details>}
                        {batch.error && <p>{batch.error}</p>}
                        {view?.upgrades?.error && <p role="alert">{view.upgrades.error}</p>}
                    </div>
                )}
                {error && <p role="alert">{error}</p>}
            </div>
            <details>
                <summary>Options du dessin</summary>
                <div className="grid gap-3 p-3 md:grid-cols-2">
                    <label>
                        Taille cible des groupes (0 : automatique)
                        <input
                            aria-label="Pixels par requête"
                            type="number"
                            min={0}
                            max={batch?.limits?.maxGroupPixels}
                            value={active ? preparedGroup : groupSize}
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
                    <fieldset className="md:col-span-2 space-y-2" disabled={active || busy}>
                        <legend>Améliorations automatiques — monnaie du jeu uniquement</legend>
                        <label><input type="checkbox" checked={autoUpgrades} onChange={e=>setAutoUpgrades(e.target.checked)}/> Autoriser avec le prochain lancement du dessin</label>
                        {autoUpgrades && <div className="grid gap-2 md:grid-cols-2">
                            <label>Budget maximal de monnaie<input type="number" min={0} value={coinBudget} onChange={e=>setCoinBudget(Number(e.target.value))}/></label>
                            <label>Réserve minimale<input type="number" min={0} value={coinReserve} onChange={e=>setCoinReserve(Number(e.target.value))}/></label>
                            <label>Capacité ciblée<input type="number" min={1} value={targetCapacity} onChange={e=>setTargetCapacity(Number(e.target.value))}/></label>
                            <label>Recharger si énergie inférieure à<input type="number" min={0} value={energyBelow} onChange={e=>setEnergyBelow(Number(e.target.value))}/></label>
                            {Object.entries(kindLabels).map(([k,label])=><label key={k}><input type="checkbox" checked={upgradeKinds.includes(k)} onChange={e=>setUpgradeKinds(v=>e.target.checked?[...v,k]:v.filter(x=>x!==k))}/>{label}</label>)}
                            <label>Priorité<select value={upgradePriority} onChange={e=>setUpgradePriority(e.target.value)}>{Object.entries(kindLabels).map(([k,label])=><option key={k} value={k}>{label}</option>)}</select></label>
                            <p>Tarifs vérifiés dans la boutique avant chaque achat. Un tarif ou un résultat non vérifiable suspend les achats concernés.</p>
                        </div>}
                    </fieldset>
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
