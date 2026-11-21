import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ImageIcon, Upload } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { DrawingPreferencesView, ThresholdFormat } from '@geoplacer/engine-service';
import type { WorkspacePage } from '../../navigation';
import { engineHttp, STRATEGY_LABELS, type TemplateInfo } from '../../lib/engine';
import { MAX_GHOST_COLORS, PERSONAL_GEOPIXELS_PALETTE, parsePaletteText } from '../../lib/ghost-palettes';
import { type AccountPalette } from '../../lib/account-palette';
import { AccountPaletteStatus } from './AccountPaletteStatus';
import { DrawingProfiles } from './DrawingProfiles';
import { useDrawingPreferences } from './useDrawingPreferences';
import type { BatchView, EnergyPolicy, Threshold } from './BatchPanel';
import { upgradeKinds as availableUpgrades, upgrades, type UpgradeKind } from './upgrade-catalog';
import { translateReason } from '../../lib/i18n';
type DrawingView = {
    connected: boolean;
    bound: boolean;
    selection: TemplateInfo | null;
    project: { id: string; generation?: string; width: number; height: number; gridX: number; gridY: number } | null;
    batch: BatchView;
    monitoring: { inFlight: unknown };
    accountPalette?: AccountPalette;
    drawingPreferences?: DrawingPreferencesView;
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
type ThresholdKind = keyof typeof thresholdLabels;
const thresholdKinds = ['start', 'restart', 'reserve'] as const;
const defaultManualPalette = PERSONAL_GEOPIXELS_PALETTE.join('\n');

const describeThreshold = ({ units, percent }: Threshold, fallback: string) => units && percent
    ? `${units} énergies ou ${percent} % (seuil le plus élevé)` : units ? `${units} énergies` : percent ? `${percent} %` : fallback;

function EnergyThresholdField({ kind, threshold, unit, onChange }: {
    kind: ThresholdKind;
    threshold: Threshold;
    unit: ThresholdFormat;
    onChange: (value: Threshold, format: ThresholdFormat) => void;
}) {
    const label = thresholdLabels[kind];
    const unitId = `drawing-energy-${kind}-unit`;
    const hint = kind === 'reserve' ? 'Aucune réserve' : 'Capacité pleine';
    return (
        <div className="drawing-threshold">
            <div className="drawing-option-field">
                <label htmlFor={unitId}>{label}</label>
                <select id={unitId} value={unit} aria-describedby="drawing-threshold-help" onChange={(event) => {
                    const next = event.target.value as ThresholdFormat;
                    onChange({ units: next === 'percent' ? 0 : threshold.units, percent: next === 'units' ? 0 : threshold.percent }, next);
                }}>
                    <option value="units">Valeur absolue</option>
                    <option value="percent">Pourcentage</option>
                    <option value="both">Combiner les deux</option>
                </select>
            </div>
            <div className="drawing-threshold-values" data-paired={unit === 'both'}>
                {unit !== 'percent' && <label className="drawing-option-field">
                    <span>Énergies</span>
                    <input aria-label={`${label} (énergies)`} type="number" min={0} max={1e9} placeholder={unit === 'both' ? '0' : hint}
                        value={threshold.units || ''} onChange={(event) => onChange({ ...threshold, units: Number(event.target.value) }, unit)} />
                </label>}
                {unit !== 'units' && <label className="drawing-option-field">
                    <span>% capacité</span>
                    <input aria-label={`${label} (%)`} type="number" min={0} max={100} placeholder={unit === 'both' ? '0' : hint}
                        value={threshold.percent || ''} onChange={(event) => onChange({ ...threshold, percent: Number(event.target.value) }, unit)} />
                </label>}
            </div>
        </div>
    );
}

type PanelProps = {
    view: DrawingView | null;
    approvalKey: string;
    refresh: () => Promise<void>;
    readerReady?:boolean;
    page: WorkspacePage;
    showWorkflow: boolean;
    pairing: ReactNode;
};

export function SimpleDrawingPanel(props: PanelProps) {
    const preferences = props.view?.drawingPreferences;
    return preferences ? <DrawingWorkflow {...props} preferences={preferences} /> : null;
}

/** Authority is granted by explicit launch and resume buttons. */
function DrawingWorkflow({ view, approvalKey, refresh, readerReady = true, page, showWorkflow, pairing, preferences }: PanelProps & { preferences: DrawingPreferencesView }) {
    const [file, setFile] = useState<File | null>(null),
        [busy, setBusy] = useState(false),
        [error, setError] = useState('');
    const { options, nextOptions, update, persist, edit, saveError, profileError, saving, managing } = useDrawingPreferences(preferences, refresh);
    const { groupSize, pixelBudget, energyMode, thresholds, formats, upgradeMode, palette: paletteSettings } = options;
    const { mode, minimum, allowFinal } = options.groups;
    const groups = { mode, minimum, allowFinal };
    const importPalette = nextOptions.palette;
    const accountPalette = view?.accountPalette;
    const accountPaletteReady = !importPalette.manualOnly && accountPalette?.state === 'fresh' && accountPalette.colors.length > 0;
    const energy: EnergyPolicy = energyMode === 'bursts' ? { mode: energyMode, start: thresholds.start, restart: thresholds.restart, reserve: thresholds.reserve } : { mode: energyMode };
    const [importNotice, setImportNotice] = useState<{ kind: 'loading' | 'success' | 'error'; text: string } | null>(
        null
    );
    const { maxBudget: coinBudget, minimumReserve: coinReserve, targetCapacity, energyBelow, priority: upgradeKinds } = options.upgrades;
    const upgradePolicy = upgradeMode === 'disabled' ? null : { maxBudget: upgradeMode === 'unlimited' ? null : coinBudget, minimumReserve: coinReserve, targetCapacity, energyBelow, priority: upgradeKinds };
    const selected = view?.selection;
    const effectiveBudget = pixelBudget === null ? null : Math.min(pixelBudget, selected?.paintablePixels ?? pixelBudget);
    const previewBody = JSON.stringify({ groupSize, energy, groups, ...(upgradePolicy ? { upgrades: upgradePolicy } : {}), ...(effectiveBudget !== null ? { pixelBudget: effectiveBudget } : {}) });
    function moveUpgrade(index: number, direction: -1 | 1) {
        const next = [...upgradeKinds];
        const destination = index + direction;
        [next[index], next[destination]] = [next[destination], next[index]];
        update({ upgrades: { ...options.upgrades, priority: next } });
    }
    const importing = importNotice?.kind === 'loading';
    const attempted = useRef('');
    const batch = view?.batch,
        active = !!batch && ['running', 'paused'].includes(batch.state);
    const optionsLocked = active || busy || managing;
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
        const colors = parsePaletteText(importPalette.manual ?? defaultManualPalette);
        const validManual = !colors.invalid.length && colors.colors.length > 0 && colors.colors.length <= MAX_GHOST_COLORS;
        if (!accountPaletteReady && !validManual) {
            setImportNotice({ kind: 'error', text: 'Palette invalide : codes #RRGGBB requis.' });
            return;
        }
        setBusy(true);
        setImportNotice({ kind: 'loading', text: 'Importation de l’image en cours…' });
        try {
            await persist();
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
                palette: validManual ? colors.colors : [],
                ...(!importPalette.manualOnly ? { useAccountPalette: true } : {}),
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
    const canPreview = showWorkflow && readerReady && !!approvalKey && !!view?.connected && !active && !busy && !saving && !managing && !saveError && !batch?.uncertain;
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
        return action(async () => {
            await persist();
            await engineHttp.post('/connector/drawing/preview', JSON.parse(previewBody), { headers: { 'X-GeoPlacer-Approval': approvalKey } });
        });
    }
    const consent = { batchId: batch?.id, digest: batch?.digest, approved: true };
    const preparedGroup=batch?.scope?.groupSize ?? 5;
    const previewReady=preparedGroup===groupSize && (!batch?.scope?.strategy || batch.scope.strategy === selected?.strategy) && JSON.stringify(batch?.scope?.upgrades??null)===JSON.stringify(upgradePolicy) && batch?.budgets?.pixels===(effectiveBudget ?? selected?.paintablePixels) && JSON.stringify(batch?.scope?.energy) === JSON.stringify(energy) && JSON.stringify(batch?.scope?.groups) === JSON.stringify(groups);
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
                <AccountPaletteStatus sample={accountPalette} manual={importPalette.manualOnly} />
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
                {batch?.scope?.upgrades && <p>Améliorations {active ? 'autorisées' : 'prévues'} · Budget {batch.scope.upgrades.maxBudget === null ? 'illimité' : `${batch.scope.upgrades.maxBudget} monnaies du jeu`} · Réserve {batch.scope.upgrades.minimumReserve || 'aucune'}.
                    {!active && batch.state === 'prepared' && ' Le lancement autorise aussi ces achats en monnaie du jeu.'}</p>}
                <div className="flex flex-wrap gap-3">
                    <button
                        className="studio-primary"
                        disabled={
                            busy ||
                            saving ||
                            managing ||
                            !!saveError ||
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
            <details className="studio-card drawing-options" hidden={!(dashboard && showWorkflow) && page !== 'resources' && page !== 'settings'} open={page === 'resources' || page === 'settings' || undefined}>
                <summary>{page === 'resources' ? 'Politique d’améliorations' : 'Options du dessin'}</summary>
                <div className="drawing-options-body">
                    <div className="drawing-options-summary space-y-2">
                        <h3>Au prochain lancement</h3>
                        <dl className="drawing-options-grid">
                            {page !== 'resources' && <>
                                <div><dt>Énergie</dt><dd>{energy.mode === 'continuous'
                                    ? 'En continu, dès que l’énergie est disponible.'
                                    : <>Démarrage à {describeThreshold(energy.start, 'pleine capacité (100 %)')}. Reprise à {describeThreshold(energy.restart, 'pleine capacité (100 %)')}. Réserve {describeThreshold(energy.reserve, 'nulle')}.</>}</dd></div>
                                <div><dt>Groupes de pixels</dt><dd>{groups.mode === 'adaptive' ? 'Adaptatifs' : 'Manuels'}, {groupSize ? <>jusqu’à {groupSize} pixels</> : 'jusqu’au plafond local'}. {groups.minimum ? <>Minimum {groups.minimum}{groups.allowFinal ? ', sauf le dernier groupe' : ''}. </> : 'Aucun minimum. '}{pixelBudget !== null ? <>Budget de {pixelBudget} pixels.</> : 'Image entière.'} {STRATEGY_LABELS[preferences.current.strategy]}.</dd></div>
                            </>}
                            <div><dt>Améliorations</dt><dd>{upgradeMode === 'disabled' ? 'Achats automatiques désactivés.' : <>
                                {upgradeMode === 'unlimited' ? 'Budget illimité en monnaie du jeu.' : <>Budget de {coinBudget} en monnaie du jeu.</>} {coinReserve ? <>Réserve de {coinReserve}.</> : 'Aucune réserve.'} {upgradeKinds.length ? upgradeKinds.map(kind => upgrades[kind].name).join(' → ') : 'Aucune amélioration sélectionnée.'}
                            </>}</dd></div>
                        </dl>
                    </div>
                    {saveError ? <div role="alert" className="flex flex-wrap items-center gap-2">Enregistrement des réglages impossible. {saveError}
                        <button type="button" disabled={saving || managing} onClick={() => void persist().catch(() => undefined)}>Réessayer</button></div> :
                        <p role="status" className="drawing-option-note">{saving ? 'Enregistrement des réglages…' : 'Réglages enregistrés.'}</p>}
                    {page !== 'resources' && <DrawingProfiles preferences={preferences} edit={edit} disabled={optionsLocked} error={profileError} />}
                    <fieldset className="drawing-option-section" hidden={page === 'resources'} disabled={optionsLocked}>
                        <legend>Énergie et salves</legend>
                        <div className="drawing-options-grid">
                            <div className="drawing-option-field">
                                <label htmlFor="drawing-energy-mode">Mode énergétique</label>
                                <select id="drawing-energy-mode" value={energyMode} onChange={event => update({ energyMode: event.target.value as EnergyPolicy['mode'] })}>
                                    <option value="bursts">Salves</option><option value="continuous">Continu</option>
                                </select>
                            </div>
                        </div>
                        <div className="space-y-3" hidden={energyMode !== 'bursts'}>
                            <div className="drawing-options-grid">{thresholdKinds.map(kind => (
                                <EnergyThresholdField key={kind} kind={kind} threshold={thresholds[kind]} unit={formats[kind]}
                                    onChange={(value, format) => update({ thresholds: { ...thresholds, [kind]: value }, formats: { ...formats, [kind]: format } })} />
                            ))}</div>
                            <p className="drawing-option-note" id="drawing-threshold-help">Pour un seuil laissé vide ou entièrement à 0, le démarrage et la reprise attendent la pleine capacité (100 %) et la réserve est nulle. Si les deux formats sont renseignés, le seuil le plus élevé s’applique.</p>
                        </div>
                        {energyMode === 'continuous' && <p className="drawing-option-note">Le dessin utilise l’énergie disponible dès qu’il peut envoyer un groupe.</p>}
                    </fieldset>
                    <fieldset className="drawing-option-section" hidden={page === 'resources'} disabled={optionsLocked}>
                        <legend>Groupes de pixels</legend>
                        <div className="drawing-options-grid">
                            <div className="drawing-option-field">
                                <label htmlFor="drawing-group-mode">Mode des groupes</label>
                                <select id="drawing-group-mode" value={groups.mode} onChange={event => update({ groups: { ...groups, mode: event.target.value as typeof mode } })}>
                                    <option value="adaptive">Adaptatif</option><option value="manual">Manuel</option>
                                </select>
                            </div>
                            <label className="drawing-option-field">
                                <span>Pixels par requête</span>
                                <input aria-label="Pixels par requête" aria-describedby="drawing-group-max-help" type="number"
                                    min={0} max={batch?.limits?.maxGroupPixels} value={groupSize} onChange={event => update({ groupSize: Number(event.target.value) })} />
                                <small id="drawing-group-max-help">Maximum par envoi. 0 ou vide = plafond local{batch?.limits ? <> ({batch.limits.maxGroupPixels} pixels)</> : ''}.</small>
                            </label>
                            <label className="drawing-option-field">
                                <span>Budget du dessin</span>
                                <input aria-label="Budget du dessin" aria-describedby="drawing-pixel-budget-help" type="number" min={1}
                                    placeholder="Image entière" value={pixelBudget ?? ''} onChange={event => update({ pixelBudget: event.target.value === '' ? null : Number(event.target.value) })} />
                                <small id="drawing-pixel-budget-help">En pixels. Champ vide = image entière.{effectiveBudget !== pixelBudget && <> Ce dessin est limité à {effectiveBudget} cibles.</>}</small>
                            </label>
                        </div>
                        <p className="drawing-option-note">{groups.mode === 'adaptive'
                            ? 'La taille augmente après les envois acceptés, dans la limite du maximum.'
                            : 'Chaque requête utilise jusqu’au maximum, selon l’énergie, les cibles disponibles et le transport.'}</p>
                        <details className="drawing-option-advanced">
                            <summary>Taille minimale et dernier groupe</summary>
                            <div className="drawing-options-grid">
                                <div className="drawing-option-field">
                                    <label htmlFor="drawing-group-min">Minimum souhaité</label>
                                    <input id="drawing-group-min" type="number" min={0} max={batch?.limits?.maxGroupPixels} value={groups.minimum}
                                        aria-describedby="drawing-group-min-help" onChange={event => update({ groups: { ...groups, minimum: Number(event.target.value) } })} />
                                    <small id="drawing-group-min-help">0 ou vide = aucun minimum.</small>
                                </div>
                                <label className="drawing-option-check"><input type="checkbox" checked={groups.allowFinal}
                                    onChange={event => update({ groups: { ...groups, allowFinal: event.target.checked } })} /> Autoriser un dernier groupe sous le minimum</label>
                            </div>
                        </details>
                    </fieldset>
                    <fieldset className="drawing-option-section" disabled={optionsLocked}>
                        <legend>Améliorations automatiques</legend>
                        <div className="drawing-options-grid">
                            <div className="drawing-option-field">
                                <label htmlFor="drawing-upgrade-budget">Budget des améliorations</label>
                                <select id="drawing-upgrade-budget" value={upgradeMode} aria-describedby="drawing-upgrade-help"
                                    onChange={event => update({ upgradeMode: event.target.value as typeof upgradeMode })}>
                                    <option value="disabled">Désactivé</option><option value="limited">Budget limité</option><option value="unlimited">Illimité</option>
                                </select>
                            </div>
                            {upgradeMode === 'limited' && <div className="drawing-option-field">
                                <label htmlFor="drawing-coin-budget">Budget maximal de monnaie</label>
                                <input id="drawing-coin-budget" type="number" min={0} value={coinBudget} aria-describedby="drawing-coin-budget-help"
                                    onChange={event => update({ upgrades: { ...options.upgrades, maxBudget: Number(event.target.value) } })} />
                                <small id="drawing-coin-budget-help">0 ou vide = aucune dépense.</small>
                            </div>}
                            {upgradeMode !== 'disabled' && <div className="drawing-option-field">
                                <label htmlFor="drawing-coin-reserve">Réserve de monnaie</label>
                                <input id="drawing-coin-reserve" type="number" min={0} value={coinReserve} aria-describedby="drawing-coin-reserve-help"
                                    onChange={event => update({ upgrades: { ...options.upgrades, minimumReserve: Number(event.target.value) } })} />
                                <small id="drawing-coin-reserve-help">0 ou vide = aucune réserve.</small>
                            </div>}
                        </div>
                        <p className="drawing-option-note" id="drawing-upgrade-help">{upgradeMode === 'unlimited'
                            ? 'Illimité = aucun plafond de dépenses en monnaie du jeu.'
                            : 'Seule la monnaie du jeu peut servir aux achats automatiques.'}</p>
                        {upgradeMode !== 'disabled' && <>
                            <div className="drawing-upgrade-selections">
                                <div>
                                    <h4>Améliorations autorisées</h4>
                                    {availableUpgrades.map(kind => <label className="drawing-option-check" key={kind}><input type="checkbox"
                                        checked={upgradeKinds.includes(kind)} onChange={event => update({ upgrades: { ...options.upgrades, priority: event.target.checked ? [...upgradeKinds, kind] : upgradeKinds.filter(item => item !== kind) } })}
                                    /> {upgrades[kind].name}</label>)}
                                </div>
                                {!!upgradeKinds.length && <div>
                                    <h4>Ordre de priorité</h4>
                                    <ol className="drawing-priorities">{upgradeKinds.map((kind, index) => <li key={kind}>
                                        <span>{index + 1}. {upgrades[kind].name}</span>
                                        <div>
                                            <button type="button" aria-label={'Avancer ' + upgrades[kind].name} disabled={index === 0} onClick={() => moveUpgrade(index, -1)}>↑</button>
                                            <button type="button" aria-label={'Reculer ' + upgrades[kind].name} disabled={index === upgradeKinds.length - 1} onClick={() => moveUpgrade(index, 1)}>↓</button>
                                        </div>
                                    </li>)}</ol>
                                </div>}
                            </div>
                            <details className="drawing-option-advanced">
                                <summary>Conditions d’achat avancées</summary>
                                <div className="drawing-options-grid">
                                    <div className="drawing-option-field">
                                        <label htmlFor="drawing-target-capacity">Capacité ciblée</label>
                                        <input id="drawing-target-capacity" type="number" min={0} value={targetCapacity} aria-describedby="drawing-capacity-help"
                                            onChange={event => update({ upgrades: { ...options.upgrades, targetCapacity: Number(event.target.value) } })} />
                                        <small id="drawing-capacity-help">0 ou vide = jusqu’à la limite proposée par GeoPixels.</small>
                                    </div>
                                    <div className="drawing-option-field">
                                        <label htmlFor="drawing-buy-energy-below">Recharger si énergie inférieure à</label>
                                        <input id="drawing-buy-energy-below" type="number" min={0} value={energyBelow} aria-describedby="drawing-buy-energy-help"
                                            onChange={event => update({ upgrades: { ...options.upgrades, energyBelow: Number(event.target.value) } })} />
                                        <small id="drawing-buy-energy-help">0 ou vide = aucune recharge automatique.</small>
                                    </div>
                                </div>
                            </details>
                            <p className="drawing-option-note">Tarifs vérifiés avant chaque achat. Un résultat incertain suspend l’amélioration concernée.</p>
                        </>}
                    </fieldset>
                    <details className="drawing-options-palette" hidden={page === 'resources'}>
                        <summary>Palette</summary>
                        <div className="space-y-3">
                        <AccountPaletteStatus sample={accountPalette} manual={paletteSettings.manualOnly} details />
                        <label className="drawing-option-check">
                            <input type="checkbox" checked={paletteSettings.manualOnly} disabled={optionsLocked}
                                onChange={event => update({ palette: { ...paletteSettings, manualOnly: event.target.checked } })} />
                            Toujours utiliser la palette locale pour préparer les images
                        </label>
                        <label className="drawing-option-field">
                            <span>Palette locale (#RRGGBB)</span>
                            <textarea aria-label="Palette du dessin" value={paletteSettings.manual ?? defaultManualPalette} maxLength={4096} disabled={optionsLocked}
                                onChange={event => update({ palette: { ...paletteSettings, manual: event.target.value } })} />
                        </label>
                        <p className="drawing-option-note">La palette locale sert de secours. Pour choisir des couleurs à débloquer, utilisez-la pour préparer le modèle. La synchronisation s’applique aux nouveaux imports.</p>
                        </div>
                    </details>
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
