import { lazy, Suspense, useEffect, useState } from 'react';
import { engineHttp } from '../lib/engine';
import { useNavigate } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardDescription } from './ui';
import { SimulationDashboard } from './simulation/SimulationDashboard';
const ConnectorDashboard = lazy(() => import('./geopixels/ConnectorDashboard').then(m => ({ default: m.ConnectorDashboard })));

export default function MainView() {
  const navigate = useNavigate();
  const [source, setSource] = useState<'simulation' | 'geopixels' | null>(null);
  const [sourceError, setSourceError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    void engineHttp.get<{ mode: 'simulation' | 'geopixels' }>('/engine/status', { signal: abort.signal }).then((r) => setSource(r.data.mode)).catch(() => { if (!abort.signal.aborted) setSourceError('Source indisponible'); });
    return () => abort.abort();
  }, []);
  async function changeSource(next: 'simulation' | 'geopixels') {
    setSourceError('');
    try { await engineHttp.post('/connector/source', { source: next }); setSource(next); }
    catch { setSourceError('Arrêter le moteur et réconcilier les tentatives ouvertes avant de changer de source.'); }
  }

  const quickActions = [
    {
      title: 'Journaux',
      description: 'Journaux et erreurs du serveur',
      icon: '/icons/code.svg',
      path: '/logs',
      color: 'border-orange-500',
    },
    {
      title: 'Paramètres hérités',
      description: 'Réglages de l’ancien Wplacer (sans effet sur la simulation)',
      icon: '/icons/settings.svg',
      path: '/settings',
      color: 'border-gray-500',
    },
  ];

  return (
    <>
      <h1 className="text-3xl font-bold">Tableau de bord</h1>
      <p className="text-muted-foreground mb-4">Préparation locale, simulation et connecteur GeoPixels expérimental.</p>
      <label className="block mb-4">Source de toile <select className="canvas-source-select" aria-label="Source de toile" value={source ?? ''} onChange={(e) => void changeSource(e.target.value as 'simulation' | 'geopixels')}>
        <option value="" disabled>Chargement…</option><option value="simulation">Simulation locale</option><option value="geopixels">GeoPixels — connecteur expérimental</option>
      </select></label>
      {sourceError && <p role="alert">{sourceError}</p>}
      {source === 'simulation' && <SimulationDashboard />}
      {source === 'geopixels' && <Suspense fallback={<p>Chargement du connecteur…</p>}><ConnectorDashboard /></Suspense>}
      <h2 className="mt-8 mb-3 text-xl font-semibold">Autres pages</h2>
      <div className="grid grid-cols-2 gap-4">
        {quickActions.map((action) => (
          <Card
            key={action.path}
            className="cursor-pointer transition-all hover:shadow-md hover:scale-105"
            onClick={() => navigate(action.path)}
          >
            <CardHeader>
              <div className={`border-l-4 ${action.color} pl-3`}>
                <div className="flex items-center gap-3 mb-2">
                  <img 
                    src={action.icon} 
                    alt="" 
                    className="w-8 h-8"
                  />
                  <CardTitle>{action.title}</CardTitle>
                </div>
              </div>
              <CardDescription className="pl-3">{action.description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </>
  );
}
