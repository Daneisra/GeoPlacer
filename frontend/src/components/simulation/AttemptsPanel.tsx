import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui';
import { engineHttp, formatTime, type AttemptSummary, type EngineStatus } from '../../lib/engine';

interface OpenAttempt {
  attemptId: string;
  state: string;
  pixels: number;
  leasedAt: number;
  startedAt: number | null;
}

const STATE_LABELS: Record<string, string> = {
  leased: 'Réservée',
  started: 'Envoyée',
  'needs-reconciliation': 'À réconcilier',
  finished: 'Terminée',
  failed: 'Échouée',
  cancelled: 'Annulée',
};

/** The work queue: attempts in flight (from the journal) and the latest closed ones (from the events). */
export function AttemptsPanel({ recent }: { status: EngineStatus | null; recent: readonly AttemptSummary[] }) {
  const [open, setOpen] = useState<OpenAttempt[]>([]);
  // Read every 3 s, on a timer that status events never reset (they come up to 4 times per second and
  // open attempts come and go at every batch): the server's rate limit is shared by all tabs.
  useEffect(() => {
    let cancelled = false;
    const read = () =>
      engineHttp
        .get<{ open: OpenAttempt[] }>('/engine/attempts')
        .then((r) => {
          if (!cancelled) setOpen(r.data.open);
        })
        .catch(() => undefined);
    void read();
    const timer = setInterval(() => void read(), 3_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return (
    <Card id="attemptsPanel">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Tâches et tentatives</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <div className="mb-1 font-medium">En cours ({open.length})</div>
          {open.length === 0 ? (
            <p className="text-muted-foreground">Aucune tentative ouverte.</p>
          ) : (
            <ul className="space-y-1">
              {open.map((a) => (
                <li key={a.attemptId} className="font-mono text-xs">
                  {STATE_LABELS[a.state] ?? a.state} · {a.pixels} px · réservée à {formatTime(a.leasedAt)}
                  {a.state === 'needs-reconciliation' && <span className="text-yellow-300"> · attend une lecture qui la couvre</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="mb-1 font-medium">Dernières tentatives closes</div>
          {recent.length === 0 ? (
            <p className="text-muted-foreground">Aucune pour l’instant.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left font-normal">Heure</th>
                  <th className="text-left font-normal">État</th>
                  <th className="text-right font-normal">Pixels</th>
                  <th className="text-right font-normal">Posés</th>
                </tr>
              </thead>
              <tbody>
                {recent.slice(0, 12).map((a) => (
                  <tr key={`${a.attemptId}:${a.state}`}>
                    <td>{formatTime(a.at)}</td>
                    <td>{STATE_LABELS[a.state] ?? a.state}</td>
                    <td className="text-right tabular-nums">{a.pixels}</td>
                    <td className="text-right tabular-nums">{a.applied}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
