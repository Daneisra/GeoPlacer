# GeoPlacer — documentation en français

GeoPlacer est un fork de
[`Arknight38/wplacer-dev`](https://github.com/Arknight38/wplacer-dev)
(AGPL-3.0-only) qui vise à reprendre les fonctionnalités avancées de Wplacer
pour GeoPixels, avec un moteur développé et testé **uniquement sur simulateur
local** (voir l'ADR 0001).

## État actuel : Phase 1B.0, espace de travail du nouveau moteur

Réalisé en Phase 1B.0 :
- paquets `@geoplacer/core` (contrats seuls) et `@geoplacer/simulator`
  (squelette) ;
- Vitest pour ces paquets ;
- `.env` local et facultatif.

Voir [architecture.md](architecture.md). V1 : **un seul agent actif** ; les
essais multi-agents se feront uniquement sur le simulateur local.

**Interface non validée** : la recette navigateur
([recette-navigateur.md](recette-navigateur.md)) n'a pas encore été
effectuée. Les bugs F12 et F13 restent suivis.

Acquis de la Phase 1A, fondation et sécurité :

- Dépendances reproductibles : lockfiles versionnés, `npm ci`.
- Serveur local sécurisé :
  - écoute sur `127.0.0.1` par défaut ;
  - protection contre le DNS rebinding et les requêtes intersites ;
  - limiteur de débit et limite de taille des requêtes ;
  - Zod 4 avec collections bornées ;
  - secrets masqués dans l'API et les logs.
- Persistance fiable : écritures atomiques, sauvegarde `.bak`, quarantaine
  des fichiers corrompus.
- Paramètres réellement validés et sauvegardés.

Le moteur de dessin hérité n'est **pas** fonctionnel et sera remplacé.

## Documents

| Document | Contenu |
|---|---|
| [architecture.md](architecture.md) | Paquets, couches, règles de dépendance, principes du moteur |
| [installation-windows.md](installation-windows.md) | Installation et lancement vérifiés sous Windows |
| [securite.md](securite.md) | Modèle de menace, protections, limites |
| [persistance.md](persistance.md) | Fichiers de données, écriture atomique, sauvegarde et restauration |
| [qualite.md](qualite.md) | Tests, lint, évaluation de Vitest |
| [recette-navigateur.md](recette-navigateur.md) | Procédure de vérification manuelle dans un navigateur |
| [../decisions/0001-fork-et-perimetre.md](../decisions/0001-fork-et-perimetre.md) | Décision de fork et périmètre |
| [../decisions/0002-moteur-phase-1b.md](../decisions/0002-moteur-phase-1b.md) | Nouveau moteur (statut : accepté avec ajustements) |
| [../../MODIFICATIONS.md](../../MODIFICATIONS.md) | Modifications apportées au code d'origine (AGPL §5a) |
