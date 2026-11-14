# GeoPlacer — documentation en français

GeoPlacer est un fork de
[`Arknight38/wplacer-dev`](https://github.com/Arknight38/wplacer-dev)
(AGPL-3.0-only) qui vise à reprendre les fonctionnalités avancées de Wplacer
pour GeoPixels, avec un moteur développé et testé **uniquement sur simulateur
local** (voir l'ADR 0001).

## État actuel : Phase 1B.6, planification, tentatives et reprise

Réalisé en Phase 1B.6 (voir [planification.md](planification.md)) :
- numérotation durable des révisions par réservations immuables : un
  numéro n'est jamais réutilisé, même après crash ou réparation (voir
  [modeles.md](modeles.md)) ;
- clés de classement pour sept stratégies et cache vérifié de l'ordre
  aléatoire PCG32 V1 (voir [strategies.md](strategies.md)) ;
- `WorkPlanner` : prochain lot dérivé du modèle, de l'ordre et de la
  toile, sans tâche persistante par pixel ;
- `AttemptManager`, journal et historique : états explicites,
  réconciliation, reprise après crash testée par des processus tués ;
- lecture des instantanés par ligne (`readRow`, facultative).

Réalisé en Phase 1B.5 (voir [ressources.md](ressources.md)) :
- règles de ressources versionnées, états d'agent observés, calculés,
  projetés ou simulés, régénération sans double crédit ;
- `ResourceManager`, source unique de l'énergie, utilisée par l'ETA ;
- planificateur d'améliorations simulées, avec confirmation explicite ;
- études : cache d'ordre des stratégies, lecture des instantanés par
  ligne, proposition pour les numéros de révision.

Réalisé en Phase 1B.4 (voir [progression.md](progression.md)) :
- calcul de progression : pixels corrects, incorrects et inconnus, par
  couleur, avec la provenance et la fraîcheur de l'instantané ;
- estimation théorique du temps restant, ou absence d'estimation avec ses
  raisons ;
- instantané de toile en mémoire ;
- color-by-color environ deux fois plus rapide sur les images bruitées ;
- journaux de tests complets (`npm run check:logged`).

Réalisé en Phase 1B.3 :
- les huit stratégies de dessin, déterministes et paresseuses (voir
  [strategies.md](strategies.md)) ;
- pour les modèles : listage qui isole les modèles illisibles, réparation
  explicite, verrou du répertoire de données (voir [modeles.md](modeles.md)) ;
- correction de `npm run dev` sous Windows.

Réalisé en Phase 1B.2 : gestionnaire de modèles (import PNG, quantification
enregistrée, révisions immuables, projets), persistance vérifiée par
SHA-256 et résistante aux interruptions, paquet `@geoplacer/adapters-node`
(voir [modeles.md](modeles.md)). Le blocage de `npm run dev` est corrigé
en Phase 1B.3 (voir [installation-windows.md](installation-windows.md) § 5).

Réalisé en Phase 1B.1 : projection image ↔ toile, conversions OKLab,
palettes par agent et quantification (voir
[geometrie-couleurs.md](geometrie-couleurs.md)).

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
| [modeles.md](modeles.md) | Gestionnaire de modèles, révisions, stockage, intégrité, performances |
| [strategies.md](strategies.md) | Stratégies de dessin, clés de classement, cache de l'ordre aléatoire |
| [progression.md](progression.md) | Progression, classification des pixels, ETA |
| [ressources.md](ressources.md) | Règles de ressources, `ResourceManager`, améliorations |
| [planification.md](planification.md) | `WorkPlanner`, tentatives, journal, reprise après crash |
| [geometrie-couleurs.md](geometrie-couleurs.md) | Repères, projection, OKLab, palettes, quantification, performances |
| [installation-windows.md](installation-windows.md) | Installation et lancement vérifiés sous Windows |
| [securite.md](securite.md) | Modèle de menace, protections, limites |
| [persistance.md](persistance.md) | Fichiers de données, écriture atomique, sauvegarde et restauration |
| [qualite.md](qualite.md) | Tests, lint, évaluation de Vitest |
| [recette-navigateur.md](recette-navigateur.md) | Procédure de vérification manuelle dans un navigateur |
| [../decisions/0001-fork-et-perimetre.md](../decisions/0001-fork-et-perimetre.md) | Décision de fork et périmètre |
| [../decisions/0002-moteur-phase-1b.md](../decisions/0002-moteur-phase-1b.md) | Nouveau moteur (statut : accepté avec ajustements) |
| [../decisions/0003-migration-api-v1.md](../decisions/0003-migration-api-v1.md) | Migration des routes vers `/api/v1/` (statut : proposé, inventaire complet) |
| [../../MODIFICATIONS.md](../../MODIFICATIONS.md) | Modifications apportées au code d'origine (AGPL §5a) |
