import { createBrowserRouter, Navigate } from 'react-router-dom';
import App from './App';
import { Sidebar } from './components/Sidebar';
import MainView from './components/MainView';
import LogsViewer from './components/LogsViewer';
import Settings from './components/Settings';
import LegacyDisabled from './components/LegacyDisabled';

function Layout() {
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <App />
      </div>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      {
        index: true,
        element: <MainView />,
      },
      {
        path: 'logs',
        element: <LogsViewer />,
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
        path: 'settings',
        element: <Settings />,
      },
      {
        path: '*',
        element: <Navigate to="/" replace />,
      },
    ],
  },
]);

export const navItems = [
  { path: '/', label: 'Tableau de bord', icon: '/icons/icon.png' },
  { path: '/logs', label: 'Journaux', icon: '/icons/code.svg' },
  { path: '/settings', label: 'Paramètres hérités', icon: '/icons/settings.svg' },
];
