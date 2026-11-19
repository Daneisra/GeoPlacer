import { useState } from 'react';
import { Menu } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { navItems } from '../navigation';
import { useServerStatus } from '../hooks/useServerStatus';

export function Sidebar() {
    const { status } = useServerStatus(5000);
    const [expanded, setExpanded] = useState(false);
    return (
        <aside className="studio-sidebar">
            <div className="studio-sidebar-heading">
                <NavLink to="/" className="studio-brand" onClick={() => setExpanded(false)}>
                    <img src="/geoplacer.svg" width="36" height="36" alt="" />
                    <span>GeoPlacer</span>
                </NavLink>
                <button
                    className="studio-mobile-menu"
                    aria-expanded={expanded}
                    aria-controls="studio-nav"
                    onClick={() => setExpanded(!expanded)}
                >
                    <Menu size={18} aria-hidden="true" /> Menu
                </button>
            </div>
            <nav id="studio-nav" aria-label="Navigation principale" data-expanded={expanded}>
                <ul>
                    {navItems.map(({ path, label, icon: Icon }) => (
                        <li key={path}>
                            <NavLink to={path} end className="studio-nav-link" onClick={() => setExpanded(false)}>
                                <Icon size={18} aria-hidden="true" />
                                <span>{label}</span>
                            </NavLink>
                        </li>
                    ))}
                </ul>
            </nav>
            <footer className="studio-sidebar-footer">
                <div className="studio-server" data-status={status} role="status">
                    <span aria-hidden="true" />
                    {status === 'connected'
                        ? 'Serveur connecté'
                        : status === 'disconnected'
                          ? 'Serveur déconnecté'
                          : 'Connexion au serveur…'}
                </div>
                <p>Issu de wplacer. Arknight38 et contributeurs. AGPL-3.0.</p>
            </footer>
        </aside>
    );
}
