# ADR 0002 : nouveau moteur (Phase 1B)

- **Date** : 13/11/2026
- **Statut** : **accepté avec ajustements** le 14/11/2026 (voir § 8).
  Phase 1B.0 réalisée (voir § 9).
- **Contrats en vigueur** : `packages/core/src/contracts/`.
- **Brouillon d'origine** : [`0002-interfaces-proposees.ts`](0002-interfaces-proposees.ts),
  conservé pour l'historique et **remplacé** par les contrats ci-dessus.

## 1. Objectif

Remplacer le moteur hérité, non fonctionnel (bugs F4 à F8, F11 et F12), par
un moteur indépendant de Wplace et de GeoPixels, qui retrouve les capacités
de Wplacer : gestion avancée des modèles, stratégies de dessin, file de
tâches, ressources, multi-agents, suivi en temps réel, interruption et
reprise.

Contraintes : un seul agent actif en V1 ; plusieurs agents uniquement sur le
simulateur local ; aucun accès à un service public (ADR 0001).

## 2. Organisation proposée (additive)

```
packages/core        logique métier pure : aucune E/S, aucun type DOM ou Node, testée par Vitest
packages/simulator   SimulatedCanvasProvider, agents simulés, horloge virtuelle, injection de pannes
src/ et frontend/    inchangés pendant la Phase 1B (serveur et interface hérités)
```

- **Espaces de travail npm** : `"workspaces": ["packages/*"]` dans le
  `package.json` racine. Le frontend garde son lockfile.
- **Déplacement vers `apps/` (décision séparée, à valider)** : `src/` →
  `apps/server`, `frontend/` → `apps/web`, par `git mv` pour conserver
  l'historique. À faire seulement une fois le moteur branché, car ce
  déplacement touche tous les scripts, chemins et documents.
