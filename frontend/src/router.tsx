import { createBrowserRouter, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import MainView from './components/MainView';
import LogsViewer from './components/LogsViewer';
import LegacyDisabled from './components/LegacyDisabled';
import { GeoPixelsPage } from './components/geopixels/GeoPixelsPage';

export const router = createBrowserRouter([
    {
        path: '/',
        element: <Layout />,
        children: [
            {
                element: <MainView />,
                children: [
                    { index: true, element: null },
                    { path: 'dessins', element: null },
                    { path: 'modes', element: null },
                    { path: 'file', element: null },
                    { path: 'ressources', element: null },
                    { path: 'diagnostics', element: null },
                    { path: 'settings', element: null },
                    { path: 'geopixels', element: <GeoPixelsPage /> },
                    { path: 'logs', element: <LogsViewer /> },
                    {
                        path: 'settings/legacy',
                        lazy: async () => ({ Component: (await import('./components/Settings')).default }),
                    },
                ],
            },
            // Phase 1B.10: inherited pages of real accounts and of the inherited engine, disabled
            // (their server routes are refused too). The components stay in the code (traceability).
            {
                path: 'users',
                element: <LegacyDisabled page="Comptes (Users)" />,
            },
            {
                path: 'templates',
                children: [
                    {
                        index: true,
                        element: <LegacyDisabled page="Modèles de l’ancien moteur (Templates)" />,
                    },
                    {
                        path: 'add',
                        element: <LegacyDisabled page="Ajout d’un modèle de l’ancien moteur" />,
                    },
                ],
            },
            {
                path: '*',
                element: <Navigate to="/" replace />,
            },
        ],
    },
]);
