import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '../ui';
import { STRATEGY_LABELS, engineHttp, type EngineStatus, type TemplateInfo } from '../../lib/engine';
import { applyStatus } from '../../hooks/useEngine';
import { useCommand } from './useCommand';
import { useSearchParams } from 'react-router-dom';
import { DrawingGallery } from '../DrawingGallery';

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
}

const field = 'w-full rounded-md border bg-background px-2 py-1 text-sm';

/** Select or import a template of the simulation, choose its strategy and position, move it. */
export function TemplatePanel({ status, gallery = false }: { status: EngineStatus | null; gallery?: boolean }) {
  const { pending, run } = useCommand();
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [listingError, setListingError] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [x, setX] = useState(0);
  const [y, setY] = useState(0);
  const [query, setQuery] = useSearchParams();
  const requestedStrategy = query.get('strategie');
  const strategy = requestedStrategy && Object.prototype.hasOwnProperty.call(STRATEGY_LABELS, requestedStrategy) ? requestedStrategy : 'top-to-bottom';
  const selection = status?.selection ?? null;
  const running = status !== null && !status.commands.start && status.state !== 'stopped' && status.state !== 'completed' && status.state !== 'error';

  const refresh = useCallback(
    (): Promise<void> =>
      engineHttp.get<{ templates: TemplateInfo[] }>('/templates').then(
        (r) => { setTemplates(r.data.templates); setListingError(false); },
        () => setListingError(true)
      ),
    []
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const select = (templateId: string) =>
    run('Sélection du modèle', async () => {
      const r = await engineHttp.put<{ status: EngineStatus }>('/engine/selection', { templateId });
      applyStatus(r.data.status);
    });

  const importTemplate = () =>
    run(
      'Import du modèle',
      async () => {
        if (file === null) throw new Error('no file');
        const pngBase64 = await toBase64(file);
        const r = await engineHttp.post<TemplateInfo>('/templates', { name: name.trim() || file.name.replace(/\.png$/i, ''), pngBase64, x, y, strategy });
        await refresh();
        const s = await engineHttp.put<{ status: EngineStatus }>('/engine/selection', { templateId: r.data.templateId });
        applyStatus(s.data.status);
        setFile(null);
      },
      'Modèle importé et sélectionné.'
    );

  const move = (x: number, y: number) =>
    run('Déplacement du modèle', async () => {
      if (selection === null) return;
      await engineHttp.post(`/templates/${selection.templateId}/move`, { x, y });
    }, 'Nouvelle révision créée : l’ordonnanceur la suit.');

  const max = status?.settings.simulator;
  return (
    <div className="space-y-4">
    {gallery && (listingError ? <p className="studio-alert" role="alert">Galerie indisponible. <button onClick={() => void refresh()}>Réessayer</button></p> :
      <DrawingGallery templates={templates} selected={selection?.templateId} pending={pending !== null} disabled={running} onSelect={id => void select(id)} />)}
    <Card id="templatePanel">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Modèle</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-1">
          <label className="text-muted-foreground" htmlFor="templateSelect">Modèle sélectionné</label>
          <select id="templateSelect" className={field} value={selection?.templateId ?? ''} disabled={running || pending !== null} onChange={(e) => e.target.value !== '' && void select(e.target.value)}>
            <option value="">— choisir —</option>
            {templates?.map((t) => (
              <option key={t.templateId} value={t.templateId}>
                {t.name} ({t.width}×{t.height}, {t.paintablePixels} px, {STRATEGY_LABELS[t.strategy] ?? t.strategy})
              </option>
            ))}
          </select>
          {running && <p className="text-xs text-muted-foreground">Arrêtez la simulation pour changer de modèle.</p>}
        </div>
        {selection !== null && (
          <MoveForm key={`${selection.templateId}:${selection.revision}`} x={selection.placement?.x ?? 0} y={selection.placement?.y ?? 0} disabled={pending !== null} onMove={(x, y) => void move(x, y)} />
        )}
        <details id="simulation-import" open={requestedStrategy !== null || undefined}>
          <summary className="cursor-pointer">Importer un PNG</summary>
          <div className="mt-2 space-y-2">
            <input id="templateFile" type="file" accept="image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <input className={field} placeholder="Nom" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-muted-foreground">x (0 à {max?.width ?? '?'})</span>
                <input className={field} type="number" min={0} value={x} onChange={(e) => setX(Number(e.target.value))} />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">y (0 à {max?.height ?? '?'})</span>
                <input className={field} type="number" min={0} value={y} onChange={(e) => setY(Number(e.target.value))} />
              </label>
            </div>
            <select aria-label="Stratégie du modèle" className={field} value={strategy} onChange={(e) => setQuery(previous => {
              const next = new URLSearchParams(previous);
              next.set('strategie', e.target.value);
              return next;
            }, { replace: true, preventScrollReset: true })}>
              {Object.entries(STRATEGY_LABELS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">Les couleurs sont ramenées à la palette de démonstration de la simulation.</p>
            <Button size="sm" onClick={() => void importTemplate()} disabled={file === null || running || pending !== null}>
              Importer et sélectionner
            </Button>
          </div>
        </details>
      </CardContent>
    </Card>
    </div>
  );
}

/** Position of the selected template; a new revision gives a new form (key). */
function MoveForm({ x, y, disabled, onMove }: { x: number; y: number; disabled: boolean; onMove: (x: number, y: number) => void }) {
  const [moveX, setMoveX] = useState(x);
  const [moveY, setMoveY] = useState(y);
  return (
    <div className="grid grid-cols-3 items-end gap-2">
      <label className="space-y-1">
        <span className="text-muted-foreground">x</span>
        <input className={field} type="number" min={0} value={moveX} onChange={(e) => setMoveX(Number(e.target.value))} />
      </label>
      <label className="space-y-1">
        <span className="text-muted-foreground">y</span>
        <input className={field} type="number" min={0} value={moveY} onChange={(e) => setMoveY(Number(e.target.value))} />
      </label>
      <Button variant="secondary" size="sm" onClick={() => onMove(moveX, moveY)} disabled={disabled}>
        Déplacer
      </Button>
    </div>
  );
}
