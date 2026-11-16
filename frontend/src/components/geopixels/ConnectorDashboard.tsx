import { useEffect, useState } from 'react';
import './ConnectorDashboard.css';
import { STATE_LABELS } from '../../lib/engine';
import { translateReason } from '../../lib/i18n';
import { engineHttp, type TemplateInfo } from '../../lib/engine';

type View = {
  connected: boolean;
  mode: 'read-only' | 'local-fake' | null;
  session: string;
  bound: boolean;
  project: { id: string; width: number; height: number; gridX: number; gridY: number } | null;
  selection: TemplateInfo | null;
  lastSync: number | null;
  freshness: string;
  resourcesStale: boolean;
  error: string | null;
  resources: { energy: number | null; capacity: number | null; currency: number | null } | null;
  progress: { correct: number; incorrect: number; unknown: number; total: number } | null;
  scheduler: { state: string; reason: string | null; openAttempts: number; uncertainAttempts: string[] } | null;
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

export function ConnectorDashboard() {
  const [view, setView] = useState<View | null>(null);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [error, setError] = useState('');
  const [capability, setCapability] = useState('');
  const [busy, setBusy] = useState(false);
  const [budget, setBudget] = useState(100);
  const [reserve, setReserve] = useState(50);
  const [capacity, setCapacity] = useState(100);
  const [enabled, setEnabled] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await engineHttp.get<View>('/connector/status', { signal: abort.signal });
        if (!abort.signal.aborted) setView(response.data);
      } catch {
        if (!abort.signal.aborted) setError('État du connecteur indisponible');
      }
      if (!abort.signal.aborted) timer = setTimeout(poll, 1500);
    };
    void poll();
    void engineHttp
      .get<{ templates: TemplateInfo[] }>('/templates', { signal: abort.signal })
      .then((r) => setTemplates(r.data.templates))
      .catch(() => {});
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, []);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      setView((await engineHttp.get<View>('/connector/status')).data);
    } catch (e) {
      const message = (e as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message;
      setError(message ?? 'Commande refusée');
    } finally {
      setBusy(false);
    }
  }
  const active = !!view?.scheduler && !['stopped', 'completed', 'error'].includes(view.scheduler.state);
  async function pair(mode: 'local-fake' | 'read-only') {
    const origin = mode === 'local-fake' ? location.origin : 'https://www.geopixels.net';
    const result = await engineHttp.post<{ token: string }>('/connector/pair', { mode, origin });
    setCapability(result.data.token);
    // The one-use capability stays in component memory, never in an URL or browser storage.
  }
  return (
    <section className="connector-dashboard space-y-4" id="connectorDashboard">
      <div className="rounded border border-amber-500 bg-amber-950/40 p-4">
        <h2 className="text-xl font-semibold">GeoPixels — connecteur expérimental</h2>
        <p>
          {view?.mode === 'local-fake'
            ? 'Fournisseur factice local : écritures synthétiques uniquement.'
            : 'Observation du cache navigateur en lecture seule. Placement et achats réels indisponibles.'}
        </p>
        <p>
          Connexion : <strong id="connectorConnection">{view?.connected ? 'Connecté' : 'Déconnecté'}</strong> · Session :{' '}
          {view?.session === 'present' ? 'Présente (identité non transmise)' : 'Indisponible'}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button disabled={busy || active} onClick={() => void action(() => pair('local-fake'))}>
          Coupler un navigateur factice
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void action(async () => {
              await engineHttp.post('/connector/revoke', {});
              setCapability('');
            })
          }
        >
          Révoquer le canal
        </button>
        <a href="/connector-fixture.html" target="_blank" rel="noreferrer">
          Ouvrir la page factice
        </a>
        <button disabled={busy || active} onClick={() => void action(() => pair('read-only'))}>
          Coupler le lecteur GeoPixels
        </button>
        <a href="/geopixels-connector.user.js" download>
          Télécharger le lecteur Tampermonkey
        </a>
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
      <div className="rounded border p-4 space-y-2">
        <h3 className="font-semibold">Lier explicitement le modèle local au modèle du navigateur</h3>
        <p>
          Vérifier l’image, les dimensions, les filtres et la position avant de lier. Une taille identique ne prouve pas une image
          identique.
        </p>
        <label>
          Modèle local{' '}
          <select
            aria-label="Modèle local"
            disabled={busy || active}
            value={view?.selection?.templateId ?? ''}
            onChange={(e) => void action(() => engineHttp.put('/engine/selection', { templateId: e.target.value }))}
          >
            <option value="" disabled>
              Sélectionner
            </option>
            {templates.map((t) => (
              <option key={t.templateId} value={t.templateId}>
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
          disabled={busy || active || !view?.connected || !view?.selection}
          onClick={() => void action(() => engineHttp.post('/connector/bind', {}))}
        >
          Lier ce modèle
        </button>
        <p>{view?.bound ? 'Modèle lié' : 'Liaison nécessaire'}</p>
      </div>
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
          <p>Dernière réception : {view?.lastSync ? new Date(view.lastSync).toLocaleTimeString('fr-FR') : 'Aucune'}</p>
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
          <p>{view?.resourcesStale ? 'Ressources indisponibles, anciennes ou non datées.' : 'Observation datée'}</p>
          <p>
            État du moteur : <strong id="connectorState" data-state={view?.scheduler?.state ?? 'stopped'}>{STATE_LABELS[(view?.scheduler?.state ?? 'stopped') as keyof typeof STATE_LABELS]}</strong>
          </p>
          <p>{translateReason(view?.scheduler?.reason ?? null)}</p>
          <p>Tentatives incertaines : {view?.scheduler?.uncertainAttempts.length ?? 0}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          disabled={busy || active || !view?.bound || view.mode !== 'local-fake' || view.resourcesStale}
          onClick={() => void action(() => engineHttp.post('/engine/start', {}))}
        >
          Démarrer le fournisseur factice
        </button>
        <button disabled={busy || !active} onClick={() => void action(() => engineHttp.post('/engine/pause', {}))}>
          Pause
        </button>
        <button
          disabled={busy || view?.scheduler?.state !== 'paused'}
          onClick={() => void action(() => engineHttp.post('/engine/resume', {}))}
        >
          Reprendre
        </button>
        <button disabled={busy || !active} onClick={() => void action(() => engineHttp.post('/engine/stop', { abort: true }))}>
          Arrêter
        </button>
      </div>
      <details className="rounded border p-4">
        <summary>Politique d’améliorations — propositions factices</summary>
        <p>Les coûts et bénéfices proviennent du moteur existant et des règles synthétiques. Aucun achat disponible.</p>
        <label>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Activer les propositions d’améliorations
        </label>
        <label>
          Budget maximal <input type="number" min="0" value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
        </label>
        <label>
          Réserve minimale <input type="number" min="0" value={reserve} onChange={(e) => setReserve(Number(e.target.value))} />
        </label>
        <label>
          Capacité ciblée <input type="number" min="0" value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} />
        </label>
        <p>Priorité : récupération, capacité, couleurs du projet, recharge.</p>
        <button
          disabled={busy || view?.mode !== 'local-fake' || !view.bound}
          onClick={() =>
            void action(async () => {
              const result = await engineHttp.post<{ proposals: Proposal[] }>('/connector/policy', {
                enabled: { 'energy-pack': enabled, 'max-energy': enabled, 'regen-speed': enabled, 'color-unlock': enabled },
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
              {kindLabels[p.proposal.kind]} — coût {number(p.proposal.cost)}, bénéfice : {p.proposal.benefit}, gain estimé{' '}
              {number(p.proposal.savedMs)} ms.{' '}
              {p.allowed ? 'Proposable ; confirmation requise pour toute dépense future.' : p.reasons.join(', ')}
            </li>
          ))}
        </ul>
      </details>
      {view?.error && <p role="status">Canal : {view.error}</p>}
    </section>
  );
}
