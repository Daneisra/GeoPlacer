import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from './ui';

/**
 * Inherited Wplacer pages (real accounts, inherited templates and engine):
 * disabled in GeoPlacer V1 (Phase 1B.10). The server refuses their routes
 * too: hiding the page is not the protection, only the explanation.
 */
export default function LegacyDisabled({ page }: { page: string }) {
  return (
    <Card id="legacyDisabled" className="max-w-2xl">
      <CardHeader>
        <CardTitle>{page} : désactivé dans GeoPlacer V1</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>
          GeoPlacer V1 est une <b>simulation locale</b>. Les fonctions héritées de Wplacer qui pouvaient contacter un service réel ou lancer l’ancien moteur sont
          désactivées : comptes réels, modèles et démarrage de l’ancien moteur, jetons, proxys.
        </p>
        <p>Le serveur refuse aussi les routes correspondantes (code <code>LEGACY_DISABLED</code>).</p>
        <p>
          <Link to="/" className="underline">
            Retour au tableau de bord de la simulation
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
