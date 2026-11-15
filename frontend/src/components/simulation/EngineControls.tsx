import { Button } from '../ui';
import { engineHttp, type EngineStatus } from '../../lib/engine';
import { applyStatus } from '../../hooks/useEngine';
import { useCommand } from './useCommand';

/**
 * Start, pause, resume and stop of the NEW engine (local simulation). The
 * buttons offered are those the server says the current state allows:
 * no second start while a simulation runs. The inherited Wplace engine is
 * never involved.
 */
export function EngineControls({ status }: { status: EngineStatus | null }) {
  const { pending, run } = useCommand();
  const c = status?.commands ?? { start: false, pause: false, resume: false, stop: false };
  const command = (name: string, path: string, body: object = {}) =>
    run(name, async () => {
      const r = await engineHttp.post<{ changed: boolean; status: EngineStatus }>(path, body);
      applyStatus(r.data.status);
    });
  // Stops after the write in progress (its answer is awaited).
  const stop = () => void command('Arrêter', '/engine/stop', { abort: false });
  const abortStop = () => {
    if (window.confirm('Arrêter en interrompant l’écriture en cours ? La tentative sera réconciliée par une lecture de la toile simulée, jamais abandonnée.')) {
      void command('Arrêter (interrompre)', '/engine/stop', { abort: true });
    }
  };
  return (
    <div className="flex flex-wrap gap-2" id="engineControls">
      <Button onClick={() => void command('Démarrer', '/engine/start')} disabled={!c.start || pending !== null} title={c.start ? '' : status?.selection === null ? 'Sélectionnez un modèle' : 'Indisponible dans l’état actuel'}>
        Démarrer
      </Button>
      <Button variant="secondary" onClick={() => void command('Pause', '/engine/pause')} disabled={!c.pause || pending !== null}>
        Pause
      </Button>
      <Button variant="secondary" onClick={() => void command('Reprendre', '/engine/resume')} disabled={!c.resume || pending !== null}>
        Reprendre
      </Button>
      <Button variant="secondary" onClick={stop} disabled={!c.stop || pending !== null}>
        Arrêter
      </Button>
      <Button variant="outline" onClick={abortStop} disabled={!c.stop || pending !== null} title="Interrompt l’écriture en cours (réconciliée ensuite)">
        Arrêter maintenant
      </Button>
      {pending !== null && <span className="text-sm text-muted-foreground self-center">{pending}…</span>}
    </div>
  );
}