- **TypeScript des nouveaux paquets** : `strict`,
  `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `module: NodeNext`.

## 3. Décision structurante : la file de tâches

**Proposition** : ne pas créer une tâche par pixel. Le travail restant est
**dérivé** de trois éléments :

- la révision du modèle ;
- l'ordre de la stratégie (calculé une fois, puis mis en cache) ;
- un instantané frais de la toile.

La toile est la source de vérité : d'autres joueurs la repeignent, donc une
liste de pixels stockée devient fausse et doit de toute façon être
recomparée.

Mesure pour un modèle de 2000×2000 (4 M de pixels, Node 22) :

| Approche | Mémoire | Construction | Tri « centre vers l'extérieur » | État persisté |
|---|---|---|---|---|
| Un objet tâche par pixel | +800 Mo | 11,3 s | 5,5 s | journal JSON de 461 Mo |
| Ordre en tableaux typés (`Uint32Array`) et travail dérivé | +55 Mo | 0,06 s | 1,4 s | quelques octets par modèle (statut, graine, révision) |

Lecture honnête de cette mesure (script :
`GeoPlacer-phase1a/scripts/phase1b-bench-tasks.cjs`) :
- la construction de A est dominée par le calcul de 4 M d'identifiants
  (SHA-1), que B ne calcule jamais ;
- le **coût récurrent** de B n'est pas mesuré. À chaque lot, il faut lire la
  zone du modèle sur la toile et parcourir l'ordre jusqu'à trouver `max`
  pixels différents. Critère d'acceptation de l'étape 1B.6 : sur 2000×2000,
  `nextBatch` doit prendre moins de 200 ms quand le modèle est fait à 99 %
  (le pire cas du parcours). Un curseur de reprise ne sera ajouté que si ce
  critère échoue.

**Ce qui est persisté** :
- l'état des modèles (statut, priorité, stratégie, graine, révision) ;
- les **tentatives en cours**, dans un journal append-only : une ligne JSON
  par événement, avec une dernière ligne tronquée ignorée au chargement, et
  un compactage atomique qui ne garde que les tentatives ouvertes ;
- l'**historique** des opérations, dans un journal séparé avec rotation et
  jamais compacté.

Correspondance avec les exigences de la file :

| Exigence | Mécanisme |
|---|---|
| Générer les tâches depuis un modèle | `WorkPlanner.nextBatch()` parcourt l'ordre de la stratégie |
| Identifier les pixels restants | Comparaison avec l'instantané de la toile |
| Classer selon une stratégie | `DrawingStrategy.order()`, pur et déterministe |
| Éviter les doublons | `TaskId` stable (modèle, révision, x, y, couleur) et exclusion des tâches en cours (`inFlight`) |
| Répartir entre agents | L'ordonnanceur loue un lot par agent, filtré par ses couleurs débloquées |
| Suspendre et reprendre | Statut du modèle ; libération des tentatives |
| Sauvegarder l'état | Dépôt des modèles, journal des tentatives, historique |
| Restaurer après redémarrage | Relecture du journal, puis `AttemptManager.recover()` |
| Ne pas perdre de tâches en cas d'erreur | Un pixel non peint réapparaît automatiquement à la comparaison suivante |

**Idempotence et reprise après crash** :
1. le journal enregistre `leased`, puis `started` **avant** l'appel au
   fournisseur, puis `finished` après ;
2. au redémarrage, une tentative `leased` mais non commencée est libérée ;
3. une tentative `started` mais non terminée est **réconciliée** par une
   relecture de la toile : un pixel déjà correct compte comme appliqué. Elle
   n'est jamais relancée à l'aveugle, ce qui évite de dépenser deux fois de
   l'énergie ;
4. le fournisseur reçoit `attemptId` comme clé d'idempotence : le simulateur
   ignore une clé répétée.

Point ouvert : après une réconciliation, un pixel « déjà correct » ne dit
pas si l'énergie a été dépensée (écriture passée avant le crash, ou pixel
repeint par un tiers). Les ressources de l'agent doivent donc être
**réobservées** (`ResourceManager.observe`) avant de reprendre, plutôt que
déduites.

## 4. Autres décisions de conception

- **Coordonnées** : un modèle est toujours stocké de haut en bas, ligne par
  ligne. Le fournisseur déclare `yAxis: 'up' | 'down'`, et une seule fonction
  testée (`Projection`) passe de l'image à la toile. Cela supprime la classe
  de bugs F11.
- **Stratégies (8)**, définies dans l'espace de l'image, donc telles que
  l'utilisateur voit le modèle :
  - haut→bas, bas→haut, gauche→droite, droite→gauche : tri par ligne ou par
    colonne, puis par l'autre axe ;
  - couleur par couleur : ordre `colorOrder` s'il est fourni, sinon couleurs
    les moins fréquentes d'abord ;
  - contours d'abord : un pixel est un contour si un voisin (4-connexité) est
    transparent ou hors de l'image ; le reste suit en haut→bas ;
  - centre vers l'extérieur : distance au centre, puis index ;
  - aléatoire : Fisher-Yates avec un générateur à graine, donc rejouable.
- **Palette** : `Palette` est un catalogue (conversion, interface). Les
  couleurs qu'un agent peut peindre viennent **uniquement** de
  `ResourceSnapshot.unlockedColors`. Distance de couleur par défaut :
  **OKLab**, perceptuelle (le code hérité utilisait une distance RVB
  euclidienne).
- **Ressources** : `ResourceModel` est configurable (énergie maximale,
  régénération, coûts). `recordSpend()` est le seul endroit où une dépense
  est décomptée, ce qui corrige F7.
- **Améliorations** : `UpgradePlanner` ne fait que **proposer**. Toute
  dépense réelle exige une `UserConfirmation`.
- **Multi-agents** : `EngineConfig.maxActiveAgents` est injecté. Il vaut 1
  par défaut et le serveur V1 l'impose ; les tests du simulateur peuvent
  l'augmenter. Les secrets de session ne sont jamais dans `packages/core`.
- **Estimation du temps restant** : `EtaEstimator` est distinct du calcul de
  progression, car il dépend des agents et des ressources.
- **Temps** : une `Clock` est injectée partout ; le simulateur utilise une
  horloge virtuelle, donc des tests rapides et déterministes.

## 5. Tests (Vitest, nouveaux paquets uniquement)

- **Outillage** :
  - Vitest 5.1 exige `@types/node` en ^22 ou ≥ 24 : passer la dépendance
    racine de ^20 à ^22. Déjà vérifié : la compilation héritée passe avec
    `@types/node` 22.20.5 ;
  - Jest reste en place pour `src/__tests__` ;
  - aucune migration globale.
- **Commandes prévues** :

  ```powershell
  npm test                                   # Jest, tests hérités (inchangé)
  npm run test:packages                      # Vitest dans packages/* (npm test --workspaces)
  npx vitest run --root packages/core        # un seul paquet
  npx vitest --root packages/core            # mode surveillance
  ```

- **Priorités du cahier des charges** :

| Priorité | Sujet | Où |
|---|---|---|
| 1 | Conversion des coordonnées (Y montant ou descendant, aller-retour, bornes) | `core/geometry` |
| 2 | Conversion des couleurs (OKLab, plus proche couleur) | `core/palette` |
| 3 | Transparence (seuil alpha, pixels ignorés) | `core/palette`, `core/template` |
| 4 | Calcul de progression (par couleur, inconnus) | `core/progress` |
| 5 | File et tentatives (doublons, location, libération) | `core/work` |
| 6 | Ressources (prévision, dépense unique, temps restant) | `core/resources` |
| 7 | Interruption et reprise (journal tronqué, réconciliation) | `core/work` + simulateur |
| 8 | Plusieurs agents avec des palettes différentes | `simulator` |

Les stratégies seront aussi testées par propriétés : chacune doit produire
une permutation exacte des pixels non transparents, sans perte ni doublon,
et être déterministe à graine égale.

## 6. Plan de travail (un commit ou une petite série par étape)

| Étape | Contenu | Critère d'acceptation |
|---|---|---|
| 1B.0 | Espace de travail `packages/*`, Vitest, `@types/node` ^22, scripts | Compilation et 86 tests Jest inchangés ; un test Vitest vide passe |
| 1B.1 | `core` : géométrie, `Projection`, couleurs, OKLab, palette | Priorités 1 à 3 couvertes |
| 1B.2 | `core` : image de modèle, conversion, révisions, `TemplateManager` | Une modification d'image incrémente la révision |
| 1B.3 | `core` : les 8 stratégies | Tests de propriétés ; déterminisme |
| 1B.4 | `core` : progression et `EtaEstimator` | Priorité 4 |
| 1B.5 | `core` : `ResourceManager`, `UpgradePlanner` (propositions seulement) | Priorité 6 ; aucune dépense sans confirmation |
| 1B.6 | `core` : `WorkPlanner`, `AttemptManager`, journal (interface + implémentation en mémoire) | Priorités 5 et 7 ; `nextBatch` < 200 ms sur 2000×2000 fait à 99 % |
| 1B.7 | `simulator` : toile (Y configurable), agents, horloge virtuelle, pannes | Toile simulée cohérente avec la projection |
| 1B.8 | `core` : `TaskScheduler` multi-agents | Priorité 8 (3 agents, palettes différentes) ; refus d'un 2ᵉ agent actif avec la configuration V1 |
| 1B.9 | Adaptateurs serveur : journal fichier (sur `json-store`), événements WebSocket | Reprise après arrêt brutal réel du processus |

Le branchement dans l'interface et la suppression du moteur hérité
viendront ensuite, dans des commits séparés et justifiés.

## 7. Décisions soumises à validation (validées le 14/11/2026, sauf la 5)

1. Travail dérivé plutôt que matérialisé (§ 3).
2. OKLab comme distance de couleur par défaut.
3. Format de stockage des modèles côté serveur : PNG avec métadonnées JSON,
   via une bibliothèque PNG en JavaScript pur, pour se passer à terme de
   `canvas`.
4. `SnapshotCanvasProvider` : suivi de progression réel à partir d'une image
   de la zone importée **manuellement** par l'utilisateur.
5. Moment du déplacement de `src/` et `frontend/` sous `apps/` : **non décidé**.

## 8. Ajustements validés (14/11/2026)

- **Planification dérivée** acceptée, avec ces exigences :
  - tableaux compacts ;
  - planification déterministe ;
  - tentatives à identifiants stables ;
  - journal de reprise ;
  - déduplication et réconciliation ;
  - benchmarks de mémoire et de performance.

  La cible de 200 ms pour `nextBatch` sera mesurée sur 2000×2000, en
  distinguant les mesures **à froid** et **à chaud**.
- **OKLab** est la distance initiale, derrière une interface remplaçable
  (`ColorDistance`). À prévoir :
  - des conversions RVB ↔ OKLab testées ;
  - la transparence ;
  - une palette par agent ;
  - une quantification déterministe ;
  - des tests sur des couleurs proches.
- **PNG + JSON** pour les modèles. Le JSON contient au minimum : version de
  schéma, dimensions, origine, système de coordonnées, palette, stratégie,
  identifiant de projet, SHA-256 du PNG. Il est validé et migré
  (`TemplateMetadataCodec`).
- **Fournisseurs de toile** :
  - simulateur ;
  - import manuel d'instantanés, qui portent une date d'observation ; la
    progression mesurée sur un instantané est distinguée de la progression
    simulée ;
  - capacités de **lecture et d'écriture séparées** : un fournisseur en
    lecture seule ne peut pas recevoir de placement.
- **Aucune intégration non autorisée** avec GeoPixels.
- **V1** : un seul agent actif en production ; multi-agents uniquement sur
  le simulateur.
- **F12 et F13** restent suivis. Une séparation des routes de l'API sous
  `/api/` est à étudier, avec une migration compatible avec le frontend
  existant.

## 9. Mise en œuvre de la Phase 1B.0 et écarts avec le brouillon

Réalisé :
- espace de travail `packages/core` et `packages/simulator` ;
- Vitest 5.1.0 ;
- `@types/node` ^22 ;
- contrats seuls (aucun algorithme) dans `packages/core/src/contracts`,
  en couches sans cycle (vérifié par test) ;
- `.env` retiré du suivi Git.

Écarts avec `0002-interfaces-proposees.ts` :

| Brouillon | Contrat retenu | Raison |
|---|---|---|
| `CanvasProvider` unique avec `capabilities.write` | `CanvasReader` + `CanvasWriter`, union `ReadOnlyCanvasProvider` / `ReadWriteCanvasProvider` | Séparation des capacités garantie à la compilation |
| `SchedulerDependencies.canvas: CanvasProvider` | `ReadWriteCanvasProvider` ; `AttemptManager.recover` aussi | Un instantané en lecture seule ne peut pas recevoir de placement |
| `CanvasSnapshot` avec `takenAt` | `source` + `observedAt` obligatoires | Distinguer simulé et mesuré ; obsolescence visible |
| `ProgressSnapshot` sans origine | `basis: { source, observedAt }` | Idem |
| `ProgressCalculator.compute(template, snapshot, system, now)` | `compute(template, snapshot, now)` | Le système de coordonnées est porté par le modèle |
| `PaletteManager.nearest(rgb, palette, metric)` | `nearest(rgb, colors, distance: ColorDistance)` | Distance remplaçable ; la palette de l'agent est passée explicitement |
| `ColorMetric` (énumération) | Interface `ColorDistance` | Remplacement ultérieur de l'algorithme |
| `Template` sans projet ni système | `projectId`, `coordinateSystem`, `palette` ajoutés | Alignement sur les métadonnées JSON |
| — | `TemplateMetadataV1`, `TemplateMetadataCodec`, `TEMPLATE_METADATA_SCHEMA_VERSION` | Stockage PNG + JSON validé et migrable |
| `Projection.templateBounds(image, …)` | `bounds(size, …)` ; `canvasToImage` renvoie un `ImagePoint` | Pas de dépendance de la géométrie vers le modèle (couches) |
| `SchedulerDependencies` sans progression | `progress` et `eta` ajoutés | Les événements `progress` portent `etaMs` |
| — | Identifiants `ProjectId`, type `Timestamp` | Clarté des contrats |

### Points ouverts avant la 1B.1 (tranchés le 14/11/2026, voir § 10)

1. **Système de coordonnées en double** : il est porté à la fois par
   `Template.coordinateSystem` et par `CanvasReader.coordinateSystem`, et
   `CanvasSnapshot` n'en porte aucun. Règle proposée : celui du lecteur fait
   foi ; un modèle dont le système diffère est refusé à la planification
   (erreur explicite, jamais de conversion implicite). À trancher avant
   d'implémenter `Projection`.
2. **Dérivation des identifiants** : `TaskId` et `AttemptId` sont dits
   stables, mais leur règle n'est pas encore fixée. Proposition :
   - `TaskId` = empreinte de `(templateId, révision, x, y, couleur)` ;
   - `AttemptId` = `(agentId, horodatage du bail, compteur)`, unique et
     journalisé.
3. **Interface sans `.env`** : l'interface n'est servie qu'avec
   `NODE_ENV=production`. Faut-il la servir par défaut ? Décision à prendre
   par l'utilisateur.
4. **Routes de l'API sous `/api/`** (F13) : à étudier, avec une
   compatibilité transitoire pour le frontend existant.

## 10. Décisions du 14/11/2026 et mise en œuvre de la Phase 1B.1

### Décisions

1. **Repères.** Le repère du `CanvasReader` fait foi pour la toile. Trois
   espaces sont distingués :
   - l'image source, qui est l'espace du modèle (origine en haut à gauche,
     Y vers le bas) ;
   - le modèle positionné, défini par `placement.topLeft` ;
   - la toile.

   Un modèle dont le placement est exprimé dans un repère d'orientation
   différente **n'est pas refusé** : il est converti explicitement
   (`convertPlacement`). Seuls sont refusés les systèmes inconnus, les
   conversions ambiguës (`AMBIGUOUS_TRANSFORM`) et les placements contraires
   aux contraintes (`assertPlacement`). Aucune inversion implicite. Détail :
   [docs/fr/geometrie-couleurs.md](../fr/geometrie-couleurs.md).
2. **`TaskId`** (implémentation prévue en 1B.6, fonction pure du cœur) :
   - dérivé de `(templateId, révision, ix, iy, couleur)` ;
   - **coordonnées de l'image**, pas de la toile : elles sont toujours des
     entiers positifs canoniques et ne dépendent ni du repère de la toile
     ni d'une conversion de placement. Le passage à la toile reste univoque,
     car tout changement de placement incrémente la révision ;
   - indépendant de la stratégie de dessin ;
   - forme canonique :
     `<templateId encodé>:<révision>:<ix>:<iy>:<rrggbb>`, avec :
     - `templateId` encodé par `encodeURIComponent` ;
     - les entiers en base 10, sans zéro de tête ni signe ;
     - la couleur en hexadécimal minuscule sur 6 chiffres.
3. **`AttemptId`** : identifiant unique durable, généré par l'**adaptateur
   d'infrastructure** (par exemple UUID v7, ordonné dans le temps), puis
   injecté dans le cœur par un port (`IdSource`). Le cœur ne produit jamais
   d'aléa ni d'horodatage par lui-même. Il est journalisé dès le bail, donc
   il survit aux redémarrages.
4. **Interface sans `.env`** : l'interface doit être servie dès qu'une
   version compilée existe, indépendamment de `NODE_ENV`, avec un message
   explicite si elle n'est pas compilée. Commit séparé, après la 1B.1.
5. **API sous `/api/v1/`** : migration progressive, avec compatibilité
   temporaire des routes actuelles. Plan :
   [ADR 0003](0003-migration-api-v1.md).

### Écarts introduits par la 1B.1

| Élément | Changement | Raison |
|---|---|---|
| `ColorDistance` | `euclideanSpace?` facultatif (`EuclideanColorSpace` : `dimensions`, `project`) | Mesuré : la quantification d'un bruit 2000×2000 passait de 26,5 s à 3,7 s ; le contrat reste remplaçable |
| `Projection` | Contrat inchangé ; fonctions ajoutées hors contrat : `placementTransform`, `locateInImage`, `checkPlacement`, `assertPlacement`, `canvasSystemTransform`, `convertPlacement` | Parcours sans allocation, limites, conversion de repère |
| `Template.coordinateSystem` | Sens précisé : repère dans lequel `placement` est exprimé | Décision 1 |
| `PaletteManager` | Contrat inchangé ; ajouts : `createPaletteMatcher`, `agentColors`, `quantizeRgba` (avec statistiques), `countColors` | Palettes par agent, mémo réutilisable |
