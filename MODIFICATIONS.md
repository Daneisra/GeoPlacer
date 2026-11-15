# Modifications (GNU AGPL v3, section 5a)

GeoPlacer est une version modifiée de **wplacer** (`Arknight38/wplacer-dev`,
commit `46877e120f9e7bc721084fdf88a9ae8f006cb117`), œuvre de JinxTheCatto,
luluwaffless, Arknight38 et de leurs contributeurs, distribuée sous
GNU AGPL v3 (`LICENSE`). Les modifications sont distribuées sous la même
licence. L'historique Git complet du projet d'origine est conservé.

## 2026-11-13 — Phase 1A : fondation et sécurité

- Lockfiles backend et frontend versionnés ; Node ≥ 22.12 exigé ; télémétrie
  Scarf désactivée.
- Test `expirationDate` corrigé ; erreurs ESLint du backend corrigées.
- Écoute sur `127.0.0.1` par défaut, `HOST` validé (`src/config/network.ts`).
- Contrôles Host, Origin, Sec-Fetch-Site et WebSocket
  (`src/middleware/local-access.ts`).
- Limiteur de débit appliqué à toutes les routes.
- Cookies retirés de `GET /users` ; masquage des secrets dans les logs
  (`src/utils/redact.ts`, `src/utils/log-redaction.ts`).
- Limite JSON de 12 Mo ; erreurs client 4xx correctement renvoyées.
- `/settings` : validation (bornes alignées sur l'interface), état partagé, sauvegarde réelle
  (`src/config/settings-update.ts`, `src/config/default-settings.ts`) ;
  frontend en `PUT`, option « Random Color » retirée.
- Écritures atomiques et récupération des fichiers corrompus
  (`src/utils/json-store.ts`).
- Migration vers Zod 4.6.7 et collections bornées.
- `start.bat` : installation des deux projets par le chemin vérifié.
- Documentation française (`docs/fr/`, `docs/decisions/`).

## 2026-11-15 — Phase 1B.8 : ordonnanceur mono-agent sur simulateur

- `packages/core/src/scheduler` : ordonnanceur mono-agent (boucle, états,
  commandes, statut, événements), qui ne fait que coordonner les
  composants existants.
- `packages/core/src/work` :
  - preuve de couverture exigée pour chaque bail après un dommage ;
  - réconciliation qui exige une observation complète de la tentative ;
  - compactage automatique (seuils par défaut) ;
  - contrats v9.
- `packages/adapters-node` :
  - journal sérialisé lui-même, statistiques, espace libre ;
  - accroche de test des étapes d'écriture du stockage ;
  - tests de crash des modèles par étapes nommées.
- `packages/simulator` : latence d'écriture, panne « hold »,
  indisponibilité datée, source de ressources ; tests de l'ordonnanceur,
  scénarios A, C, D et E, banc du scénario B.
- Documentation : `docs/fr/ordonnanceur.md`, ADR 0002 § 17, mises à jour
  de `journal.md`, `simulateur.md`, `recette-navigateur.md`,
  `planification.md`, `architecture.md`, `qualite.md`, README.

## 2026-11-15 — Phase 1B.7 : journal compacté, simulateur, recette navigateur

- `packages/core/src/work` :
  - état logique du journal (réducteur pur partagé) ;
  - checkpoints vérifiés ;
  - lignes numérotées ;
  - compactage ;
  - lecture de la toile exigée après un dommage.
- `packages/adapters-node` :
  - générations du journal, pointeur `CURRENT` et rétention ;
  - diagnostic en lecture seule, réparation confirmée avec sauvegarde
    vérifiée et trace ;
  - rotation de l'historique ;
  - outil `journal:diagnose` / `journal:repair`.
- `packages/simulator` : fournisseur de toile simulé local et horloge
  virtuelle.
- `packages/core/src/strategy`, `work` : clés plus rapides pour « couleur
  par couleur » et « contours d'abord », palette en table typée.
- Interface héritée, corrigée après la recette navigateur :
  - **F13** : un F5 sur une page affiche l'interface ;
  - **F12** : démarrage désactivé et expliqué, arrêt branché sur la vraie
    route ;
  - les notifications s'affichent (magasin partagé, styles).
- `scripts/recette-navigateur.mjs` : recette automatisée dans un vrai
  navigateur.
- Documentation : `docs/fr/journal.md`, `docs/fr/simulateur.md`, ADR 0002
  § 16, mises à jour des autres documents.

## 2026-11-15 — Phase 1B.6 : planification, tentatives et reprise après crash

- Numérotation durable des révisions : réservations immuables
  (`TemplateStorage.reserve`, `reservations`), manifeste schéma 2
  (`numbering`), réparation qui ne réutilise jamais un numéro.
- `packages/core/src/strategy` : clés de classement des stratégies et
  cache vérifié de l'ordre aléatoire PCG32 V1 (inchangé).
- `packages/core/src/progress` : classification des pixels partagée avec
  le planificateur ; lecture facultative des instantanés par ligne
  (`readRow`). L'ETA devient indisponible quand les ressources sont trop
  anciennes (`STALE_RESOURCES`).
- `packages/core/src/work` : `WorkPlanner` (lot dérivé de la toile),
  `AttemptManager` (états explicites, réconciliation, reprise), format de
  ligne vérifié du journal et de l'historique.
- `packages/adapters-node` : cache d'ordre, journal des tentatives et
  historique sur disque, sous le répertoire de données verrouillé.
- Benchmarks `bench:reservations`, `bench:planner`, `bench:journal`.
- Documentation : `docs/fr/planification.md`, ADR 0002 § 15, mises à jour
  de `strategies.md`, `progression.md`, `modeles.md`, `architecture.md`,
  `qualite.md`, `README.md`.

## 2026-11-14 — Phase 1B.5 : ressources et améliorations

- `packages/core/src/resources` : règles de ressources versionnées et
  validées, états d'agent sérialisables (observé, calculé, projeté,
  simulé), régénération composable, opérations simulées,
  `ResourceManager` (source unique de l'énergie, registre des dépenses).
- `packages/core/src/upgrades` : planificateur d'améliorations (analyse,
  simulation avec ETA avant / après, classement, confirmation,
  application simulée) ; aucun achat réel.
