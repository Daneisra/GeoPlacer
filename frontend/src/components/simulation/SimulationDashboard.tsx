import { useEffect, useRef } from 'react';
import { useToast } from '../ui';
import { useEngine } from '../../hooks/useEngine';
import { translateError, translateNotice } from '../../lib/i18n';
import { AttemptsPanel } from './AttemptsPanel';
import { CanvasView } from './CanvasView';
import { DemoCard } from './DemoCard';
import { EngineControls } from './EngineControls';
import { EngineOverview } from './EngineOverview';
import { ResourcesPanel } from './ResourcesPanel';
import { SimulatorPanel } from './SimulatorPanel';
import { TemplatePanel } from './TemplatePanel';

/**
 * Dashboard of the new engine (Phase 1B.9). Everything shown here is a
 * LOCAL SIMULATION: no account, no session, no real service.
 */
export function SimulationDashboard() {
  const { status, connection, attempts, errors, notices } = useEngine();
  const toast = useToast();
  const seen = useRef(new Set<string>());

  // Engine errors and notices become notifications, once each.
  useEffect(() => {
    for (const e of [...errors].reverse()) {
      const key = `e:${e.at}:${e.code}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      toast.warning('Moteur', translateError(e.code, e.message));
    }
    for (const n of [...notices].reverse()) {
      const key = `n:${n.at}:${n.message}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      toast.info('Simulation', translateNotice(n.message));
    }
  }, [errors, notices, toast]);

  return (
    <div className="space-y-4" id="simulationDashboard">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-sky-700 bg-sky-950/60 px-4 py-2" id="simulationBanner">
        <div>
          <span className="mr-2 rounded bg-sky-600 px-2 py-0.5 text-xs font-bold tracking-wide text-white">SIMULATION LOCALE</span>
          <span className="text-sm">Toutes les données ci-dessous sont simulées : aucune connexion à un service réel, aucun compte.</span>
        </div>
        <span className={`text-xs ${connection === 'open' ? 'text-green-400' : 'text-yellow-300'}`} id="wsConnection">
          {connection === 'open' ? 'Temps réel connecté' : connection === 'connecting' ? 'Connexion…' : 'Déconnecté — reconnexion…'}
        </span>
      </div>
      <DemoCard status={status} />
      <EngineControls status={status} />
      <div className="grid gap-4 lg:grid-cols-2">
        <EngineOverview status={status} connection={connection} />
        <CanvasView status={status} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <TemplatePanel status={status} />
        <AttemptsPanel status={status} recent={attempts} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ResourcesPanel status={status} />
        <SimulatorPanel status={status} />
      </div>
    </div>
  );
}
