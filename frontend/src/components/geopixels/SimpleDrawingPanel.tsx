import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ImageIcon, Upload } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { WorkspacePage } from '../../navigation';
import { engineHttp, STRATEGY_LABELS, type TemplateInfo } from '../../lib/engine';
import { PERSONAL_GEOPIXELS_PALETTE, parsePaletteText } from '../../lib/ghost-palettes';
import type { BatchView, EnergyPolicy, GroupPolicy, Threshold } from './BatchPanel';
import { upgradeKinds as availableUpgrades, upgrades, type UpgradeKind } from './upgrade-catalog';
import { translateReason } from '../../lib/i18n';
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
    lastCompleteProgress?: { correct: number; incorrect: number; unknown: number; total: number; capturedAt: number } | null;
    lastSync?: number | null;
    captureExpired?: boolean;
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
const upgradeStateLabels: Record<string, string> = {
    verified: 'Effet et débit observés', accepted: 'Acceptée, effet à vérifier',
    uncertain: 'Incertaine. Achats concernés bloqués.', delivered: 'Résultat attendu',
    prepared: 'Préparée', refused: 'Refusée', cancelled: 'Annulée',
};

function runningDrawingStatus(batch: BatchView) {
    if (batch.scope?.energy?.mode === 'bursts' && batch.energyPolicy?.reason) return batch.energyPolicy.reason;
    if (batch.scheduler === 'waiting-resources') {
        if (!batch.resources) return 'En attente d’une lecture d’énergie GeoPixels.';
        if (batch.resources.available === 0) return 'En attente de recharge. Énergie exploitable : 0.';
        return 'Énergie disponible. En attente de couleurs utilisables ou de données exploitables.';
    }
    if (batch.scheduler === 'waiting-observation') return 'En attente de cibles observées dans les régions chargées.';
    if (batch.scheduler === 'waiting-reconciliation') return 'En attente de vérification d’une tentative.';
    return 'Dessin en cours';
}

const thresholdLabels = { start: 'Démarrage', restart: 'Reprise', reserve: 'Réserve énergétique' };
const describeThreshold = ({ units, percent }: Threshold, fallback: string) => units && percent
    ? `max. de ${units} énergies et ${percent} %` : units ? `${units} énergies` : percent ? `${percent} %` : fallback;