- ETA branché sur le modèle d'énergie commun, identique à la 1B.4 pour
  une régénération d'une unité ; deux défauts de borne corrigés.
- Fraîcheur « non évaluée » explicite et signalée.
- Études : cache d'ordre (`bench:order-cache`), lecture par ligne
  (`bench:snapshot-read`) ; proposition d'allocation des numéros de
  révision (non implémentée).
- Documentation : `docs/fr/ressources.md`, ADR 0002 § 14.

## 2026-11-14 — Phase 1B.4 : progression et temps restant

- `packages/core/src/progress` : calcul de progression (correct,
  incorrect, inconnu, par couleur, provenance et fraîcheur de
  l'instantané) et estimation théorique du temps restant (durée ou
  raisons de son absence, hypothèses explicites).
- `packages/core/src/canvas` : instantané de toile en mémoire.
- color-by-color : table de couleurs en tableaux typés (même ordre,
  environ deux fois plus rapide sur le bruit).
- Tests de non-régression de la règle de génération des réparations ;
  correction de deux assertions vides de la 1B.3.
- `scripts/run-logged.mjs`, `npm run check:logged` : journaux de tests
  complets.
- Benchmarks `bench:progress` et `bench:color-by-color` ; documentation
  `docs/fr/progression.md`, analyse de la reprise des stratégies,
  proposition de verrou multiplateforme, ADR 0002 § 13.

## 2026-11-14 — Phase 1B.3 : stratégies de dessin et corrections des modèles

