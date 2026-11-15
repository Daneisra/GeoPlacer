import { useEffect, useState } from 'react';
import { Button } from '../ui';
import { engineHttp, type EngineStatus } from '../../lib/engine';
import { applyStatus } from '../../hooks/useEngine';
import { useCommand } from './useCommand';

interface Availability {
  available: boolean;
  reason: string | null;
  active: boolean;
}

/**
 * Demonstration (Phase 1B.10): offered on an EMPTY project only (it never
 * changes someone's data); otherwise, how to start it in its own directory.
 */
export function DemoCard({ status }: { status: EngineStatus | null }) {
  const { pending, run } = useCommand();
  const [demo, setDemo] = useState<Availability | null>(null);
  const selection = status?.selection?.templateId ?? null;
  const idle = status !== null && (status.state === 'stopped' || status.state === 'completed' || status.state === 'error');
  useEffect(() => {
    let cancelled = false;
    void engineHttp.get<Availability>('/demo').then(
      (r) => {
        if (!cancelled) setDemo(r.data);
      },
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, [selection, idle]);

  const setup = () =>
    run(
      'Démonstration',
      async () => {
        const r = await engineHttp.post<{ status: EngineStatus }>('/demo', {});
        applyStatus(r.data.status);
        setDemo({ available: false, reason: null, active: true });
      },
      'Démonstration prête : cliquez sur « Démarrer ».'
    );

  if (demo === null) return null;
  if (demo.active) {
    return (
      <div id="demoCard" className="rounded-md border border-emerald-700 bg-emerald-950/40 px-4 py-2 text-sm">
        <b>Démonstration</b> : modèle d’exemple chargé, ressources de démonstration (régénération rapide). « Démarrer » pour observer les pixels se placer, puis « Pause » et
        « Reprendre ». Données synthétiques, propres à ce dossier.
      </div>
    );
  }
  if (demo.available) {
    return (
      <div id="demoCard" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-emerald-700 bg-emerald-950/40 px-4 py-3 text-sm">
        <div>
          <b>Découvrir GeoPlacer : démonstration</b>
          <div className="text-muted-foreground">
            Charge un modèle d’exemple original (paysage, 96 × 64), règle une petite toile simulée et un agent simulé à régénération rapide (environ deux minutes).
            Ce projet est vide : rien d’existant n’est modifié.
          </div>
        </div>
        <Button onClick={() => void setup()} disabled={!idle || pending !== null} id="demoSetup">
          Préparer la démonstration
        </Button>
      </div>
    );
  }
  return (
    <details id="demoCard" className="rounded-md border px-4 py-2 text-sm">
      <summary className="cursor-pointer">Démonstration</summary>
      <p className="mt-1 text-muted-foreground">
        Ce projet contient déjà des données : la démonstration ne les modifie jamais. Pour la lancer dans un dossier séparé (<code>data\demo</code>), arrêtez GeoPlacer
        puis lancez <code>npm run demo</code>.
      </p>
    </details>
  );
}