/** Default workflow. Authority is granted only by the explicit launch/resume buttons. */
export function SimpleDrawingPanel({
    view,
    approvalKey,
    refresh,
    readerReady=true,
    page,
    showWorkflow,
    pairing,
}: {
    view: DrawingView | null;
    approvalKey: string;
    refresh: () => Promise<void>;
    readerReady?:boolean;
    page: WorkspacePage;
    showWorkflow: boolean;
    pairing: ReactNode;
}) {
    const [file, setFile] = useState<File | null>(null),
        [busy, setBusy] = useState(false),
        [error, setError] = useState('');
    const [groupSize, setGroupSize] = useState(0),
        [budget, setBudget] = useState(''),
        [palette, setPalette] = useState(PERSONAL_GEOPIXELS_PALETTE.join('\n'));
    const [energyMode, setEnergyMode] = useState<EnergyPolicy['mode']>('bursts');
    const [thresholds, setThresholds] = useState({ start: { units: 0, percent: 0 }, restart: { units: 0, percent: 0 }, reserve: { units: 0, percent: 0 } });
    const [groups, setGroups] = useState<GroupPolicy>({ mode: 'adaptive', minimum: 0, allowFinal: false });
    const energy: EnergyPolicy = energyMode === 'bursts' ? { mode: energyMode, ...thresholds } : { mode: energyMode };
    const [importNotice, setImportNotice] = useState<{ kind: 'loading' | 'success' | 'error'; text: string } | null>(
        null
    );
    const [upgradeMode,setUpgradeMode]=useState<'disabled' | 'limited' | 'unlimited'>('disabled'),[coinBudget,setCoinBudget]=useState(0),[coinReserve,setCoinReserve]=useState(0),[targetCapacity,setTargetCapacity]=useState(300),[energyBelow,setEnergyBelow]=useState(5);
    const [upgradeKinds,setUpgradeKinds]=useState<UpgradeKind[]>(['energy-pack']);
    const upgradeJson=upgradeMode !== 'disabled' ? JSON.stringify({maxBudget:upgradeMode === 'unlimited' ? null : coinBudget,minimumReserve:coinReserve,targetCapacity,energyBelow,priority:upgradeKinds}):'';
    const previewBody = JSON.stringify({ groupSize, energy, groups, ...(upgradeJson ? { upgrades: JSON.parse(upgradeJson) } : {}), ...(budget ? { pixelBudget: Number(budget) } : {}) });
    function moveUpgrade(index: number, direction: -1 | 1) {
        const next = [...upgradeKinds];
        const destination = index + direction;
        [next[index], next[destination]] = [next[destination], next[index]];
        setUpgradeKinds(next);
    }
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
            ? JSON.stringify([selected.templateId, selected.revision, selected.strategy, view.project, previewBody, approvalKey])
            : '';
    const viewConnected = !!view?.connected;
    const canPreview = showWorkflow && readerReady && !!approvalKey && !!view?.connected && !active && !busy && !batch?.uncertain;
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
                JSON.parse(previewBody),
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
    }, [approvalKey, previewIdentity, canPreview, previewBody, refresh, viewConnected]);
    function prepare() {
        return action(() => engineHttp.post('/connector/drawing/preview', JSON.parse(previewBody), { headers: { 'X-GeoPlacer-Approval': approvalKey } }));
    }
    const consent = { batchId: batch?.id, digest: batch?.digest, approved: true };
    const preparedGroup=batch?.scope?.groupSize ?? 5;
    const previewReady=preparedGroup===groupSize && (!batch?.scope?.strategy || batch.scope.strategy === selected?.strategy) && JSON.stringify(batch?.scope?.upgrades??null)===JSON.stringify(upgradeJson?JSON.parse(upgradeJson):null) && (!budget || batch?.budgets?.pixels===Number(budget)) && JSON.stringify(batch?.scope?.energy) === JSON.stringify(energy) && JSON.stringify(batch?.scope?.groups) === JSON.stringify(groups);
    const authorizedEnergy = batch?.scope?.energy;
    const dashboard = page === 'dashboard';
    const currentProgress = view?.progress;
    const historical = view?.lastCompleteProgress;
    const showingHistory = historical && (!currentProgress || view?.captureExpired || historical.unknown < currentProgress.unknown);
    const progress = showingHistory ? historical : currentProgress;
    const counts = progress ? [
        {label:'Conformes', value:progress.correct, type:'correct'},
        {label:'À corriger', value:progress.incorrect, type:'incorrect'},
        {label:'Inconnus', value:progress.unknown, type:'unknown'},
    ] : [];
    return (
        <div className="space-y-4" id="simpleDrawing">
            <div className="studio-workflow" data-page={page} hidden={!dashboard && page !== 'drawings' && page !== 'diagnostics'}>
              <div className="studio-steps">
            <section className="studio-card space-y-3" aria-busy={importing} hidden={!(dashboard && showWorkflow) && page !== 'drawings'}>
                <h2 className="studio-step">{dashboard && <span>1</span>} Importer votre image</h2>
                <p className="text-muted-foreground">Choisissez un PNG, puis téléchargez le fantôme préparé pour GeoPixels.</p>
                <div className="studio-import">
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
                <button className="studio-primary" disabled={!file || active || busy} onClick={() => void importImage()}>
                    <Upload size={16} aria-hidden="true" />
                    {importing ? 'Importation en cours…' : 'Importer l’image'}
                </button>
                </div>
                {importNotice && (
                    <p id="drawingImportNotice" role={importNotice.kind === 'error' ? 'alert' : 'status'}>
                        {importNotice.text}
                    </p>
                )}
                {selected && imageUrl && <a href={imageUrl} download>Télécharger le fantôme pour GeoPixels</a>}
            </section>
            <div hidden={!dashboard && page !== 'diagnostics'}>{pairing}</div>
            <section className="studio-card space-y-3" hidden={!dashboard || !showWorkflow}>
                <h2 className="studio-step"><span>3</span> Vérifier et lancer le dessin</h2>
                {view?.connected && !readerReady && <p>Installez le lecteur 1.1.2 proposé à l’étape 2, puis couplez-le pour utiliser les salves.</p>}
                {!view?.connected ? (
                    <p>
                        Chargez le fantôme sur GeoPixels, puis couplez le lecteur à l’étape 2.
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
                        {selected && <p>Mode {STRATEGY_LABELS[selected.strategy] ?? selected.strategy} · <Link to="/modes">Modes de dessin</Link></p>}
                        <p>
                            Au maximum {batch.budgets?.pixels} pixels distincts et {batch.budgets?.energy} énergie pour
                            ce travail, par groupes {preparedGroup===0?'adaptés à l’énergie et au transport':`de ${preparedGroup} maximum`}. Autorisation jusqu’à la fin, l’arrêt ou la
                            révocation ; le transport seul peut être renouvelé automatiquement.
                        </p>
                    </>
                )}
                {view?.connected && !view.bound && !active && <>
                    <p>Dans GeoPixels, chargez le PNG préparé et cliquez sur « Observer le modèle ».</p>
                    {view.project && <button disabled={!readerReady || !approvalKey || busy || !!batch?.uncertain || !!view.monitoring.inFlight}
                        onClick={() => void prepare()}>Vérifier et lier le fantôme</button>}
                </>}
                {view?.bound && batch?.execution === 'autonomous' && <p>
                    Vérifiez l’image et sa destination avant de lancer : les envois suivants seront automatiques dans ce
                    périmètre.
                </p>}
                {authorizedEnergy && <p>{active ? 'Travail autorisé' : batch?.state === 'prepared' ? 'Prévisualisation' : 'Dernier travail'} · {authorizedEnergy.mode === 'bursts'
                    ? `Salves · Démarrage ${describeThreshold(authorizedEnergy.start, '100 %')} · Reprise ${describeThreshold(authorizedEnergy.restart, '100 %')} · Réserve ${describeThreshold(authorizedEnergy.reserve, 'aucune')}`
                    : 'Continu, selon l’énergie disponible'}</p>}
                {batch?.scope?.upgrades && <p>Améliorations {active ? 'autorisées' : 'prévues'} · Budget {batch.scope.upgrades.maxBudget === null ? 'illimité' : `${batch.scope.upgrades.maxBudget} monnaies du jeu`} · Réserve {batch.scope.upgrades.minimumReserve || 'aucune'}.</p>}
                <div className="flex flex-wrap gap-3">
                    <button
                        className="studio-primary"
                        disabled={
                            busy ||
                            !previewReady ||
                            !readerReady ||
                            !approvalKey ||
                            !view?.connected ||
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
                            onClick={() => void prepare()}
                        >
                            Préparer la suite
                        </button>
                    )}
                    {batch && batch.state !== 'idle' && (
                        <button
                            className="studio-stop"
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
                {batch && batch.state !== 'idle' && (
                    <div role="status">
                        <p>
                            {batch.state === 'completed'
                                ? 'Envois terminés — vérifier les observations'
                                : batch.state === 'paused'
                                  ? 'Dessin en pause'
                                  : batch.state === 'running'
                                    ? runningDrawingStatus(batch)
                                    : batch.state === 'prepared'
                                      ? 'Prêt — aucun envoi autorisé'
                                      : batch.state === 'stopped'
                                        ? 'Dessin arrêté'
                                        : batch.state === 'interrupted'
                                          ? 'Travail interrompu — nouvel accord requis'
                                          : batch.state === 'blocked' ? 'Dessin bloqué'
                                          : 'Aucun dessin lancé'}
                        </p>
                        <p>
                            {batch.confirmed} cibles acquittées · {batch.acceptedRequests ?? 0} requêtes acceptées ·{' '}
                            {batch.uncertain} tentative(s) incertaine(s).
                        </p>
                        <p>
                            Énergie exploitable :{' '}
                            {batch.resources?.available ?? 'indisponible — attente d’une nouvelle réponse native'}.
                            {batch.resources?.capacity != null && ` Capacité observée : ${batch.resources.capacity}.`}
                        </p>
                        {batch.state === 'running' && batch.scheduler === 'waiting-resources' && !batch.resources && (
                            <p>Dans GeoPixels, ouvrez « Options du lecteur » puis « Diagnostiquer » pour vérifier la lecture de l’énergie.</p>
                        )}
                        <p>{batch.scope?.groups?.mode === 'manual' ? 'Manuel' : 'Adaptatif'} · Taille cible {preparedGroup || batch.limits?.maxGroupPixels || 'automatique'} · Plafond actuel {batch.groupCeiling ?? '—'} · Prochain envoi jusqu’à {batch.adaptiveGroupSize ?? 0} pixels.</p>
                        {batch.groupReason && <p>{batch.groupReason}</p>}
                        {batch.error && <p>{translateReason(batch.error)}</p>}
                        {view?.upgrades?.error && <p role="alert">{view.upgrades.error}</p>}
                    </div>
                )}
                {active && <Link className="studio-link" to="/file">Voir les groupes et les résultats</Link>}
                {error && <p role="alert">{error}</p>}
            </section>
              </div>
              <section className="studio-card studio-preview" hidden={!dashboard}>
                <div className="studio-card-heading">
                  <div><h2>{selected?.name ?? 'Aperçu du dessin'}</h2><p>{selected ? `${selected.width} × ${selected.height} px` : 'Importez votre PNG pour afficher le modèle.'}</p></div>
                  <Link className="studio-link" to="/dessins">Mes dessins</Link>
                </div>
                {selected && <p>{(selected.width * selected.height).toLocaleString('fr-FR')} positions dans le PNG · {selected.paintablePixels.toLocaleString('fr-FR')} cibles opaques · {(selected.width * selected.height - selected.paintablePixels).toLocaleString('fr-FR')} transparentes.</p>}
                <div className="studio-image-stage">
                  {imageUrl && selected ? <img src={`${imageUrl}?rev=${selected.revision}`} alt={`Modèle préparé : ${selected.name}`} /> : <ImageIcon size={44} aria-hidden="true" />}
                </div>
                <div className="studio-card-heading">
                  <h3>{showingHistory ? 'Dernière capture complète' : 'Progression observée'}</h3>
                  {progress && <span>{(progress.total-progress.unknown).toLocaleString('fr-FR')} / {progress.total.toLocaleString('fr-FR')} cibles connues</span>}
                </div>
                {progress && progress.total > 0 && <div className="studio-progress" aria-hidden="true">{counts.map(c => <span key={c.type} data-count={c.type} style={{flexGrow:c.value}} />)}</div>}
                {progress ? <dl className="studio-metrics">{counts.map(c => <div key={c.type}><dt>{c.label}</dt><dd data-count={c.type}>{c.value.toLocaleString('fr-FR')}</dd></div>)}</dl> : <p className="text-muted-foreground">En attente d’une observation du lecteur.</p>}
                {showingHistory && <p className="text-muted-foreground">Instantané conservé à {new Date(historical.capturedAt).toLocaleTimeString('fr-FR')}. Couverture exploitable actuellement : {(currentProgress ? currentProgress.total - currentProgress.unknown : 0).toLocaleString('fr-FR')} cibles.</p>}
                {view?.lastSync && <p className="text-muted-foreground">Dernière capture à {new Date(view.lastSync).toLocaleTimeString('fr-FR')}{view.captureExpired ? ' · capture expirée' : ''}</p>}
                {view?.tileEvidence && (
                  <details>
                    <summary>Actualisation des tuiles</summary>
                    <p>{view.tileEvidence.nativeUpdated} actualisées · {view.tileEvidence.nativeChecked} vérifiées sans changement · {view.tileEvidence.missing} absentes du cache.</p>
                    <p>{view.tileEvidence.sourceDateKnown ? 'Source datée.' : 'Fraîcheur serveur non vérifiée. Une relecture locale ne rajeunit pas la preuve native.'}</p>
                    {!!progress?.unknown && !showingHistory && <p>Affichez les zones manquantes sur GeoPixels pour élargir la couverture.</p>}
                  </details>
                )}
              </section>
            </div>
            <details className="studio-card" hidden={!(dashboard && showWorkflow) && page !== 'resources' && page !== 'settings'} open={page === 'resources' || page === 'settings' || undefined}>
                <summary>{page === 'resources' ? 'Politique d’améliorations' : 'Options du dessin'}</summary>
                <div className="grid gap-3 p-3 md:grid-cols-2">
                    <fieldset hidden={page === 'resources'} className="md:col-span-2 space-y-2" disabled={active || busy}>
                        <legend>Politique énergétique</legend>
                        <div>
                            <label htmlFor="drawing-energy-mode">Mode énergétique</label>{' '}
                            <select id="drawing-energy-mode" value={energyMode} onChange={e=>setEnergyMode(e.target.value as EnergyPolicy['mode'])}>
                                <option value="bursts">Salves</option><option value="continuous">Continu</option>
                            </select>
                        </div>
                        {energyMode === 'bursts' && <>
                            <p>Le seuil le plus élevé s’applique. Deux champs à 0 ou vides demandent la capacité pleine pour démarrer ou reprendre, et aucune réserve pour le dernier réglage.</p>
                            <div className="grid gap-2 md:grid-cols-3">{(Object.keys(thresholdLabels) as (keyof typeof thresholdLabels)[]).map(key => (
                                <div className="space-y-2" key={key}><h3>{thresholdLabels[key]}</h3>
                                    <label>{thresholdLabels[key]} (énergies)<input type="number" min={0} max={1e9} placeholder="0" value={thresholds[key].units || ''} onChange={e=>setThresholds(prev=>({ ...prev,[key]:{...prev[key],units:Number(e.target.value)} }))}/></label>
                                    <label>{thresholdLabels[key]} (%)<input type="number" min={0} max={100} placeholder="0" value={thresholds[key].percent || ''} onChange={e=>setThresholds(prev=>({ ...prev,[key]:{...prev[key],percent:Number(e.target.value)} }))}/></label>
                                </div>
                            ))}</div>
                        </>}
                    </fieldset>
                    <label hidden={page === 'resources'}>Mode des groupes<select disabled={active || busy} value={groups.mode} onChange={e=>setGroups(previous=>({...previous,mode:e.target.value as GroupPolicy['mode']}))}>
                        <option value="adaptive">Adaptatif</option><option value="manual">Manuel</option>
                    </select></label>
                    <label hidden={page === 'resources'}>
                        Taille maximale du groupe (0 = plafond local)
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
                    <label hidden={page === 'resources'}>Taille minimale souhaitée (0 = aucun minimum)<input type="number" min={0} max={batch?.limits?.maxGroupPixels} disabled={active || busy} value={groups.minimum} onChange={e=>setGroups(previous=>({...previous,minimum:Number(e.target.value)}))}/></label>
                    <label hidden={page === 'resources'}><input type="checkbox" disabled={active || busy} checked={groups.allowFinal} onChange={e=>setGroups(previous=>({...previous,allowFinal:e.target.checked}))}/> Autoriser un dernier groupe sous le minimum</label>
                    <label hidden={page === 'resources'}>
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
                    <fieldset className="md:col-span-2 space-y-3" disabled={active || busy}>
                        <legend>Améliorations automatiques — monnaie du jeu uniquement</legend>
                        <div>
                            <label htmlFor="drawing-upgrade-budget">Budget des améliorations</label>{' '}
                            <select id="drawing-upgrade-budget" value={upgradeMode} onChange={e=>setUpgradeMode(e.target.value as typeof upgradeMode)}>
                                <option value="disabled">Désactivé</option><option value="limited">Budget limité</option><option value="unlimited">Illimité</option>
                            </select>
                        </div>
                        {upgradeMode !== 'disabled' && <div className="grid gap-2 md:grid-cols-2">
                            {upgradeMode === 'limited' ? <label>Budget maximal de monnaie<input type="number" min={0} value={coinBudget} onChange={e=>setCoinBudget(Number(e.target.value))}/></label> : <p>Budget illimité en monnaie du jeu.</p>}
                            <label>Réserve minimale (0 = aucune)<input type="number" min={0} value={coinReserve} onChange={e=>setCoinReserve(Number(e.target.value))}/></label>
                            <label>Capacité ciblée (0 = tant que l’offre est disponible)<input type="number" min={0} value={targetCapacity} onChange={e=>setTargetCapacity(Number(e.target.value))}/></label>
                            <label>Recharger si énergie inférieure à<input type="number" min={0} value={energyBelow} onChange={e=>setEnergyBelow(Number(e.target.value))}/></label>
                            {availableUpgrades.map((kind)=><label key={kind}><input type="checkbox" checked={upgradeKinds.includes(kind)} onChange={e=>setUpgradeKinds(v=>e.target.checked?[...v,kind]:v.filter(x=>x!==kind))}/>{upgrades[kind].name}</label>)}
                            {!!upgradeKinds.length && <div className="md:col-span-2 space-y-2">
                                <h3>Ordre de priorité</h3>
                                <ol className="space-y-2">{upgradeKinds.map((kind, index) => <li key={kind} className="flex flex-wrap items-center gap-2">
                                    <span>{index + 1}. {upgrades[kind].name}</span>
                                    <button type="button" aria-label={`Avancer ${upgrades[kind].name}`} disabled={index === 0} onClick={() => moveUpgrade(index, -1)}>↑</button>
                                    <button type="button" aria-label={`Reculer ${upgrades[kind].name}`} disabled={index === upgradeKinds.length - 1} onClick={() => moveUpgrade(index, 1)}>↓</button>
                                </li>)}</ol>
                            </div>}
                            <p className="md:col-span-2">Tarifs vérifiés avant chaque achat. Un résultat incertain suspend l’amélioration concernée.</p>
                        </div>}
                    </fieldset>
                    <label className="md:col-span-2" hidden={page === 'resources'}>
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
            {page === 'resources' && (
                <section className="studio-card space-y-3">
                    <h2>Historique des améliorations</h2>
                    {view?.upgrades?.error && <p role="alert">{view.upgrades.error}</p>}
                    {!!view?.upgrades?.uncertain && <p>Améliorations incertaines : {view.upgrades.uncertain}.</p>}
                    {view?.upgrades?.history.length ? (
                        <div className="observation-table">
                            <table><thead><tr><th scope="col">Heure</th><th scope="col">Amélioration</th><th scope="col">Monnaie</th><th scope="col">État</th></tr></thead>
                                <tbody>{[...view.upgrades.history].reverse().map(row => (
                                    <tr key={row.id}><td>{new Date(row.at).toLocaleString('fr-FR')}</td><td>{upgrades[row.kind as UpgradeKind]?.name ?? row.kind}</td><td>{row.cost}</td><td>{upgradeStateLabels[row.state] ?? row.state}</td></tr>
                                ))}</tbody>
                            </table>
                        </div>
                    ) : <p className="text-muted-foreground">Aucune amélioration enregistrée.</p>}
                </section>
            )}
        </div>
    );
}
