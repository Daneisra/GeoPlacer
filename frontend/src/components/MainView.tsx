import { lazy, Suspense, useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { engineHttp } from '../lib/engine';
import { navItems, type WorkspacePage } from '../navigation';
import { SimulationDashboard } from './simulation/SimulationDashboard';

const ConnectorDashboard = lazy(() =>
    import('./geopixels/ConnectorDashboard').then((m) => ({ default: m.ConnectorDashboard }))
);
type Source = 'simulation' | 'geopixels';
const workspace: Record<string, WorkspacePage> = {
    '/': 'dashboard',
    '/dessins': 'drawings',
    '/file': 'queue',
    '/ressources': 'resources',
    '/diagnostics': 'diagnostics',
    '/settings': 'settings',
};
const descriptions: Record<Exclude<WorkspacePage, 'other'>, string> = {
    dashboard: 'Préparez votre image, puis suivez le dessin sur la toile.',
    drawings: 'Retrouvez vos images, sélectionnez un dessin ou préparez un nouveau modèle.',
    queue: 'Suivez les tentatives en cours, leurs résultats et les opérations à réconcilier.',
    resources: 'Consultez les ressources disponibles et les améliorations du dessin.',
    diagnostics: 'Vérifiez la connexion, les observations et les opérations en attente.',
    settings: 'Réglez votre espace de travail et les options de la toile.',
};

export default function MainView() {
    const { pathname, search } = useLocation();
    const page = workspace[pathname] ?? 'other';
    const [source, setSource] = useState<Source | null>(null);
    const [changing, setChanging] = useState(false);
    const [sourceError, setSourceError] = useState('');
    useEffect(() => {
        const abort = new AbortController();
        void engineHttp
            .get<{ mode: Source }>('/engine/status', { signal: abort.signal })
            .then(({ data }) => setSource(data.mode))
            .catch(() => {
                if (!abort.signal.aborted) setSourceError('Source de toile indisponible.');
            });
        return () => abort.abort();
    }, []);

    async function changeSource(next: Source) {
        setSourceError('');
        setChanging(true);
        try {
            await engineHttp.post('/connector/source', { source: next });
            setSource(next);
        } catch {
            setSourceError('Arrêtez le moteur et réconciliez les tentatives ouvertes avant de changer de source.');
        } finally {
            setChanging(false);
        }
    }

    return (
        <>
            {page !== 'other' && (
                <div className="studio-page-heading">
                    <div>
                        <h1>{navItems.find((item) => item.path === pathname)?.label}</h1>
                        <p>{descriptions[page]}</p>
                    </div>
                    <label className="studio-source">
                        Source de toile
                        <select
                            aria-label="Source de toile"
                            value={source ?? ''}
                            disabled={changing || source === null}
                            onChange={(e) => void changeSource(e.target.value as Source)}
                        >
                            <option value="" disabled>
                                Chargement…
                            </option>
                            <option value="simulation">Simulation locale</option>
                            <option value="geopixels">GeoPixels — connecteur expérimental</option>
                        </select>
                    </label>
                </div>
            )}
            {sourceError && page !== 'other' && (
                <p className="studio-alert" role="alert">
                    {sourceError}
                </p>
            )}
            {page === 'drawings' && (
                <Link className="studio-link mb-3" to="/geopixels">
                    Préparer un PNG pour GeoPixels <ArrowUpRight size={16} aria-hidden="true" />
                </Link>
            )}
            {source === 'geopixels' && page === 'drawings' && new URLSearchParams(search).has('strategie') && (
                <div className="studio-entry">
                    <p>Cette stratégie s’applique à l’import en simulation locale.</p>
                    <button
                        className="studio-primary"
                        disabled={changing}
                        onClick={() => void changeSource('simulation')}
                    >
                        Passer à la simulation
                    </button>
                </div>
            )}
            {source === 'simulation' && page === 'dashboard' && (
                <div className="studio-entry">
                    <div>
                        <h2>Dessiner sur GeoPixels</h2>
                        <p>Importez votre PNG, couplez le lecteur, puis lancez le dessin.</p>
                    </div>
                    <button
                        className="studio-primary"
                        disabled={changing}
                        onClick={() => void changeSource('geopixels')}
                    >
                        Ouvrir le connecteur <ArrowUpRight size={17} aria-hidden="true" />
                    </button>
                </div>
            )}
            {source === 'simulation' && <SimulationDashboard page={page} />}
            {source === 'geopixels' && (
                <Suspense fallback={page === 'other' ? null : <p>Chargement du connecteur…</p>}>
                    <ConnectorDashboard page={page} />
                </Suspense>
            )}
            <Outlet />
        </>
    );
}
