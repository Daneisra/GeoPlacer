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
3. **Interface sans `.env`** : l'interface n'était servie qu'avec
   `NODE_ENV=production`. Décidé le 14/11/2026 : la servir dès qu'une
   version compilée existe (fait, voir § 10).
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
   (`convertPlacement`) :
   - par translation ou réflexion déduite des limites ;
   - ou, sur une toile sans limites, par un axe de réflexion fourni
     explicitement (`reflectionYSum`).

   Seuls sont refusés les systèmes inconnus, les conversions ambiguës
   (`AMBIGUOUS_TRANSFORM`) et les placements contraires aux contraintes
   (`assertPlacement`). Aucune inversion implicite. Détail :
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
   explicite si elle n'est pas compilée. **Fait** (commit séparé, après
   la 1B.1), vérifié sur un clone neuf sans `.env`.
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
| `CanvasTransform` | Types `identity`, `translate-y`, `flip-y` ; option `reflectionYSum` | Règles cohérentes entre même sens et sens opposés ; toile sans limites convertible sur axe explicite |

### Critères reportés à la 1B.2

- Taille maximale des modèles : l'index `iy * largeur + ix` doit tenir dans
  un `Uint32` (et dans la limite de taille des requêtes).
- L'image quantifiée est persistée et jamais recalculée au chargement : la
  couleur, donc le `TaskId`, ne dépend pas de l'arrondi d'un moteur
  JavaScript.

## 11. Mise en œuvre de la Phase 1B.2 : contrats v2 des modèles

`CORE_CONTRACT_VERSION` passe à **2** : le contrat des modèles change de
forme. Rien n'était encore persisté, donc aucune migration de données
n'est nécessaire.

| Élément | Changement | Raison |
|---|---|---|
| `TemplateMetadataV1`, `TemplateMetadataCodec`, `TemplateInput`, `TemplatePatch` | Remplacés par `TemplateManifestV1` (un manifeste par modèle, révisions immuables en liste) et par `CreateTemplateInput`, `RevisionChange`, `SettingsPatch` | Séparer ce qui crée une révision de ce qui n'en crée pas |
| `TemplateManager` | Asynchrone ; `load` avec `LoadReport`, `revise`, `restoreRevision`, `updateSettings`, `setStatus`, `duplicate`, `delete` (confirmation par le nom), `verify` | Fonctions demandées pour la 1B.2 |
| `Template` | Ajouts : `alphaThreshold`, `quantization`, `sourceImageHash`, `quantizedImageHash` | La révision porte tout ce qui détermine ses pixels |
| Ports (couche 1) | `TemplateStorage` (comparaison-échange sur `generation`), `PngCodec`, `Hasher`, `IdSource`, `TimeSource` | Cœur sans E/S ; implémentations dans `@geoplacer/adapters-node` |
| Identifiants | `[a-z0-9-]{1,64}` sans nom de périphérique Windows | Noms de dossiers sûrs sous NTFS |

Les critères reportés de la § 10 sont tenus :
- limites de 4096 × 4096 et 16 777 216 pixels par défaut, vérifiées
  avant toute allocation ;
- index `Uint32` garanti par `assertValidLimits` ;
- image quantifiée persistée, jamais recalculée au chargement.

Détails : [modeles.md](../fr/modeles.md).

## 12. Mise en œuvre de la Phase 1B.3 : contrats v3, stratégies

