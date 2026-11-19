import { Link } from 'react-router-dom';
import type { WorkspacePage } from '../../navigation';
import { DrawingGallery } from '../DrawingGallery';
import { ConnectorQueue } from './ConnectorQueue';
import { SimpleDrawingPanel } from './SimpleDrawingPanel';
import { useCallback, useEffect, useState } from 'react';
import './ConnectorDashboard.css';
import { BatchPanel, type BatchView } from './BatchPanel';
import { SinglePixelPanel, type SinglePixelView } from './SinglePixelPanel';
import { STATE_LABELS } from '../../lib/engine';
import { translateReason } from '../../lib/i18n';
import { engineHttp, type TemplateInfo } from '../../lib/engine';
import { onConnectorChange } from '../../hooks/useEngine';
import { RegionalObservations, type RegionView } from './RegionalObservations';
import { ObservationSupervision, type Monitoring } from './ObservationSupervision';

type View = {
    tileEvidence?:{total:number;nativeUpdated:number;nativeChecked:number;missing:number;sourceDateKnown:boolean};
    upgrades?:{error?:string|null;uncertain:number;history:{id:string;kind:string;cost:number;state:string;at:number}[]};
    connected: boolean;
    mode: 'read-only' | 'local-fake' | null;
    session: string;
    bound: boolean;
    project: { id: string; width: number; height: number; gridX: number; gridY: number } | null;
    selection: TemplateInfo | null;
    lastSync: number | null;
    captureAgeMs: number | null;
    captureExpired: boolean;
    monitoring: Monitoring;
    singlePixel: SinglePixelView;
    batch: BatchView;
    regionViews: RegionView[];
    savedRegionConfiguration: { available: boolean; matching: boolean; count: number };
    freshness: string;
    resourcesStale: boolean;
    error: string | null;
    resources: { energy: number | null; capacity: number | null; currency: number | null } | null;
    progress: { correct: number; incorrect: number; unknown: number; total: number } | null;
    lastCompleteProgress?: { correct: number; incorrect: number; unknown: number; total: number; capturedAt: number } | null;
    scheduler: { state: string; reason: string | null; openAttempts: number; uncertainAttempts: string[] } | null;
};
type HttpReaderInfo = {
    batchProtocol?: number | null;
    enabled: boolean;
    active: boolean;
    approvedAt?: number | null;
    expires?: number | null;
    remainingMs?: number | null;
    lastTermination?: { code: string; at: number; reason: string } | null;
    pending: { requestId: string; fingerprint: string; originClaim: string; expires: number } | null;
};
type Proposal = {
    allowed: boolean;
    reasons: string[];
    proposal: { id: string; kind: string; cost: number | null; savedMs: number | null; benefit: string };
};
const kindLabels: Record<string, string> = {
    'energy-pack': 'Recharge',
    'regen-speed': 'Récupération',
    'max-energy': 'Capacité',
    'color-unlock': 'Couleur',
};
const number = (n: number | null | undefined) => (n == null ? 'Indisponible' : n.toLocaleString('fr-FR'));

