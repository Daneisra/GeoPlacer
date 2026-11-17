import type { ObservationRegion } from './RegionalObservations';type Counts = { total: number; correct: number; incorrect: number; unknown: number };
type Capture = {
    id: string;
    projectKey: string;
    capturedAt: number;
    receivedAt: number;
    sourceObservedAt: number | null;
    total: number;
    known: number;
    unknown: number;
    transparent: number;
    changedKnown: number;
    newlyKnown: number;
    becameUnknown: number;
    unchanged: number;
    durationMs: number;
    regionCount: number;
    regionId?: string;
  captureRegion?: {id:string;x:number;y:number;width:number;height:number;revision:number};
    regions: { x: number; y: number; width: number; height: number }[];
};
export type Monitoring = {
    at: number;
    regionalSupported: boolean;
    configuredRegions: ObservationRegion[];
    activeRegionId: string | null;
    usage: { bytes: number; envelopes: number; completed: number; aborted: number };
    state: 'running' | 'paused' | 'stopped';
    acknowledged: string;
    pending: boolean;
    supported: boolean;
    intervalMs: number;
    reason: string | null;
    inFlight: boolean;
    lastReceivedAt: number | null;
    lastCapture: Capture | null;
    history: (Capture & { templateId: string | null; progress: Counts | null })[];
    events: { at: number; code: string; message: string }[];
};
const n = (v: number) => v.toLocaleString('fr-FR');
const time = (v: number | null) => (v === null ? 'Indisponible' : new Date(v).toLocaleTimeString('fr-FR'));
const stateLabels = { running: 'Active', paused: 'En pause', stopped: 'Arrêtée' };

