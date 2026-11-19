import {
    Activity,
    Bolt,
    GalleryHorizontalEnd,
    LayoutDashboard,
    ListOrdered,
    ScrollText,
    Settings2,
    Waypoints,
} from 'lucide-react';

export const navItems = [
    { path: '/', label: 'Tableau de bord', icon: LayoutDashboard },
    { path: '/dessins', label: 'Mes dessins', icon: GalleryHorizontalEnd },
    { path: '/modes', label: 'Modes de dessin', icon: Waypoints },
    { path: '/file', label: 'File de travail', icon: ListOrdered },
    { path: '/ressources', label: 'Ressources et améliorations', icon: Bolt },
    { path: '/logs', label: 'Journal', icon: ScrollText },
    { path: '/settings', label: 'Paramètres', icon: Settings2 },
    { path: '/diagnostics', label: 'Diagnostics', icon: Activity },
];

export type WorkspacePage = 'dashboard' | 'drawings' | 'queue' | 'resources' | 'diagnostics' | 'settings' | 'other';
