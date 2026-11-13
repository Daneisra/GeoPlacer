# ADR 0002 : nouveau moteur (Phase 1B)

- **Date** : 13/11/2026
- **Statut** : **proposé**, en attente de validation
- **Interfaces** : [`0002-interfaces-proposees.ts`](0002-interfaces-proposees.ts).
  Vérifiées avec `tsc` en mode `strict`, avec `exactOptionalPropertyTypes`
  et `noUncheckedIndexedAccess`.

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

## 7. Décisions à valider

1. Travail dérivé plutôt que matérialisé (§ 3).
2. OKLab comme distance de couleur par défaut.
3. Format de stockage des modèles côté serveur : PNG avec métadonnées JSON,
   via une bibliothèque PNG en JavaScript pur, pour se passer à terme de
   `canvas`.
4. `SnapshotCanvasProvider` : suivi de progression réel à partir d'une image
   de la zone importée **manuellement** par l'utilisateur.
5. Moment du déplacement de `src/` et `frontend/` sous `apps/`.
