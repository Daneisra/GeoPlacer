# GeoPlacer — documentation en français

GeoPlacer est un fork de
[`Arknight38/wplacer-dev`](https://github.com/Arknight38/wplacer-dev)
(AGPL-3.0-only), avec un moteur de simulation locale et des outils de
préparation d’images pour GeoPixels.

## Développement suspendu

`main` fournit la démonstration stable, avec [préparation et export PNG](geopixels.md)
pour import manuel. La [branche finale](https://github.com/Daneisra/GeoPlacer/tree/final/geoplacer)
conserve le dernier tableau de bord et le [lecteur expérimental](phase2c-lecteur-http.md).
Les sections suivantes décrivent les étapes historiques du projet.

## Phase 1C.0, version candidate de démonstration

Réalisé en Phase 1C.0 (voir [version-candidate.md](version-candidate.md)) :
- **serveur réactif sur les grands modèles** : ordonnanceur coopératif et
  calculs découpés ; à 4096², blocage maximal de la boucle 1 339 → 75 ms,
  latence HTTP médiane 234 → 3 ms, sans différence de débit mesurable (voir
  [progression.md](progression.md), § 7) ;
- **installation fiabilisée** et auditée sur clone neuf (chemins avec
  espaces et accents, Node.js dans `C:\Program Files`, installation
  interrompue, mises à jour, empreinte de `canvas`) ;
- **sauvegardes** : démonstration et projet jamais mélangés par accident ;
  scénarios réalistes testés ;
- **sécurité** de la version candidate vérifiée (scripts, keep-alive,
  `.env.example`) ; un défaut latent des validateurs corrigé ;
- **proposition de version** `6.0.0-rc.1` et notes de release (non
  publiées) ;
- **push de la Phase 1B.10** : branche `feat/phase1b10-demo-hardening`.

## Phase 1B.10, première version de démonstration

**La V1 est un environnement de simulation local** : aucune connexion à
GeoPixels ou à Wplace, aucun compte. Un seul agent simulé. Vérifié sous
Windows 10 ; Linux et macOS ne sont pas vérifiés.

**Pour commencer** : [installation-windows.md](installation-windows.md)
(une commande : `npm run setup:windows`), puis
[demonstration.md](demonstration.md) (`npm run demo`) et
[guide-utilisateur.md](guide-utilisateur.md). Toutes les commandes :
[commandes.md](commandes.md). Limites : [problemes-connus.md](problemes-connus.md).

Réalisé en Phase 1B.10 :
- **isolation du code hérité** : routes refusées côté serveur
  (410 `LEGACY_DISABLED`), client réseau hérité fermé, keep-alive
  supprimé, pages retirées du menu (voir [securite.md](securite.md)) ;
- **installation Windows en une commande** (`npm run setup:windows`,
  `setup.bat`), vérifiée sur un clone neuf avec un cache npm vide ;
  `start.bat` lance GeoPlacer ;
- **sauvegarde et restauration** vérifiées, avec reprise d'une
  restauration interrompue (voir
  [sauvegarde-restauration.md](sauvegarde-restauration.md)) ;
- **interface en français**, avec une table de traduction centralisée ;
- **démonstration** : modèle original, données synthétiques, dossier
  séparé (voir [demonstration.md](demonstration.md)) ;
- **grands modèles** affichés en entier jusqu'à 4096², avec zoom et
  déplacement ;
- **progression incrémentale** vérifiée, adoptée après mesure (voir
  [progression.md](progression.md), § 6) ;
- **lint de l'interface à zéro**, inclus dans `npm run check` ;
- recettes Edge et Firefox (Playwright) ; vrai événement Ctrl+C testé
  sur `start.bat` (voir [recette-navigateur.md](recette-navigateur.md)) ;
- **push de la Phase 1B.9** : branche `feat/phase1b9-server-dashboard`.

## Phase 1B.9, serveur et tableau de bord sur la simulation locale

Réalisé en Phase 1B.9 :
- **service d'orchestration** (`@geoplacer/engine-service`) qui relie
  tous les composants du moteur à la toile simulée, sans règle métier
  propre ;
- **toile simulée durable** : reprise après arrêt brutal vérifiée par de
  vrais processus (voir [reprise-apres-crash.md](reprise-apres-crash.md)) ;
- **instance unique** par dossier de données : verrou, plus garde par
  canal nommé sous Windows ;
- **API `/api/v1`** (voir [api-v1.md](api-v1.md)) et **WebSocket**
  (voir [websocket.md](websocket.md)) ;
- **tableau de bord** : commandes, progression, toile, tentatives,
  ressources et améliorations simulées (voir
  [guide-utilisateur.md](guide-utilisateur.md)) ;
- **keep-alive hérité vers Wplace coupé par défaut** ;
- **défaut corrigé dans l'ordonnanceur** de la 1B.8 avec une horloge
  réelle ;
- **push de la Phase 1B.8** : branche `feat/phase1b8-single-agent-scheduler`.

## Phase 1B.8, ordonnanceur mono-agent sur simulateur

Réalisé en Phase 1B.8 :
- **ordonnanceur mono-agent** (voir [ordonnanceur.md](ordonnanceur.md)) :
  - il coordonne modèle, planification, tentatives, journal, ressources,
    progression et ETA sur la toile simulée locale ;
  - huit états, commandes `start`, `pause`, `resume`, `stop` et `status`,
    abonnement aux événements ;
  - attentes sans boucle active ;
- **reprise après dommage** : chaque bail prouve une lecture de la toile
  qui couvre ses points, et une tentative incertaine ne se clôt qu'une fois
  entièrement observée (voir [journal.md](journal.md)) ;
- **compactage automatique** du journal, avec seuils par défaut ;
- **tests de crash des modèles** sans minuteur, par étapes nommées ;
- **premier push** : branche `feat/phase1b7-journal-simulator` publiée.

## Phase 1B.7, journal compacté et simulateur de toile

Réalisé en Phase 1B.7 :
- **journal** (voir [journal.md](journal.md)) :
  - compactage par checkpoints vérifiés et générations ;
  - reprise équivalente au rejeu complet, en 22 ms au lieu de 3,7 s pour
    un journal de 146 Mio ;
  - diagnostic en lecture seule et réparation confirmée ;
  - rotation de l'historique ;
- **simulateur** : fournisseur de toile simulé local branché sur le
  gestionnaire de tentatives, avec dix scénarios de réconciliation (voir
  [simulateur.md](simulateur.md)) ;
- **interface** : recette dans un vrai navigateur (Edge), automatisée,
  avec trois anomalies corrigées : F12, F13 et les notifications jamais
  affichées (voir [recette-navigateur.md](recette-navigateur.md)) ;
- **planificateur** : premier lot plus rapide pour « couleur par couleur »
  et « contours d'abord ».


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

**Interface** : recettes navigateur automatisées (Edge ; Firefox de
Playwright depuis la 1B.10). L'aspect visuel reste à juger à l'œil (voir
[recette-navigateur.md](recette-navigateur.md)).

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

Le moteur de dessin hérité n'est **pas** fonctionnel ; depuis la
Phase 1B.10, il est neutralisé (voir [securite.md](securite.md)).

## Documents

| Document | Contenu |
|---|---|
| [architecture.md](architecture.md) | Paquets, couches, règles de dépendance, principes du moteur |
| [modeles.md](modeles.md) | Gestionnaire de modèles, révisions, stockage, intégrité, performances |
| [strategies.md](strategies.md) | Stratégies de dessin, clés de classement, cache de l'ordre aléatoire |
| [progression.md](progression.md) | Progression, classification des pixels, ETA |
| [ressources.md](ressources.md) | Règles de ressources, `ResourceManager`, améliorations |
| [planification.md](planification.md) | `WorkPlanner`, tentatives, journal, reprise après crash |
| [journal.md](journal.md) | Compactage, checkpoints, générations, diagnostic et réparation, historique |
| [simulateur.md](simulateur.md) | Toile simulée locale, pannes déterministes, scénarios de réconciliation |
| [ordonnanceur.md](ordonnanceur.md) | Ordonnanceur mono-agent : boucle, états, commandes, attentes, scénarios, performances |
| [installation-windows.md](installation-windows.md) | Installation en une commande, `start.bat`, lancement, configuration |
| [guide-utilisateur.md](guide-utilisateur.md) | Parcours complet de la simulation dans le navigateur, grands modèles, arrêt par Ctrl+C |
| [demonstration.md](demonstration.md) | Guide de démonstration |
| [geopixels.md](geopixels.md) | Préparer une image fantôme pour GeoPixels : parcours, conditions d'utilisation, test manuel, limites |
| [sauvegarde-restauration.md](sauvegarde-restauration.md) | Sauvegarde, vérification, restauration, reprise après interruption |
| [commandes.md](commandes.md) | Toutes les commandes |
| [problemes-connus.md](problemes-connus.md) | Problèmes connus et limites de la V1 |
| [version-candidate.md](version-candidate.md) | Version candidate : version proposée, fonctionnalités, plateformes, risques, checklist |
| [notes-release-6.0.0-rc.1.md](notes-release-6.0.0-rc.1.md) | Notes de release proposées (non publiées) |
| [api-v1.md](api-v1.md) | Routes `/api/v1`, protections, codes d'erreur, statut |
| [websocket.md](websocket.md) | Canal temps réel `/api/v1/ws` : messages, cohérence, fiabilité |
| [reprise-apres-crash.md](reprise-apres-crash.md) | Garanties, procédure et limites de la reprise |
| [diagnostic.md](diagnostic.md) | Symptômes, outils, fichiers du moteur |
| [geometrie-couleurs.md](geometrie-couleurs.md) | Repères, projection, OKLab, palettes, quantification, performances |
| [securite.md](securite.md) | Modèle de menace, protections, isolation du code hérité, limites |
| [persistance.md](persistance.md) | Fichiers de données hérités, écriture atomique |
| [qualite.md](qualite.md) | Tests, mesures, lint, délais intermittents, évaluation de Vitest |
| [recette-navigateur.md](recette-navigateur.md) | Recettes automatisées (Edge, Firefox) et procédure manuelle |
| [../decisions/0001-fork-et-perimetre.md](../decisions/0001-fork-et-perimetre.md) | Décision de fork et périmètre |
| [../decisions/0002-moteur-phase-1b.md](../decisions/0002-moteur-phase-1b.md) | Nouveau moteur (statut : accepté avec ajustements) |
| [../decisions/0003-migration-api-v1.md](../decisions/0003-migration-api-v1.md) | Migration des routes vers `/api/v1/` (statut : proposé, inventaire complet) |
| [../../MODIFICATIONS.md](../../MODIFICATIONS.md) | Modifications apportées au code d'origine (AGPL §5a) |

## Candidate consolidée

[Rapport 6.0.0-rc.1](consolidation-6.0.0-rc.1.md) : intégration, palettes, tests, validation utilisateur, clone neuf et provenance de l’archive.