- `packages/core/src/strategy` : les huit stratégies (haut→bas, bas→haut,
  gauche→droite, droite→gauche, centre→extérieur, aléatoire PCG32 à
  graine, couleur par couleur, contours d'abord), curseurs par lots,
  région éligible (pixels hors toile ignorés).
- Modèles : listage qui isole les modèles illisibles, réparation explicite
  depuis la sauvegarde (fichier corrompu conservé), avertissement de
  placement partiellement hors toile, validation des `extensions`, de la
  graine et de `colorOrder`.
- `packages/adapters-node` : verrou exclusif du répertoire de données
  (`openNodeTemplateManager`).
- `npm run dev` et `npm run dev:backend` : `node --watch --import tsx` au
  lieu de `tsx watch` (blocage sous Windows, privatenumber/tsx#623).
- Tests de propriétés des stratégies ; tests à plusieurs processus du
  verrou ; benchmark `npm run bench:strategies`.
- Documentation : `docs/fr/strategies.md`, `docs/fr/modeles.md`, ADR 0002
  § 12, `docs/fr/installation-windows.md` § 5.

## 2026-11-14 — Phase 1B.2 : gestion des modèles

- `packages/core/src/template` : gestionnaire de modèles pur (via des
  ports), lecture de l'en-tête PNG et limites avant décodage, pixels
  canoniques, manifeste versionné (schéma 1), règles de révision,
  stockage en mémoire.
- Nouveau paquet `packages/adapters-node` : stockage fichiers atomique
  (temporaire, `fsync`, renommage avec reprise, `.bak` copié, chemins
  confinés), codec PNG pngjs 7.0.0, SHA-256, UUID, horloge.
- Tests : suite de conformité commune aux deux stockages avec panne
  injectée à chaque appel, arrêt brutal d'un processus réel, PNG invalides
  ou corrompus, transparence, seuil alpha, isolation des projets.
- Benchmark `npm run bench:templates` (2000² et 4096²).
- Documentation : `docs/fr/modeles.md`, ADR 0002 § 11, inventaire complet
  de l'ADR 0003, diagnostic de `npm run dev`.

## 2026-11-14 — Phase 1B.1 : géométrie et couleurs

- `packages/core/src/geometry` : projection image ↔ toile (Y descendant ou
  ascendant), limites et placement partiel, conversion explicite entre
  repères, validation stricte.
- `packages/core/src/color` : RVB 24 bits, règle alpha, conversions OKLab,
  distances OKLab et RVB, espace euclidien déclaratif.
- `packages/core/src/palette` : palettes par agent, plus proche couleur
  avec règle d'égalité documentée, quantification déterministe compacte,
  couleurs absentes.
- Benchmarks (`npm run bench:core`), règles d'architecture étendues.
- Corrections après relecture : coordonnées sans `-0`, règles de
  conversion de repère cohérentes (translation, axe de réflexion
  explicite), refus de la transparence et des valeurs invalides aux points
  d'entrée des couleurs.
- Serveur : interface compilée servie sans dépendre de `NODE_ENV` ; message
  explicite (503) si elle n'est pas compilée ; repli de l'application
  monopage limité à GET/HEAD (404 JSON pour les autres méthodes).
- Documentation : `docs/fr/geometrie-couleurs.md`, ADR 0002 § 10,
  ADR 0003 (plan de migration `/api/v1`, proposé).

## 2026-11-14 — Phase 1B.0 : espace de travail du nouveau moteur

- `.env` retiré du suivi Git (fichier local conservé), `.env.*` ignorés sauf
  les exemples, démarrage possible sans `.env` (`--env-file-if-exists`),
  `.env` généré par `start.bat` depuis `.env.example`.
- Lecture centralisée et validée de la configuration
  (`src/config/server-config.ts`).
- `@types/node` aligné sur Node 22.
- Espaces de travail npm `packages/core` et `packages/simulator`,
  configuration TypeScript stricte (`tsconfig.base.json`), Vitest 5.1.0.
- Contrats du moteur, sans algorithme (`packages/core/src/contracts`).
- Documentation : architecture, ADR 0002 accepté avec ajustements,
  commandes Windows, qualité.
