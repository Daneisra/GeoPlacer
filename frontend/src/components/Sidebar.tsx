import { NavLink, useLocation } from 'react-router-dom';
import { navItems } from '../navigation';
import { useServerStatus } from '../hooks';

export function Sidebar() {
  const { status } = useServerStatus(5000);

  return (
    <nav className="sidebar">
      <div className="sidebar-header">
        <span aria-hidden="true" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-current font-mono text-sm font-bold">GP</span>
        <span className="sidebar-title">GeoPlacer</span>
      </div>
      <ul className="sidebar-nav">
        {navItems.map((item) => (
          <li key={item.path}>
            <NavLink
              to={item.path}
              className={({ isActive }) =>
                `sidebar-link ${isActive ? 'active' : ''}`
              }
              end={item.path === '/'}
            >
              <img src={item.icon} alt="" className="sidebar-icon" />
              <span>{item.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="sidebar-footer">
        <div className={`connection-toast ${status}`}>
          <span className={`connection-dot ${status}`} />
          <span className="connection-text">
            {status === 'connected' && 'Serveur connecté'}
            {status === 'disconnected' && 'Serveur déconnecté'}
            {status === 'checking' && 'Connexion…'}
          </span>
        </div>
        <p className="sidebar-credits">Issu de wplacer · Arknight38 et contributeurs · AGPL-3.0</p>
      </div>
    </nav>
  );
}

export function Breadcrumbs() {
  const location = useLocation();
  const paths = location.pathname.split('/').filter(Boolean);

  return (
    <nav className="breadcrumbs" aria-label="Breadcrumbs">
      <ol>
        <li>
          <NavLink to="/">Home</NavLink>
        </li>
        {paths.map((path, index) => {
          const to = `/${paths.slice(0, index + 1).join('/')}`;
          const isLast = index === paths.length - 1;
          const label = path.charAt(0).toUpperCase() + path.slice(1);

          return (
            <li key={path}>
              <span className="breadcrumb-separator">/</span>
              {isLast ? (
                <span className="breadcrumb-current">{label}</span>
              ) : (
                <NavLink to={to}>{label}</NavLink>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
