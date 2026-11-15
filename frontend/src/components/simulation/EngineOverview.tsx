import { Card, CardContent, CardHeader, CardTitle } from '../ui';
import { STATE_LABELS, formatDuration, formatTime, type EngineStatus } from '../../lib/engine';
import { translateError, translateEta, translateReason } from '../../lib/i18n';
import type { Connection } from '../../hooks/useEngine';

const STATE_COLORS: Record<string, string> = {
  running: 'bg-green-600',
  initializing: 'bg-blue-600',
  paused: 'bg-yellow-600',
  'waiting-resources': 'bg-orange-600',
  'waiting-reconciliation': 'bg-orange-600',
  completed: 'bg-emerald-700',
  error: 'bg-red-700',
  stopped: 'bg-gray-600',
};

function Stat({ label, value, id }: { label: string; value: string; id?: string }) {
  return (
    <div className="rounded-md border p-3" {...(id === undefined ? {} : { id })}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString('fr-FR'));

/** State, progress, energy and ETA of the simulation, as computed by the server. */
export function EngineOverview({ status, connection }: { status: EngineStatus | null; connection: Connection }) {
  if (status === null) {
    return (
      <Card>
        <CardContent className="p-6 text-muted-foreground">{connection === 'closed' ? 'Serveur injoignable : reconnexion…' : 'Connexion au moteur…'}</CardContent>
      </Card>
    );
  }
  const s = status.scheduler;
  const percent = s?.progressPercent ?? null;
  const etaText = s?.eta === null || s?.eta === undefined ? '—' : s.eta.durationMs !== null ? `${formatDuration(s.eta.durationMs)} (fin vers ${formatTime(s.eta.finishAt)})` : s.eta.unavailable.map((u) => translateEta(u.code, u.message)).join(' ; ') || '—';
  return (
    <Card id="engineOverview">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="text-xl">{status.selection?.name ?? 'Aucun modèle sélectionné'}</CardTitle>
          <span id="engineState" className={`rounded px-2 py-1 text-xs font-bold text-white ${STATE_COLORS[status.state] ?? 'bg-gray-600'}`}>
            {STATE_LABELS[status.state]}
          </span>
          {status.selection !== null && (
            <span className="text-xs text-muted-foreground">
              révision {status.selection.revision} · {status.selection.width}×{status.selection.height} · position ({status.selection.placement?.x}, {status.selection.placement?.y})
            </span>
          )}
        </div>
        {status.reason !== null && (
          <p className="text-sm text-muted-foreground" id="engineReason">
            {translateReason(status.reason)}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="mb-1 flex justify-between text-sm">
            <span>Progression</span>
            <span id="progressPercent" className="tabular-nums">{percent === null ? '—' : `${percent.toFixed(1)} %`}</span>
          </div>
          <div className="h-3 w-full overflow-hidden rounded bg-secondary">
            <div className="h-3 bg-green-600" style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Stat label="Pixels corrects" value={n(s?.correct)} id="statCorrect" />
          <Stat label="Pixels incorrects" value={n(s?.incorrect)} />
          <Stat label="Pixels inconnus" value={n(s?.unknown)} />
          <Stat label="Pixels restants (estimés)" value={n(s?.workPixels)} />
          <Stat label="Énergie de l’agent simulé" value={n(s?.energy)} />
          <Stat label="Prochaine disponibilité" value={s?.nextAvailabilityAt ? formatTime(s.nextAvailabilityAt) : '—'} />
          <Stat label="Tentatives en cours" value={n(status.journal.openAttempts)} />
          <Stat label="Dernière activité" value={formatTime(status.lastActivityAt)} />
        </div>
        <div className="text-sm">
          <span className="text-muted-foreground">Temps restant estimé : </span>
          <span id="etaText">{etaText}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          Pixels posés depuis le démarrage : {n(s?.applied)} · tentatives closes : {n(s?.attemptsClosed)} · cycles : {n(s?.cycles)}
        </div>
        {status.journal.toReconcileAtStart > 0 && (
          <p className="rounded border border-yellow-600 p-2 text-sm text-yellow-300">
            {status.journal.toReconcileAtStart} tentative(s) interrompue(s) au dernier arrêt : elles seront réconciliées par une lecture de la toile simulée au prochain démarrage, jamais renvoyées à l’aveugle.
          </p>
        )}
        {!status.world.available && (
          <p className="rounded border border-red-600 p-2 text-sm text-red-300">
            Toile simulée indisponible : {translateError(status.world.error?.code ?? '', status.world.error?.message ?? '')} Voir le guide de reprise.
          </p>
        )}
        {(s?.recentErrors.length ?? 0) > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-red-300">Erreurs récentes ({s!.recentErrors.length})</summary>
            <ul className="mt-1 space-y-1">
              {s!.recentErrors.slice(-8).reverse().map((e) => (
                <li key={`${e.at}-${e.code}`} className="font-mono text-xs">
                  {formatTime(e.at)} — {translateError(e.code, e.message)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