export function ConnectorDashboard({ page }: { page: WorkspacePage }) {
    const [advanced,setAdvanced]=useState(()=>sessionStorage.getItem('geoplacer.advanced')==='true');
    const showAdvanced = page === 'diagnostics' || (page === 'dashboard' && advanced);
    const [approvalKey, setApprovalKey] = useState('');
    const [httpReader, setHttpReader] = useState<HttpReaderInfo | null>(null);
    const [readerOrigin, setReaderOrigin] = useState('https://geopixels.net');
    const [view, setView] = useState<View | null>(null);
    const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
    const [galleryError, setGalleryError] = useState(false);
    const [error, setError] = useState('');
    const [capability, setCapability] = useState('');
    const [busy, setBusy] = useState(false);
    const [budget, setBudget] = useState(100);
    const [reserve, setReserve] = useState(50);
    const [capacity, setCapacity] = useState(100);
    const [enabled, setEnabled] = useState(false);
    const [proposals, setProposals] = useState<Proposal[]>([]);
    const [captureInterval, setCaptureInterval] = useState(10);
    useEffect(() => {
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        let inFlight = false;
        const poll = async () => {
            clearTimeout(timer);
            if (inFlight || abort.signal.aborted) return;
            inFlight = true;
            try {
                const [response, http] = await Promise.all([
                    engineHttp.get<View>('/connector/status', { signal: abort.signal }),
                    engineHttp.get<HttpReaderInfo>('/connector/http', { signal: abort.signal }),
                ]);
                if (!abort.signal.aborted) {
                    setView(response.data);
                    setHttpReader(http.data);
                }
            } catch {
                if (!abort.signal.aborted) setError('État du connecteur indisponible');
            }
            inFlight = false;
            if (!abort.signal.aborted) timer = setTimeout(poll, 1500);
        };
        const unsubscribe = onConnectorChange(() => {
            void poll();
        });
        void poll();
        return () => {
            abort.abort();
            clearTimeout(timer);
            unsubscribe();
        };
    }, []);
    const selectionId = view?.selection?.templateId;
    const loadTemplates = useCallback((signal?: AbortSignal) =>
        engineHttp.get<{ templates: TemplateInfo[] }>('/templates', { signal }).then(
            ({data}) => {
                if (!signal?.aborted) {
                    setTemplates(data.templates);
                    setGalleryError(false);
                }
            },
            () => { if (!signal?.aborted) setGalleryError(true); }
        ), []);
    useEffect(() => {
        if (!showAdvanced && page !== 'drawings') return;
        const controller = new AbortController();
        void loadTemplates(controller.signal);
        return () => controller.abort();
    }, [showAdvanced, page, selectionId, loadTemplates]);
    const refresh = useCallback(async () => setView((await engineHttp.get<View>('/connector/status')).data), []);
    async function action(fn: () => Promise<unknown>) {
        setBusy(true);
        setError('');
        try {
            await fn();
            setView((await engineHttp.get<View>('/connector/status')).data);
        } catch (e) {
            const message = (e as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error
                ?.message;
            setError(message ?? 'Commande refusée');
        } finally {
            setBusy(false);
        }
    }
    const engineActive = !!view?.scheduler && !['stopped', 'completed', 'error'].includes(view.scheduler.state);
    const active = engineActive || ['running','paused'].includes(view?.batch.state ?? '');
    async function pair(mode: 'local-fake' | 'read-only') {
        setCapability('');
        const origin = mode === 'local-fake' ? location.origin : readerOrigin;
        const result = await engineHttp.post<{ token: string }>('/connector/pair', { mode, origin });
        setCapability(result.data.token);
        // The one-use capability stays in component memory, never in an URL or browser storage.
    }
    const dimensionsMatch =
        !!view?.project &&
        !!view.selection &&
        view.project.width === view.selection.width &&
        view.project.height === view.selection.height;
    async function restoreTestModel() {
        const name = 'Test GeoPixels — fantôme 8 × 5';
        const available = templates ?? (await engineHttp.get<{ templates: TemplateInfo[] }>('/templates')).data.templates;
        let template = available.find((t) => t.name === name && t.width === 8 && t.height === 5);
        if (!template) {
            const response = await fetch('/fixtures/geoplacer-8x5.png');
            if (!response.ok) throw new Error('PNG de test indisponible');
            const bytes = new Uint8Array(await response.arrayBuffer());
            template = (
                await engineHttp.post<TemplateInfo>('/templates', {
                    name,
                    pngBase64: btoa(String.fromCharCode(...bytes)),
                    x: 0,
                    y: 0,
                    strategy: 'top-to-bottom',
                })
            ).data;
        }
        await engineHttp.put('/engine/selection', { templateId: template.templateId });
        setTemplates((await engineHttp.get<{ templates: TemplateInfo[] }>('/templates')).data.templates);
    }
    const pairing = (
        <section className="studio-card">
            <details className="connector-setup" open={!view?.connected || !!httpReader?.pending}>
                <summary className="studio-step"><span aria-hidden="true">2</span> {view?.connected ? 'Lecteur couplé' : 'Coupler le lecteur'}</summary>
                <label className="studio-origin">
                    Origine de la page GeoPixels
                    <select
                        aria-label="Origine GeoPixels"
                        value={readerOrigin}
                        disabled={busy || active}
                        onChange={(event) => setReaderOrigin(event.target.value)}
                    >
                        <option value="https://geopixels.net">https://geopixels.net</option>
                        <option value="https://www.geopixels.net">https://www.geopixels.net</option>
                    </select>
                </label>
                <p>
                    Sélectionnez l’adresse affichée dans votre onglet GeoPixels.
                </p>
                <div className="rounded border border-border p-3 space-y-2">
                    {httpReader?.enabled === false && <p>Arrêtez le serveur, puis lancez <code>npm run start:reader</code> pour activer le couplage.</p>}
                    <label>
                        Clé locale d’approbation privée
                        <input
                            aria-label="Clé locale d’approbation"
                            className="block w-full font-mono"
                            type="password"
                            autoComplete="off"
                            value={approvalKey}
                            onChange={(e) => setApprovalKey(e.target.value)}
                        />
                    </label>
                    <p>
                        Saisissez ici la clé de la console GeoPlacer. Le lecteur reçoit seulement le code temporaire.
                    </p>
                    {httpReader?.pending && (
                        <div role="status">
                            <p>
                                Demande HTTP : <strong>{httpReader.pending.fingerprint}</strong>
                            </p>
                            <p>
                                Origine déclarée : {httpReader.pending.originClaim} (non attestée cryptographiquement).
                            </p>
                            <p>Comparer l’empreinte avec le panneau Tampermonkey avant de confirmer.</p>
                            <button
                                disabled={busy || !/^[a-f0-9]{64}$/.test(approvalKey)}
                                onClick={() =>
                                    void action(async () => {
                                        await engineHttp.post(
                                            '/connector/http/approve',
                                            { requestId: httpReader.pending!.requestId },
                                            { headers: { 'X-GeoPlacer-Approval': approvalKey } }
                                        );
                                        setCapability('');
                                    })
                                }
                            >
                                Confirmer la demande HTTP
                            </button>
                        </div>
                    )}
                </div>
                <div className="flex flex-wrap gap-2">
                    <button hidden={!showAdvanced} disabled={busy || active} onClick={() => void action(() => pair('local-fake'))}>
                        Coupler un navigateur factice
                    </button>

                    <a hidden={!showAdvanced} href="/connector-fixture.html" target="_blank" rel="noreferrer">
                        Ouvrir la page factice
                    </a>
                    <button
                        disabled={busy || active}
                        onClick={() =>
                            void action(async () => {
                                setCapability('');
                                const r = await engineHttp.post<{ token: string }>(
                                    '/connector/http/pair',
                                    { origin: readerOrigin },
                                    { headers: { 'X-GeoPlacer-Approval': approvalKey } }
                                );
                                setCapability(r.data.token);
                            })
                        }
                    >
                        Coupler le lecteur GeoPixels
                    </button>
                </div>
                {capability && (
                    <div className="rounded border p-3">
                        <label>
                            Code à usage unique (60 secondes)
                            <input
                                aria-label="Code de couplage"
                                className="block w-full font-mono"
                                type="password"
                                value={capability}
                                readOnly
                                autoComplete="off"
                            />
                        </label>
                        <button onClick={() => void navigator.clipboard.writeText(capability)}>Copier le code</button>
                        <button onClick={() => setCapability('')}>Masquer le code</button>
                    </div>
                )}
            </details>
            <div className="flex flex-wrap items-center gap-2 mt-3">
            <button
                disabled={busy || (!view?.connected && !httpReader?.active && !httpReader?.pending && !capability)}
                onClick={() =>
                    void action(async () => {
                        await engineHttp.post('/connector/revoke', {});
                        setCapability('');
                    })
                }
            >
                Révoquer le canal
            </button>
            <a href="/geopixels-connector.user.js" download>
                Télécharger le lecteur Tampermonkey
            </a>
            </div>
        </section>
    );
    const showWorkflow = !advanced || view?.batch.execution === 'autonomous';
    return (
        <section className="connector-dashboard space-y-4" id="connectorDashboard" hidden={page === 'other'}>
            <div className="studio-connection studio-card" hidden={page !== 'dashboard' && page !== 'diagnostics'}>
                <h2 className="text-xl font-semibold">GeoPixels — connecteur expérimental</h2>
                <p>
                    {view?.mode === 'local-fake'
                        ? 'Fournisseur factice local : écritures synthétiques uniquement.'
                        : 'Le lecteur observe les tuiles chargées et transmet les groupes autorisés.'}
                </p>
                <p>
                    Connexion : <strong id="connectorConnection">{view?.connected ? 'Connecté' : 'Déconnecté'}</strong>{' '}
                    · Session :{' '}
                    {view?.session === 'present'
                        ? 'Contexte reçu (session non authentifiée par GeoPlacer)'
                        : 'Indisponible'}
                </p>
                {httpReader?.active && (
                    <p id="connectorCouplingTime">
                        {httpReader.expires == null
                            ? (view?.connected ? 'Couplage actif pour la session GeoPlacer.' : 'Couplage conservé · attente du lecteur.')
                            : `Couplage actif pour encore ${Math.ceil((httpReader.remainingMs ?? 0) / 1000)} s.`}
                    </p>
                )}
                {!httpReader?.active && httpReader?.lastTermination && (
                    <p id="connectorTermination" role="status">
                        {httpReader.lastTermination.reason} (
                        {new Date(httpReader.lastTermination.at).toLocaleTimeString('fr-FR')})
                    </p>
                )}
            </div>
            {error && (
                <p role="alert" className="text-red-300">
                    {error}
                </p>
            )}
            <label hidden={page !== 'dashboard'} className="studio-advanced-toggle"><input type="checkbox" aria-label="Réglages avancés" checked={advanced} onChange={e=>{setAdvanced(e.target.checked);sessionStorage.setItem('geoplacer.advanced',String(e.target.checked));}}/>Réglages avancés et anciens parcours</label>
            {page === 'drawings' && (galleryError ? <p role="alert" className="studio-alert">Galerie indisponible. <button onClick={() => void loadTemplates()}>Réessayer</button></p> :
                <DrawingGallery templates={templates} selected={selectionId} pending={busy} disabled={active || !!view?.batch.uncertain}
                    onSelect={id => void action(() => engineHttp.put('/engine/selection', {templateId:id}))} />)}
            <SimpleDrawingPanel view={view} approvalKey={approvalKey} refresh={refresh}
                readerReady={view?.mode === 'local-fake' || (httpReader?.batchProtocol ?? 0) >= 6}
                page={page} showWorkflow={showWorkflow} pairing={pairing} />
            {page === 'queue' && <ConnectorQueue batch={view?.batch}
                canReconcile={!!view?.connected && view.bound && !active && !busy && /^[a-f0-9]{64}$/.test(approvalKey)}
                onReconcile={() => void action(() => engineHttp.post('/connector/batch/reconcile', {}, {
                    headers: { 'X-GeoPlacer-Approval': approvalKey },
                }))} />}
            {page === 'resources' && (
                <section className="studio-card">
                    <dl className="studio-metrics studio-resource-metrics">
                        <div><dt>Énergie observée</dt><dd>{number(view?.resources?.energy)}</dd></div>
                        <div><dt>Énergie exploitable</dt><dd>{number(view?.batch.resources?.available)}</dd></div>
                        <div><dt>Capacité observée</dt><dd>{number(view?.resources?.capacity)}</dd></div>
                        <div><dt>Monnaie du jeu</dt><dd>{number(view?.resources?.currency)}</dd></div>
                    </dl>
                    <p>{!view?.resources ? 'Ressources indisponibles.' : view.resourcesStale ? 'Ressources anciennes ou non datées.' : 'Observation datée.'}</p>
                </section>
            )}
            {page === 'settings' && <Link className="studio-link" to="/settings/legacy">Ouvrir les paramètres hérités</Link>}
            <div hidden={!showAdvanced} className="studio-advanced space-y-4">
            <div className="rounded border p-4 space-y-2">
                <h3 className="font-semibold">2. Choisir le modèle</h3>
                <p>
                    {view?.bound ? 'Modèle lié ✓' : 'Choisissez la même image que le fantôme affiché dans GeoPixels.'}
                </p>
                <div className="connector-test-model">
                    <img
                        src="/fixtures/geoplacer-8x5.png"
                        alt="Modèle de test : L noir en haut à gauche, points en bas à droite"
                        width="80"
                        height="50"
                    />
                    <div>
                        <button disabled={busy || active} onClick={() => void action(restoreTestModel)}>
                            Utiliser le modèle de test 8 × 5
                        </button>
                        <a href="/fixtures/geoplacer-8x5.png" download>
                            Télécharger le PNG pour GeoPixels
                        </a>
                    </div>
                </div>
                <label>
                    Modèle local{' '}
                    <select
                        aria-label="Modèle local"
                        disabled={busy || active}
                        value={view?.selection?.templateId ?? ''}
                        onChange={(e) =>
                            void action(() => engineHttp.put('/engine/selection', { templateId: e.target.value }))
                        }
                    >
                        <option value="" disabled>
                            Sélectionner
                        </option>
                        {templates?.map((t) => (
                            <option
                                key={t.templateId}
                                value={t.templateId}
                                disabled={
                                    !!view?.project &&
                                    (t.width !== view.project.width || t.height !== view.project.height)
                                }
                            >
                                {t.name} ({t.width} × {t.height})
                            </option>
                        ))}
                    </select>
                </label>
                <p>
                    Modèle du navigateur :{' '}
                    {view?.project
                        ? `${view.project.width} × ${view.project.height}, origine (${view.project.gridX}, ${view.project.gridY})`
                        : 'Indisponible'}
                </p>
                <button
                    disabled={busy || active || !view?.connected || !dimensionsMatch}
                    onClick={() => void action(() => engineHttp.post('/connector/bind', {}))}
                >
                    Lier ce modèle
                </button>
                {!view?.bound && view?.project && !dimensionsMatch && (
                    <p role="status">
                        Le fantôme fait {view.project.width} × {view.project.height}. Sélectionnez un modèle de cette
                        taille ; le paysage de démonstration ne convient pas.
                    </p>
                )}
                <details>
                    <summary>Vérification de l’image</summary>
                    <p>
                        Comparez l’image, ses couleurs et sa position. Une taille identique ne suffit pas à prouver que
                        les images sont les mêmes.
                    </p>
                </details>
            </div>
            {view?.batch && view.batch.execution!=='autonomous' && (
                <BatchPanel
                    view={view.batch}
                    approvalKey={approvalKey}
                    fake={view.mode === 'local-fake'}
                    groupedReady={view.mode === 'local-fake' || (httpReader?.batchProtocol ?? 0) >= 2}
                    sessionReady={view.mode === 'local-fake' || (httpReader?.batchProtocol ?? 0) >= 3}
                    continuousReady={view.mode === 'local-fake' || (httpReader?.batchProtocol ?? 0) >= 4}
                    project={view.project}
                    ready={view.connected && view.bound && !engineActive}
                    refresh={async () => setView((await engineHttp.get<View>('/connector/status')).data)}
                />
            )}
            {view?.singlePixel && (
                <details>
                    <summary>Essai unitaire (ancien parcours)</summary>
                    <SinglePixelPanel
                        view={view.singlePixel}
                        approvalKey={approvalKey}
                        fake={view.mode === 'local-fake'}
                        ready={view.connected && view.bound && !active}
                        blockedReason={
                            !view.connected
                                ? 'Connectez le navigateur dans l’étape 1.'
                                : !view.bound
                                  ? 'Liez le bon modèle dans l’étape 2.'
                                  : !approvalKey
                                    ? 'Saisissez la clé locale dans les réglages de connexion.'
                                    : null
                        }
                        refresh={async () => {
                            setView((await engineHttp.get<View>('/connector/status')).data);
                        }}
                    />
                </details>
            )}
            <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded border p-4">
                    <h3>Progression observée</h3>
                    <dl>
                        <dt>Corrects</dt>
                        <dd id="observedCorrect">{number(view?.progress?.correct)}</dd>
                        <dt>Incorrects</dt>
                        <dd id="observedIncorrect">{number(view?.progress?.incorrect)}</dd>
                        <dt>Inconnus</dt>
                        <dd id="observedUnknown">{number(view?.progress?.unknown)}</dd>
                    </dl>
                    <p>
                        Capture du lecteur (dernière bande) :{' '}
                        {view?.lastSync ? new Date(view.lastSync).toLocaleTimeString('fr-FR') : 'Aucune'}
                    </p>
                    {view?.captureExpired && (
                        <p role="status">
                            Capture expirée (plus de 30 secondes) : les pixels anciens redeviennent inconnus.{' '}
                            {view.monitoring.state === 'running'
                                ? 'La surveillance attend la prochaine capture.'
                                : 'Utiliser « Observer le modèle » ou reprendre la surveillance.'}
                        </p>
                    )}
                    <p>
                        {view?.freshness === 'dated'
                            ? 'Observations datées ; les données anciennes deviennent inconnues.'
                            : 'Date de capture seulement ; fraîcheur du cache non vérifiée.'}
                    </p>
                </div>
                <div className="rounded border p-4">
                    <h3>Ressources observées</h3>
                    <p>
                        Énergie : {number(view?.resources?.energy)} / {number(view?.resources?.capacity)}
                    </p>
                    <p>Monnaie de jeu : {number(view?.resources?.currency)}</p>
                    <p>
                        {view?.resourcesStale
                            ? 'Ressources indisponibles, anciennes ou non datées.'
                            : 'Observation datée'}
                    </p>
                    <p>
                        État du moteur :{' '}
                        <strong id="connectorState" data-state={view?.scheduler?.state ?? 'stopped'}>
                            {STATE_LABELS[(view?.scheduler?.state ?? 'stopped') as keyof typeof STATE_LABELS]}
                        </strong>
                    </p>
                    <p>{translateReason(view?.scheduler?.reason ?? null)}</p>
                    <p>Tentatives incertaines : {view?.scheduler?.uncertainAttempts.length ?? 0}</p>
                </div>
            </div>
            {view?.monitoring && (
                <ObservationSupervision
                    monitoring={view.monitoring}
                    progress={view.progress}
                    enabled={
                        view.connected && view.bound && view.mode === 'read-only' && /^[a-f0-9]{64}$/.test(approvalKey)
                    }
                    busy={busy}
                    interval={captureInterval}
                    onInterval={setCaptureInterval}
                    onCommand={(command) =>
                        void action(() =>
                            engineHttp.post(
                                '/connector/monitor',
                                { action: command, intervalMs: captureInterval * 1000 },
                                { headers: { 'X-GeoPlacer-Approval': approvalKey } }
                            )
                        )
                    }
                />
            )}
            {view?.mode === 'read-only' && view.monitoring.regionalSupported && (
                <RegionalObservations
                    key={JSON.stringify([view.project, view.monitoring.configuredRegions])}
                    regions={view.monitoring.configuredRegions}
                    views={view.regionViews}
                    history={view.monitoring.history}
                    activeId={view.monitoring.activeRegionId}
                    width={view.project?.width ?? 1}
                    height={view.project?.height ?? 1}
                    editable={
                        view.bound &&
                        view.connected &&
                        view.monitoring.state !== 'running' &&
                        !view.monitoring.inFlight &&
                        /^[a-f0-9]{64}$/.test(approvalKey)
                    }
                    busy={busy}
                    saved={view.savedRegionConfiguration}
                    onSave={(regions) =>
                        void action(() =>
                            engineHttp.post(
                                '/connector/regions',
                                { regions },
                                { headers: { 'X-GeoPlacer-Approval': approvalKey } }
                            )
                        )
                    }
                    onRestore={() =>
                        void action(() =>
                            engineHttp.post(
                                '/connector/regions/restore',
                                {},
                                { headers: { 'X-GeoPlacer-Approval': approvalKey } }
                            )
                        )
                    }
                    onObserve={(id) =>
                        void action(() =>
                            engineHttp.post(
                                '/connector/regions/observe',
                                { id },
                                { headers: { 'X-GeoPlacer-Approval': approvalKey } }
                            )
                        )
                    }
                />
            )}
            <div className="flex flex-wrap gap-3">
                <button
                    disabled={busy || active || !view?.bound || view.mode !== 'local-fake' || view.resourcesStale}
                    onClick={() => void action(() => engineHttp.post('/engine/start', {}))}
                >
                    Démarrer le fournisseur factice
                </button>
                <button
                    disabled={busy || !active}
                    onClick={() => void action(() => engineHttp.post('/engine/pause', {}))}
                >
                    Pause
                </button>
                <button
                    disabled={busy || view?.scheduler?.state !== 'paused'}
                    onClick={() => void action(() => engineHttp.post('/engine/resume', {}))}
                >
                    Reprendre
                </button>
                <button
                    disabled={busy || !active}
                    onClick={() => void action(() => engineHttp.post('/engine/stop', { abort: true }))}
                >
                    Arrêter
                </button>
            </div>
            <details className="rounded border p-4">
                <summary>Politique d’améliorations — propositions factices</summary>
                <p>
                    Les coûts et bénéfices proviennent du moteur existant et des règles synthétiques. Aucun achat
                    disponible.
                </p>
                <label>
                    <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                    Activer les propositions d’améliorations
                </label>
                <label>
                    Budget maximal{' '}
                    <input type="number" min="0" value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
                </label>
                <label>
                    Réserve minimale{' '}
                    <input type="number" min="0" value={reserve} onChange={(e) => setReserve(Number(e.target.value))} />
                </label>
                <label>
                    Capacité ciblée{' '}
                    <input
                        type="number"
                        min="0"
                        value={capacity}
                        onChange={(e) => setCapacity(Number(e.target.value))}
                    />
                </label>
                <p>Priorité : récupération, capacité, couleurs du projet, recharge.</p>
                <button
                    disabled={busy || view?.mode !== 'local-fake' || !view.bound}
                    onClick={() =>
                        void action(async () => {
                            const result = await engineHttp.post<{ proposals: Proposal[] }>('/connector/policy', {
                                enabled: {
                                    'energy-pack': enabled,
                                    'max-energy': enabled,
                                    'regen-speed': enabled,
                                    'color-unlock': enabled,
                                },
                                priority: ['regen-speed', 'max-energy', 'color-unlock', 'energy-pack'],
                                targetCapacity: capacity,
                                requiredColors: [],
                                maxBudget: budget,
                                minimumReserve: reserve,
                            });
                            setProposals(result.data.proposals);
                        })
                    }
                >
                    Calculer les propositions
                </button>
                <ul>
                    {proposals.map((p) => (
                        <li key={p.proposal.id}>
                            {kindLabels[p.proposal.kind]} — coût {number(p.proposal.cost)}, bénéfice :{' '}
                            {p.proposal.benefit}, gain estimé {number(p.proposal.savedMs)} ms.{' '}
                            {p.allowed
                                ? 'Proposable ; confirmation requise pour toute dépense future.'
                                : p.reasons.join(', ')}
                        </li>
                    ))}
                </ul>
            </details>
            </div>
            {view?.error && <p role="status">Canal : {view.error}</p>}
        </section>
    );
}
