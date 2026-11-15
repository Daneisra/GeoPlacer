import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '../ui';
import { UPGRADE_LABELS, engineHttp, errorCode, formatDuration, formatTime, rgbHex, type EngineStatus, type ResourcesView, type UpgradeProposal } from '../../lib/engine';
import { useCommand } from './useCommand';

const BENEFITS: Record<string, string> = {
  'enables-estimate': 'rend l’estimation possible',
  'reduces-eta': 'réduit le temps restant',
  'no-measurable-benefit': 'sans gain mesurable',
  'not-evaluable': 'non évaluable',
};

function proposalTitle(p: UpgradeProposal): string {
  return `${UPGRADE_LABELS[p.kind]}${p.color === null ? '' : ` ${rgbHex(p.color)}`}`;
}

/**
 * Resources of the SIMULATED agent and the upgrade proposals of the
 * UpgradePlanner (computed on the server). Nothing is ever bought
 * automatically: each upgrade needs an explicit confirmation and changes
 * only the local simulated world.
 */
export function ResourcesPanel({ status }: { status: EngineStatus | null }) {
  const { pending, run } = useCommand();
  const [view, setView] = useState<ResourcesView | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const refresh = useCallback(
    (): Promise<void> =>
      engineHttp.get<ResourcesView>('/resources').then(
        (r) => {
          setView(r.data);
          setUnavailable(null);
        },
        () => setUnavailable('Ressources indisponibles.')
      ),
    []
  );
  const state = status?.state;
  const revision = status?.selection?.revision;
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    return () => clearInterval(timer);
  }, [refresh, state, revision]);

  const writing = state === 'running' || state === 'initializing' || state === 'waiting-resources' || state === 'waiting-reconciliation';
  const apply = async (p: UpgradeProposal) => {
    const text = `Appliquer l’amélioration simulée « ${proposalTitle(p)} » pour ${p.cost ?? '?'} unités de monnaie simulée ?\n\nElle ne modifie que l’état local de la simulation (aucun achat réel).`;
    if (!window.confirm(text)) return;
    const done = await run(
      'Amélioration simulée',
      async () => {
        try {
          const r = await engineHttp.post<{ resources: ResourcesView }>('/resources/upgrades', { proposalId: p.id, confirm: true });
          setView(r.data.resources);
        } catch (error) {
          if (errorCode(error) === 'STALE_PROPOSAL') await refresh();
          throw error;
        }
      },
      `${proposalTitle(p)} appliquée à l’agent simulé.`
    );
    return done;
  };

  return (
    <Card id="resourcesPanel">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Ressources de l’agent simulé</CardTitle>
        <p className="text-xs text-muted-foreground">Valeurs de la simulation locale ({view?.agent ?? '—'}), lues à {formatTime(view?.observedAt)}.</p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {unavailable !== null && <p className="text-red-300">{unavailable}</p>}
        {view !== null && (
          <>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              <div>Énergie : <b className="tabular-nums">{view.energy} / {view.capacity}</b></div>
              <div>Régénération : 1 toutes les {formatDuration(view.regenIntervalMs)}</div>
              <div>Coût par pixel : {view.costPerPixel}</div>
              <div>Monnaie simulée : <b className="tabular-nums">{view.currency}</b></div>
              <div>Énergie suivante : {view.nextEnergyAt === null ? 'pleine' : formatTime(view.nextEnergyAt)}</div>
              <div>Niveaux : capacité {view.upgrades.maxEnergy}, régénération {view.upgrades.regenSpeed}, recharges {view.upgrades.energyPacks}</div>
            </div>
            <div>
              <div className="mb-1 text-muted-foreground">Couleurs disponibles ({view.unlockedColors.length})</div>
              <div className="flex flex-wrap gap-1">
                {view.unlockedColors.map((c) => (
                  <span key={c} title={rgbHex(c)} className="h-4 w-4 rounded-sm border" style={{ background: rgbHex(c) }} />
                ))}
              </div>
              {view.lockedColors.length > 0 && (
                <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  Verrouillées :
                  {view.lockedColors.map((c) => (
                    <span key={c.color} title={`${rgbHex(c.color)} — ${c.cost}`} className="h-4 w-4 rounded-sm border opacity-40" style={{ background: rgbHex(c.color) }} />
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="mb-1 font-medium">Améliorations simulables</div>
              {view.proposalsUnavailable !== null && <p className="text-muted-foreground">{view.proposalsUnavailable}</p>}
              {writing && <p className="text-xs text-yellow-300">Mettez la simulation en pause ou arrêtez-la pour appliquer une amélioration.</p>}
              <ul className="space-y-1" id="upgradeList">
                {view.proposals.slice(0, 12).map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1">
                    <span>
                      {p.recommended && <span className="mr-1 text-green-400">★</span>}
                      {proposalTitle(p)} · coût {p.cost ?? '—'} · {BENEFITS[p.benefit] ?? p.benefit}
                      {p.savedMs !== null && p.savedMs > 0 && <span className="text-green-300"> (−{formatDuration(p.savedMs)})</span>}
                      {!p.possible && <span className="text-xs text-muted-foreground"> — {p.impossible.map((i) => i.message).join(' ; ')}</span>}
                    </span>
                    <Button size="sm" variant="outline" disabled={!p.possible || writing || pending !== null} onClick={() => void apply(p)}>
                      Appliquer…
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
