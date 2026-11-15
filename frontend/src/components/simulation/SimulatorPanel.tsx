import { useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '../ui';
import { engineHttp, errorCode, type EngineSettings, type EngineStatus } from '../../lib/engine';
import { applyStatus } from '../../hooks/useEngine';
import { useCommand } from './useCommand';

type Editable = {
  width: number;
  height: number;
  costPerPixel: number;
  capacity: number;
  regenIntervalMs: number;
  writeLatencyMs: number;
  startEnergy: number;
  startCurrency: number;
  maxBatchSize: number;
  minBatchSize: number;
};

const LABELS: Record<keyof Editable, string> = {
  width: 'Largeur de la toile',
  height: 'Hauteur de la toile',
  costPerPixel: 'Coût par pixel',
  capacity: 'Capacité d’énergie',
  regenIntervalMs: 'Régénération (ms par unité)',
  writeLatencyMs: 'Latence d’écriture (ms)',
  startEnergy: 'Énergie de départ',
  startCurrency: 'Monnaie de départ',
  maxBatchSize: 'Lot maximal (pixels)',
  minBatchSize: 'Lot minimal (pixels)',
};

function editable(s: EngineSettings): Editable {
  return { ...s.simulator, ...s.agent, ...s.run };
}

/** Simulator settings, explicit resets, external actor, journal diagnosis and compaction. */
export function SimulatorPanel({ status }: { status: EngineStatus | null }) {
  const { pending, run } = useCommand();
  const [edits, setEdits] = useState<Partial<Editable>>({});
  const [diagnosis, setDiagnosis] = useState<string | null>(null);
  const settings = status?.settings ?? null;
  const form: Editable | null = settings === null ? null : { ...editable(settings), ...edits };
  const idle = status !== null && (status.state === 'stopped' || status.state === 'completed' || status.state === 'error');

  const save = () =>
    run(
      'Réglages de la simulation',
      async () => {
        if (form === null) return;
        const body = {
          simulator: { width: form.width, height: form.height, costPerPixel: form.costPerPixel, capacity: form.capacity, regenIntervalMs: form.regenIntervalMs, writeLatencyMs: form.writeLatencyMs },
          agent: { startEnergy: form.startEnergy, startCurrency: form.startCurrency },
          run: { maxBatchSize: form.maxBatchSize, minBatchSize: form.minBatchSize },
        };
        try {
          const r = await engineHttp.put<{ status: EngineStatus }>('/simulator/settings', body);
          applyStatus(r.data.status);
          setEdits({});
        } catch (error) {
          if (errorCode(error) !== 'WORLD_RESET_REQUIRED') throw error;
          if (!window.confirm('Une nouvelle taille de toile ou de nouvelles règles exigent de réinitialiser le monde simulé : ses pixels et les ressources de l’agent simulé repartent de zéro (l’ancien monde est conservé à part, sur le disque). Continuer ?')) return;
          const r = await engineHttp.put<{ status: EngineStatus }>('/simulator/settings', { ...body, resetWorld: true });
          applyStatus(r.data.status);
          setEdits({});
        }
      },
      'Réglages enregistrés.'
    );

  const resetWorld = () => {
    const typed = window.prompt('Réinitialiser le monde simulé ? Tapez RESET pour confirmer (l’ancien monde est conservé à part).');
    if (typed === null) return;
    void run('Réinitialisation du monde simulé', async () => {
      const r = await engineHttp.post<{ status: EngineStatus }>('/simulator/reset', { confirm: typed });
      applyStatus(r.data.status);
    }, 'Monde simulé réinitialisé.');
  };

  const resetAgent = () => {
    if (!window.confirm('Remettre l’agent simulé à ses ressources de départ ?')) return;
    void run('Agent simulé', () => engineHttp.post('/simulator/agent/reset', {}), 'Agent remis à ses ressources de départ.');
  };

  const externalEdit = () =>
    run('Acteur extérieur simulé', () => engineHttp.post('/simulator/external-edit', { count: 25 }), 'Jusqu’à 25 pixels du modèle effacés : le moteur va les détecter et les repeindre.');

  const diagnose = () =>
    run('Diagnostic du journal', async () => {
      const r = await engineHttp.get<{ mode: string; diagnosis: { verdict?: string; stats?: { activeEvents: number }; problems?: string[] } }>('/journal/diagnosis');
      const d = r.data.diagnosis;
      setDiagnosis(r.data.mode === 'full' ? `Verdict : ${d.verdict ?? '?'}${(d.problems?.length ?? 0) > 0 ? ` — ${d.problems!.join(' ; ')}` : ''}` : `Simulation en cours : statistiques seulement (${d.stats?.activeEvents ?? '?'} événements actifs). Arrêtez pour un diagnostic complet.`);
    });

  const compact = () => run('Compactage', () => engineHttp.post('/journal/compact', {}), 'Journal compacté, toile simulée enregistrée (checkpoint).');

  const backup = () =>
    run('Sauvegarde', async () => {
      const r = await engineHttp.post<{ name: string; files: number }>('/backup', {});
      setDiagnosis(`Sauvegarde créée : sauvegardes\\${r.data.name} (${r.data.files} fichiers). Restauration : GeoPlacer arrêté, « npm run restore -- sauvegardes\\${r.data.name} ».`);
    }, 'Sauvegarde créée dans le dossier « sauvegardes ».');

  return (
    <Card id="simulatorPanel">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Simulateur</CardTitle>
        <p className="text-xs text-muted-foreground">
          Toile {status?.world.width}×{status?.world.height}, génération {status?.world.generation ?? '—'} · verrou : {status?.instance.lock} (garde : {status?.instance.guard})
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {form !== null && (
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(LABELS) as (keyof Editable)[]).map((k) => (
              <label key={k} className="space-y-1">
                <span className="text-xs text-muted-foreground">{LABELS[k]}</span>
                <input className="w-full rounded-md border bg-background px-2 py-1" type="number" min={0} value={form[k]} disabled={!idle} onChange={(e) => setEdits({ ...edits, [k]: Number(e.target.value) })} />
              </label>
            ))}
          </div>
        )}
        {!idle && <p className="text-xs text-muted-foreground">Arrêtez la simulation pour modifier les réglages.</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void save()} disabled={!idle || pending !== null}>
            Enregistrer
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void externalEdit()} disabled={pending !== null || status?.selection === null}>
            Simuler un acteur extérieur
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void diagnose()} disabled={pending !== null}>
            Diagnostic du journal
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void compact()} disabled={pending !== null || status?.journal.compacting === true}>
            Compacter
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void backup()} disabled={!idle || pending !== null} title="À l’arrêt seulement">
            Sauvegarder
          </Button>
          <Button size="sm" variant="outline" onClick={resetAgent} disabled={!idle || pending !== null}>
            Réinitialiser l’agent
          </Button>
          <Button size="sm" variant="destructive" onClick={resetWorld} disabled={!idle || pending !== null}>
            Réinitialiser le monde…
          </Button>
        </div>
        {diagnosis !== null && <p className="rounded border p-2 text-xs" id="journalDiagnosis">{diagnosis}</p>}
      </CardContent>
    </Card>
  );
}
