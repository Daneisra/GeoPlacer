import { Outlet, ScrollRestoration, useLocation } from 'react-router-dom';
import { ToastContainer, useToast } from './components/ui';
import { navItems } from './navigation';
import './index.css';
import './App.css';
import './Studio.css';

function App() {
  const { toasts, removeToast } = useToast();
  const { pathname } = useLocation();
  const label = navItems.find((item) => item.path === pathname)?.label;

  return (
    <>
      <header className="studio-topbar"><span>Atelier</span><span aria-hidden="true">/</span><strong>{label ?? 'Préparation'}</strong></header>
      <main id="studio-content" tabIndex={-1} className="studio-content">
        <Outlet />
      </main>
      <ToastContainer toasts={toasts} onClose={removeToast} />
      <ScrollRestoration />
    </>
  );
}

export default App;