export function ObservationSupervision({
    monitoring: m,
    progress,
    enabled,
    busy,
    interval,
    onInterval,
    onCommand,
}: {
    monitoring: Monitoring;
    progress: Counts | null;
    enabled: boolean;
    busy: boolean;
    interval: number;
    onInterval: (seconds: number) => void;
    onCommand: (action: 'start' | 'pause' | 'resume' | 'stop') => void;
}) {
    const c = m.lastCapture;
    const last = m.history[m.history.length - 1];
    const series = m.history
        .filter(
            (p) =>
                p.projectKey === last?.projectKey && p.templateId === last?.templateId && p.regionId === last?.regionId && JSON.stringify(p.captureRegion) === JSON.stringify(last?.captureRegion)
        )
        .slice(-60);
    const complete = progress !== null && progress.total > 0 && progress.unknown === 0;
    return (
        <section className="observation-supervision" aria-labelledby="observationTitle">
            <div className="observation-heading">
                <div>
                    <h3 id="observationTitle">Surveillance du cache GeoPixels</h3>
                    <p>Lecture seule · un modèle actif · aucune récupération de tuiles.</p>
                </div>
                <strong id="monitorState" data-state={m.state}>
                    {stateLabels[m.state]}
                    {m.pending ? ' — confirmation du lecteur attendue' : ''}
                </strong>
            </div>
            <div className="observation-controls">
                <label>
                    Pause entre captures (secondes)
                    <input
                        aria-label="Cadence de surveillance"
                        type="number"
                        min="5"
                        max="60"
                        value={interval}
                        disabled={busy || m.state !== 'stopped'}
                        onChange={(e) => onInterval(Number(e.target.value))}
                    />
                </label>
                <button
                    disabled={busy || !enabled || !m.supported || m.state !== 'stopped'}
                    onClick={() => onCommand('start')}
                >
                    Démarrer la surveillance
                </button>
                <button disabled={busy || !enabled || m.state !== 'running'} onClick={() => onCommand('pause')}>
                    Mettre la surveillance en pause
                </button>
                <button disabled={busy || !enabled || m.state !== 'paused'} onClick={() => onCommand('resume')}>
                    Reprendre la surveillance
                </button>
                <button disabled={busy || !m.supported || m.state === 'stopped'} onClick={() => onCommand('stop')}>
                    Arrêter la surveillance
                </button>
            </div>
            {!m.supported && <p>Installer le lecteur 0.4.0 ou ultérieur, le coupler et lier le modèle pour surveiller.</p>}
            {m.inFlight && (
                <p role="status">
                    Capture en cours. Les commandes de pause et d’arrêt interrompent la capture entre deux bandes
                    acquittées.
                </p>
            )}
            {m.reason && <p role="status">{m.reason}</p>}
            <p className="source-freshness">
                Fraîcheur source :{' '}
                {c?.sourceObservedAt != null
                    ? `date déclarée ${time(c.sourceObservedAt)} ; âge ${n(Math.max(0, Math.floor((m.at - c.sourceObservedAt) / 1000)))} s`
                    : 'non vérifiée — relire le même cache ne prouve aucune actualisation de GeoPixels.'}
            </p>
            <dl className="observation-metrics">
                <div>
                    <dt>Dernière réception</dt>
                    <dd id="observationReceivedAt">{time(m.lastReceivedAt)}</dd>
                </div>
                <div>
                    <dt>Début de capture complète</dt>
                    <dd>{time(c?.capturedAt ?? null)}</dd>
                </div>
                <div>
                    <dt>Âge de la capture</dt>
                    <dd>{c ? `${n(Math.max(0, Math.floor((m.at - c.capturedAt) / 1000)))} s` : 'Indisponible'}</dd>
                </div>
                <div>
                    <dt>Couverture des cibles</dt>
                    <dd id="observationCoverage">
                        {progress
                            ? `${n(progress.correct + progress.incorrect)} / ${n(progress.total)}`
                            : 'Liaison nécessaire'}
                    </dd>
                </div>
                <div>
                    <dt>Progression du cache observé</dt>
                    <dd id="observedProgressPercent">
                        {complete
                            ? `${((progress.correct * 100) / progress.total).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`
                            : 'Indéterminée : couverture incomplète'}
                    </dd>
                </div>
                <div>
                    <dt>Captures conservées</dt>
                    <dd id="observationHistoryCount">{n(m.history.length)} / 120</dd>
                </div>
            </dl>
            {c && (
                <>
                    <p>
                        Dernière capture complète : {n(c.known)} valeurs connues (dont {n(c.transparent)}{' '}
                        transparentes), {n(c.unknown)} inconnues, sur {n(c.total)} positions. Durée de réception :{' '}
                        {n(c.durationMs)} ms.
                    </p>
                    <p id="observationChanges">
                        Changements de valeurs connues : {n(c.changedKnown)} · devenues connues : {n(c.newlyKnown)} ·
                        devenues inconnues : {n(c.becameUnknown)} · identiques : {n(c.unchanged)}.
                    </p>
                    <details>
                        <summary>Rectangles parcourus ({n(c.regionCount)})</summary>
                        <p>
                            Coordonnées natives ; ces rectangles peuvent contenir des tuiles absentes et des pixels
                            inconnus.
                        </p>
                        <ul>
                            {c.regions.slice(0, 8).map((r, i) => (
                                <li key={i}>
                                    ({n(r.x)}, {n(r.y)}) · {n(r.width)} × {n(r.height)}
                                </li>
                            ))}
                        </ul>
                        {c.regions.length > 8 && (
                            <p>Les {n(c.regions.length - 8)} autres bandes sont agrégées dans les compteurs.</p>
                        )}
                    </details>
                </>
            )}
            {series.filter((p) => p.progress && p.progress.total > 0 && p.progress.unknown === 0).length >= 2 && (
                <figure>
                    <svg viewBox="0 0 600 110" role="img" aria-labelledby="observationChartTitle">
                        <title id="observationChartTitle">
                            Évolution des captures à couverture complète du même projet et du même modèle local
                        </title>
                        <path d="M10 5V100H590" fill="none" stroke="#64748b" />
                        {series.map((p, i) => {
                            const before = series[i - 1];
                            if (
                                !i ||
                                !p.progress ||
                                p.progress.unknown ||
                                !p.progress.total ||
                                !before?.progress ||
                                before.progress.unknown ||
                                !before.progress.total
                            )
                                return null;
                            return (
                                <line
                                    key={p.id}
                                    x1={10 + ((i - 1) * 580) / (series.length - 1)}
                                    y1={100 - (95 * before.progress.correct) / before.progress.total}
                                    x2={10 + (i * 580) / (series.length - 1)}
                                    y2={100 - (95 * p.progress.correct) / p.progress.total}
                                    stroke="#38bdf8"
                                    strokeWidth="2"
                                />
                            );
                        })}
                    </svg>
                    <figcaption>
                        Conformité du cache, de 0 à 100 %. Les captures incomplètes interrompent la courbe ; la
                        fraîcheur réelle reste indiquée séparément.
                    </figcaption>
                </figure>
            )}
            <p>
                Observations reçues : {n(m.usage?.envelopes ?? 0)} bandes, {n(m.usage?.bytes ?? 0)} octets JSON ;{' '}
                {n(m.usage?.aborted ?? 0)} captures interrompues. Le total est un assemblage de pixels datés
                individuellement, jamais un instantané atomique.
            </p>
            <details>
                <summary>Historique d’avancement ({n(m.history.length)})</summary>
                <div className="observation-table">
                    <table>
                        <thead>
                            <tr>
                                <th>Région</th>
                                <th>Capture</th>
                                <th>Réception</th>
                                <th>Corrects</th>
                                <th>Incorrects</th>
                                <th>Inconnus</th>
                                <th>Valeurs modifiées</th>
                                <th>Source</th>
                            </tr>
                        </thead>
                        <tbody>
                            {m.history
                                .slice(-12)
                                .reverse()
                                .map((p) => (
                                    <tr key={p.id}>
                                        <td>{p.regionId ?? 'Modèle entier'}</td>
                                        <td>{time(p.capturedAt)}</td>
                                        <td>{time(p.receivedAt)}</td>
                                        <td>{p.progress ? n(p.progress.correct) : 'Non lié'}</td>
                                        <td>{p.progress ? n(p.progress.incorrect) : 'Non lié'}</td>
                                        <td>{p.progress ? n(p.progress.unknown) : n(p.unknown)}</td>
                                        <td>{n(p.changedKnown)}</td>
                                        <td>{p.sourceObservedAt === null ? 'Non datée' : time(p.sourceObservedAt)}</td>
                                    </tr>
                                ))}
                        </tbody>
                    </table>
                </div>
                <p>
                    Historique local des 120 dernières captures complètes ; aucune autorisation ou surveillance active
                    n’est restaurée au redémarrage.
                </p>
            </details>
            <details>
                <summary>Événements et interruptions</summary>
                <ul>
                    {m.events
                        .slice()
                        .reverse()
                        .map((e, i) => (
                            <li key={`${e.at}-${i}`}>
                                {time(e.at)} — {e.message}
                            </li>
                        ))}
                </ul>
            </details>
        </section>
    );
}