`CORE_CONTRACT_VERSION` passe à **3**. Aucun manifeste existant n'est
invalidé, sauf ceux dont la graine sort de [0, 2^32) ou dont `colorOrder`
contient un doublon (aucun n'existait).

| Élément | Changement | Raison |
|---|---|---|
| `TemplateManager.list` | Renvoie `{ templates, failures }` au lieu d'un tableau | Un modèle illisible ne doit pas masquer les autres (correction A) |
| `TemplateManager.repair` | Nouveau : `repair(ref, { apply })` | Réparation volontaire d'un manifeste courant absent ou malformé (correction B) |
| `TemplateStorage.replaceManifest` | Nouveau port : comparaison-échange sur le texte brut, conservation du fichier corrompu, sauvegarde intacte | `writeManifest` copierait le fichier corrompu sur la bonne sauvegarde |
| `Template.warnings`, `TemplateSummary.warnings` | Avertissement dérivé `PLACEMENT_PARTIALLY_OUTSIDE`, jamais stocké | Décision du 14/11/2026 : placement partiel autorisé mais signalé |
| `extensions` | Validées : noms, JSON simple, profondeur 8, 64 Kio | Décision du 14/11/2026 |
| `DrawingStrategy` | Étendu sans rupture : région éligible facultative pour `order`, `cursor` (ordre par lots), `version` | Premier lot rapide ; pixels hors toile ignorés |
| `ImageRect`, `DrawingOrderCursor` | Nouveaux types (couche 3) | Idem |
| Verrou du répertoire de données | `@geoplacer/adapters-node` : `openNodeTemplateManager` remplace `createNodeTemplateManager` | La comparaison-échange seule ne protège pas entre processus (correction C) |

Précisions sur les stratégies (§ 4) :
- **Contour** : la règle validée le 14/11/2026 ajoute le voisin **d'une
  autre couleur** à la définition du § 4 (voisin transparent ou hors de
  l'image).
- **Identifiant** : la demande de la 1B.3 écrit `outlines-first`. Le contrat
  et les manifestes utilisent `outline-first` depuis la 1B.0. Il est
  conservé, pour ne pas invalider les manifestes ; à confirmer.
- **Région éligible** : avec une région, l'ordre est exactement l'ordre
  complet filtré. Le centre, les fréquences de couleur et les contours sont
  donc calculés sur toute l'image, jamais sur la région.

Détails : [strategies.md](../fr/strategies.md) et
[modeles.md](../fr/modeles.md).

## 13. Mise en œuvre de la Phase 1B.4 : contrats v4, progression et ETA

`CORE_CONTRACT_VERSION` passe à **4**. Les contrats de progression et
d'ETA n'avaient encore aucune implémentation, et rien n'est persisté :
aucune migration n'est nécessaire.

| Élément | Changement | Raison |
|---|---|---|
| `CanvasSnapshot.coordinateSystem` | Nouveau champ obligatoire | Repère explicite : un instantané dans un autre repère que le modèle est refusé |
| `ProgressSnapshot` | `wrongColor`, `missing`, `unknown` complétés par `incorrect`, `invalidObservations`, `excluded`, `conformityPercent` et `coveragePercent` (null si aucun pixel éligible), `completion`, `byColor` en tableau trié, `basis` avec nature et fraîcheur | Distinguer l'incorrect connu de l'inconnu ; aucune division par zéro ; provenance et ancienneté |
| `ProgressCalculator.compute` | Prend un `ProgressTemplate` (image, placement, repère), sans stratégie | La progression ne dépend pas de l'ordre de dessin |
| `FreshnessPolicy` | Par source d'instantané, sans valeur par défaut | Pas de seuil arbitraire commun |
| `EtaEstimator.estimate` | Remplacé : `(progression, agents, paramètres, now) → EtaResult` (durée ou `null` avec raisons, hypothèses, répartition) | L'ancienne signature dépendait de `ResourceManager`, prévu en 1B.5, et ne donnait aucune raison |
| `createArraySnapshot` | Nouveau (`src/canvas`) | Aucun instantané n'était encore implémenté |

Détails : [progression.md](../fr/progression.md). L'analyse de la reprise
des stratégies, à trancher avant la 1B.6, est dans
[strategies.md](../fr/strategies.md) § 4.

## 14. Mise en œuvre de la Phase 1B.5 : contrats v5, ressources et améliorations

`CORE_CONTRACT_VERSION` passe à **5**. Rien n'était persisté pour ces
contrats : aucune migration.

| Élément | Changement | Raison |
|---|---|---|
| `ResourceModel`, `ResourceSnapshot` | Remplacés par `ResourceRules` (règles versionnées du fournisseur), `ResourceObservation` (seule entrée de l'observation) et `AgentResourceState` (état sérialisable : observé, calculé, projeté, simulé) | Règles explicites et validées ; ne jamais confondre une observation et une projection |
| `ResourceManager` | `observe` → `ObservationResult` (dépenses absorbées ou contredites, phase de régénération) ; `stateAt` ; `recordSpend` → statut (`applied`, `duplicate`, `absorbed-by-observation`) ; `timeUntil` | Source unique de vérité, sans double consommation |
| `UpgradePlanner`, `UpgradeProposal`, `UserConfirmation` | Déplacés dans `upgrades.ts` (couche 4) ; analyse, proposition avec ETA avant / après, confirmation, application simulée | Le planificateur dépend de l'ETA (couche 3) |
| `EtaAgent`, `EtaParameters` | L'agent porte un état de ressources ; les paramètres portent les règles (fin de `energyPerPixel`) | Un seul modèle de régénération |
| `EtaResult.warnings` | Nouveau : `FRESHNESS_NOT_EVALUATED`, `SIMULATED_RESOURCES` | Ne jamais présenter une donnée non jugée ou simulée comme actuelle |
| `FreshnessStatus` | `unchecked` devient `not-evaluated` | Demande du 14/11/2026 |
| `ApplyResult.resources`, événement `resources` | `ResourceObservation`, `AgentResourceState` | Nouveaux types |

L'algorithme de l'ETA n'est pas remplacé : seule son énergie vient du
modèle commun. Il est vérifié identique à la 1B.4 avec une régénération
d'une unité.

Détails : [ressources.md](../fr/ressources.md). Proposition pour les
numéros de révision : [modeles.md](../fr/modeles.md) (réparation).

## 15. Mise en œuvre de la Phase 1B.6 : contrats v6 et v7, planification et tentatives

`CORE_CONTRACT_VERSION` passe à **6**, puis à **7**.

| Version | Élément | Changement | Raison |
|---|---|---|---|
| 6 | Manifeste des modèles | Schéma **2** : champ `numbering` (`legacy` ou `reserved`). Migration 1 → 2 en mémoire ; la première écriture convertit le fichier, sans retour au schéma 1 | Numéros de révision et de génération jamais réutilisés, même après crash ou réparation |
| 6 | `TemplateStorage` | `reserve(projet, modèle, type, valeur)` et `reservations(projet, modèle)` : réservations immuables, créées en exclusif (`wx` puis fsync) **avant** la publication | Un crash laisse un trou dans la numérotation, jamais une réutilisation |
| 6 | `RepairOptions`, `RepairReport` | `allowMissingReservations` ; `numbering` (bases, maxima, numéros brûlés, réservations manquantes) | Réparation explicite et traçable |
| 6 | `OrderCacheKey`, `OrderCacheStore` | Nouveaux (couche 3) | Cache vérifié et facultatif de l'ordre aléatoire PCG32 V1 |
| 7 | `CanvasSnapshot.readRow` | Méthode facultative : lecture d'une ligne, valeurs identiques à `get` | Lecture plus rapide, sans second format |
| 7 | `work.ts` | Passe de la couche 3 à la **couche 4** (dépend de `progress`). Réécrit : `WorkPlanner.nextBatch(préparé, requête)` avec politique des pixels inconnus, points en cours, énergie engagée, refus explicites ; `PreparedTemplate` | Travail dérivé de la toile, sans tâche persistante par pixel |
| 7 | Tentatives | États `leased`, `started`, `finished`, `failed`, `cancelled`, `needs-reconciliation` ; `Attempt` (dont `needsReconciliationAt`) ; `JournalEvent`, `AttemptJournal`, `HistoryEntry`, `HistoryStore`, `RecoveryReport`, `AttemptManager` | Reprise après crash sans relance aveugle ; aucune promesse « exactement une fois » |
| 7 | `EtaUnavailableCode` | `STALE_RESOURCES` devient une **indisponibilité** (avant : avertissement) ; nouvel avertissement `RESOURCE_AGE_NOT_EVALUATED` | Une ETA fondée sur des ressources trop anciennes n'est jamais présentée comme fiable |

**Exception à la règle des dossiers** : `work/` importe le CRC-32 de
`template/png-header.ts`, uniquement pour le format des lignes du journal
(pas de copie d'un second CRC-32). L'exception est inscrite dans le test
d'architecture.

**Écarts avec le § 3** :
- `nextBatch` ne parcourt pas l'ordre de la stratégie : il classe les
  pixels restants par leur **clé** d'ordre et garde les k plus petites.
  Le résultat est identique (test de propriété), sans générer l'ordre
  complet.
- Le journal est vérifié ligne par ligne (CRC-32), et un dommage avant la
  dernière ligne est signalé, jamais ignoré.
- **Pas encore faits** : le compactage atomique du journal (qui ne
  garderait que les tentatives ouvertes) et la rotation de l'historique.
  Le journal grossit sans limite ; le coût mesuré est donné dans
  [planification.md](../fr/planification.md) § 8.
- Les commits 5 (journal et gestionnaire) et 6 (reprise) proposés sont
  réunis, car la reprise est au cœur du gestionnaire.

Détails : [planification.md](../fr/planification.md),
[strategies.md](../fr/strategies.md) § 4,
[modeles.md](../fr/modeles.md) (numérotation des révisions).

## 16. Mise en œuvre de la Phase 1B.7 : contrats v8, journal compacté et simulateur

`CORE_CONTRACT_VERSION` passe à **8**.

| Élément | Changement | Raison |
|---|---|---|
| `JournalEvent` | Nouveaux événements `canvas-read-required` et `canvas-verified` ; lignes au format 2, avec un numéro de séquence global (le format 1 de la 1B.6 reste lisible) | Un événement manquant se voit ; un journal endommagé bloque les baux jusqu'à une lecture de la toile journalisée |
| `JournalState`, `ClosedAttempt` | État logique : tentatives ouvertes complètes, résumés des closes, `lastSpendAt` explicite, lecture de la toile exigée, générations préservées, `lastSeq` | Contenu des checkpoints ; équivalent au rejeu complet |
| `AttemptJournal` | `load(visitor)` (checkpoint puis événements, en flux), `append` → numéro de séquence, `compact(state)` ; `JournalLoadReport`, `CompactionReport` | Reprise à mémoire bornée, compactage |
| `AttemptManager` | `compact`, `state`, `canvasReadRequiredAfter`, `confirmCanvasRead` ; `get` renvoie un résumé pour une tentative close ; `RecoveryReport` enrichi (génération, séquences, dommage) | Mémoire et checkpoint bornés |

**Écarts avec le § 3** :
- le compactage atomique prévu est fait, mais il est **déclenché
  manuellement** : son déclenchement automatique viendra avec
  l'ordonnanceur ;
- la rotation de l'historique est faite.

**Décisions de mise en œuvre** :
- un compactage est refusé sur une génération endommagée ; seule une
  réparation confirmée, avec sauvegarde vérifiée et trace, publie la
  génération suivante ;
- une génération endommagée n'est jamais supprimée ;
- l'absence de pointeur alors que des générations existent est un refus,
  pas une génération 0.

Détails : [journal.md](../fr/journal.md), [simulateur.md](../fr/simulateur.md).

## 17. Mise en œuvre de la Phase 1B.8 : contrats v9, ordonnanceur mono-agent

`CORE_CONTRACT_VERSION` passe à **9**.

| Élément | Changement | Raison |
|---|---|---|
| Règle après dommage | `canvasReadRequiredAfter` et `confirmCanvasRead` remplacés par `damage` (plancher daté, jamais levé par une date) et `LeaseRequest.evidence` : chaque bail prouve une lecture postérieure au dommage, valide en chacun de ses points (`EVIDENCE_REQUIRED`) | En 1B.7, une lecture récente d'un seul pixel suffisait |
| `reconcile` | Accepte plusieurs lectures et ne clôt une tentative que si chacun de ses pixels a été observé (`INCOMPLETE_OBSERVATION`) | Une lecture partielle libérait des points incertains |
| `JournalState` | Schéma 2 (`damage`) ; le schéma 1 est relu et converti, `canvas-verified` n'a plus d'effet | Relecture prudente des données de la 1B.7 |
| `PlanRequest.damageFloor` | Lecture antérieure au dommage refusée, pixels inconnus jamais proposés tant qu'il existe | Cohérence avec la preuve exigée au bail |
| `AttemptJournal.stats`, `AutoCompactionPolicy`, `CompactionStatus`, `DEFAULT_AUTO_COMPACTION` | Compactage automatique ; `usable()` et `JOURNAL_UNAVAILABLE` | Journal borné sans intervention |
| `TaskScheduler` (couche 5) | Remplace le squelette : états, commandes (`start`, `pause`, `resume`, `stop`, `status`, `subscribe`, `done`, `step`), `SchedulerStatus`, `SchedulerEvent`, ports `TemplateSource` et `ResourceSource` | Ordonnanceur mono-agent opérationnel sur le simulateur |

**Décisions** :
- l'ordonnanceur ne contient aucune règle propre : il coordonne les
  composants existants ;
- un seul agent actif en V1 (liste conservée, multi-agent refusé) ;
- les attentes passent par `Clock.sleep`, sans boucle active ;
- une écriture sans réponse fiable n'est jamais relancée, et l'arrêt
  n'abandonne jamais une tentative démarrée.

Détails : [ordonnanceur.md](../fr/ordonnanceur.md), [journal.md](../fr/journal.md) § 3 et § 4.

## 18. Mise en œuvre de la Phase 1B.9 : serveur, toile durable, tableau de bord

Les contrats du core restent en version 9 : un seul changement de
comportement du core, une correction de l'ordonnanceur (ci-dessous).

| Élément | Décision | Raison |
|---|---|---|
| `@geoplacer/engine-service` | Nouveau paquet : service d'orchestration, `FileWorldStore`, réglages, flux d'événements | Séparer le moteur du serveur HTTP ; testable sous Vitest avec de vrais processus |
| Toile simulée durable | Changement préparé, enregistré (fsync), puis visible ; une écriture répond après | Une reprise du journal sans la toile ne serait pas une reprise complète |
| Identité du monde | Taille, repère, règles (id, version) : une différence exige une réinitialisation explicite, l'ancien monde est conservé | Jamais de perte silencieuse |
| Instance unique | Verrou dans le répertoire (inchangé), plus un canal nommé sous Windows (`node:net`, interface documentée) | Le garde ne remplace pas le verrou : deux écritures d'un même chemin peuvent donner deux noms |
| Serveur | Moteur ouvert avant l'écoute ; `src/` ne connaît que l'interface `EngineApi` | Refus d'une seconde instance sans écriture ; routes testées avec un moteur factice |
| `/api/v1` | Zod strict, codes stables, origine d'extension refusée, JSON exigé pour les écritures | Protections de la 1A conservées et renforcées pour les commandes |
| WebSocket | `hello` à la connexion, événements numérotés, regroupés (250 ms), client lent abandonné puis resynchronisé | Ne jamais bloquer le moteur ; jamais un message par pixel |
| Horloge du service | Réelle, monotone, jamais avant le monde sauvegardé | Les états datés ne remontent jamais le temps |
| Correction de l'ordonnanceur | Après l'observation des ressources, le cycle continue à l'heure de l'observation | `TIME_BEFORE_STATE` avec une horloge réelle (invisible avec l'horloge virtuelle) |
| Keep-alive hérité | Coupé par défaut (`LEGACY_KEEPALIVE=1` pour le rétablir) | Il contactait Wplace pour les comptes enregistrés |

Détails : [api-v1.md](../fr/api-v1.md), [websocket.md](../fr/websocket.md),
[reprise-apres-crash.md](../fr/reprise-apres-crash.md),
[architecture.md](../fr/architecture.md).
