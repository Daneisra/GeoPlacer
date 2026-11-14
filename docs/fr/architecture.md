# Architecture de GeoPlacer

État : **Phase 1B.6**. Les contrats existent depuis la 1B.0 ; la géométrie,
les couleurs et les palettes sont implémentées en 1B.1 (voir
[geometrie-couleurs.md](geometrie-couleurs.md)) ; le gestionnaire de
modèles et sa persistance en 1B.2 (voir [modeles.md](modeles.md)) ; les
huit stratégies de dessin en 1B.3 (voir [strategies.md](strategies.md)) ;
la progression et le temps restant en 1B.4 (voir
[progression.md](progression.md)) ; les ressources et les améliorations
en 1B.5 (voir [ressources.md](ressources.md)) ; la planification du
travail, les tentatives et la reprise après crash en 1B.6 (voir
[planification.md](planification.md)).
Le serveur et l'interface hérités de Wplacer fonctionnent comme avant.

## Arborescence

```
GeoPlacer/
├── packages/                     nouveau moteur (espaces de travail npm)
│   ├── core/                     @geoplacer/core
│   │   ├── src/
│   │   │   ├── index.ts          point d'entrée public
│   │   │   ├── contracts/        interfaces et constantes, sans algorithme
│   │   │   ├── geometry/         projection, rectangles, limites, conversion de repère (1B.1)
│   │   │   ├── color/            RVB, OKLab, distances (1B.1)
│   │   │   ├── palette/          palettes par agent, plus proche couleur, quantification (1B.1)
│   │   │   ├── template/         gestionnaire de modèles, manifeste, révisions, stockage mémoire (1B.2)
│   │   │   ├── strategy/         8 stratégies de dessin, région éligible, PCG32 (1B.3)
│   │   │   ├── canvas/           instantané de toile en mémoire (1B.4)
│   │   │   ├── progress/         progression et estimation du temps restant (1B.4)
│   │   │   ├── resources/        règles, états d'agent, régénération, ResourceManager (1B.5)
│   │   │   ├── upgrades/         planificateur d'améliorations simulées (1B.5)
│   │   │   └── work/             WorkPlanner, AttemptManager, format du journal (1B.6)
│   │   ├── bench/                benchmarks (npm run bench:core, bench:strategies, bench:planner…)
│   │   ├── test/                 Vitest (dont la suite de conformité des stockages)
│   │   ├── tsconfig.json         compilation (sans types Node ni DOM)
│   │   ├── tsconfig.test.json    vérification des sources et des tests
│   │   └── vitest.config.ts
│   ├── adapters-node/            @geoplacer/adapters-node : stockage fichiers, verrou du répertoire
│   │                             de données (1B.3), codec PNG (pngjs), SHA-256, UUID, horloge ;
│   │                             cache d'ordre, journal des tentatives et historique (1B.6) ;
│   │                             benchmarks bench:templates, bench:reservations, bench:journal
│   └── simulator/                @geoplacer/simulator (squelette, dépend de core)
├── scripts/run-logged.mjs        contrôles avec journal complet dans test-logs/ (1B.4)
├── src/                          serveur hérité (Express, Jest) — inchangé
├── frontend/                     interface React héritée — inchangée
├── tsconfig.base.json            configuration stricte commune aux paquets
└── tsconfig.json                 configuration du serveur hérité
```

Le déplacement de `src/` vers `apps/server` et de `frontend/` vers `apps/web`
est une décision séparée, qui n'est pas encore prise (ADR 0002, § 7).

## Règles de dépendance

```
@geoplacer/simulator      ──►  @geoplacer/core  ◄──  (futur) serveur
@geoplacer/adapters-node  ──►  @geoplacer/core
```

- `core` ne dépend d'**aucun** paquet externe, d'aucun module Node et d'aucune
  API du navigateur. Il n'effectue aucune entrée/sortie. Un test
  d'architecture le vérifie à chaque exécution.
- `simulator` et `adapters-node` dépendent de `core` (références de projet
  TypeScript). L'inverse est interdit, ce qui exclut tout cycle entre
  paquets. `adapters-node` n'a qu'une autre dépendance : `pngjs` 7.0.0
  (JavaScript pur, MIT), vérifiée par test.
- Les entrées/sorties du gestionnaire de modèles passent par des **ports**
  (`TemplateStorage`, `PngCodec`, `Hasher`, `IdSource`, `TimeSource`),
  définis dans `core` et implémentés par `adapters-node` ou par les tests.
- Dans `core`, le dossier `strategy/` n'importe que `contracts/` et
  `geometry/` (vérifié par test) : les stratégies ne connaissent ni le
  gestionnaire de modèles, ni la toile, ni l'ordonnanceur, ni les comptes.
- Dans `core`, les contrats sont organisés en couches ; un fichier n'importe
  que des couches inférieures (vérifié par test) :

| Couche | Fichiers | Contenu |
|---|---|---|
| 0 | `primitives`, `config` | Identifiants nominaux, `Rgb`, sentinelles de transparence, `Clock`, `EngineConfig` |
| 1 | `geometry`, `palette`, `resources`, `accounts`, `ports` | `Projection`, `PaletteManager`, `ColorDistance`, `ResourceManager`, `AccountManager`, ports d'E/S (dont les réservations de numéros, 1B.6) |
| 2 | `template`, `canvas` | `TemplateManager`, manifeste et révisions, `CanvasReader`, `CanvasWriter`, `CanvasProvider` |
| 3 | `strategy`, `progress` | `DrawingStrategy`, cache d'ordre, `ProgressCalculator`, `EtaEstimator` |
| 4 | `work`, `upgrades` | `WorkPlanner`, `AttemptManager`, journal, historique (1B.6 : passés de la couche 3 à la 4, car ils dépendent de `progress`) ; `UpgradePlanner` |
| 5 | `scheduler` | `TaskScheduler`, événements du moteur |

## Séparation des responsabilités

| Niveau | Emplacement | Phase |
|---|---|---|
| Contrats (interfaces, constantes) | `packages/core/src/contracts/` | 1B.0 (fait) |
| Logique métier pure | `packages/core/src/<domaine>/` | 1B.1 (géométrie, couleurs, palettes : fait) à 1B.8 |
| Implémentations simulées | `packages/simulator/src/` | 1B.7 |
| Adaptateurs d'E/S Node (fichiers, PNG, SHA-256) | `packages/adapters-node/src/` | 1B.2 (modèles : fait) |
| Branchement au serveur, WebSocket | serveur | 1B.9 |

## Principes structurants

- **Un seul agent actif en V1.** `EngineConfig.maxActiveAgents` vaut
  `DEFAULT_MAX_ACTIVE_AGENTS = 1` en production. Les essais multi-agents se
  font **uniquement** sur le simulateur local.
- **Lecture et écriture séparées.** Un fournisseur d'instantanés importés
  (`ReadOnlyCanvasProvider`) n'a pas de `writer`. L'ordonnanceur exige un
  `ReadWriteCanvasProvider` : une commande de placement vers un instantané
  est impossible à la compilation.
- **Instantanés datés.** Chaque `CanvasSnapshot` porte sa `source`
  (`simulated` ou `imported-snapshot`) et son `observedAt`. Une progression
  mesurée sur un instantané importé n'est donc pas confondue avec une
  progression simulée.
- **Travail dérivé.** Le travail restant est calculé à partir du modèle, de
  la stratégie et d'un instantané ; seules les tentatives en cours et
  l'historique sont persistés (ADR 0002, § 3).
- **Aucune intégration non autorisée.** Aucun fournisseur n'écrit sur un
  service public.

Dépendances autorisées entre dossiers de `core` (vérifiées par test, avec
détection de cycles sur tout `src`) :

| Dossier | Peut importer |
|---|---|
| `contracts` | `contracts` |
| `geometry` | `contracts`, `geometry` |
| `color` | `contracts`, `color` |
| `palette` | `contracts`, `color`, `palette` |
| `template` | `contracts`, `color`, `palette`, `geometry`, `template` |
| `strategy` | `contracts`, `geometry`, `strategy` |
| `canvas` | `contracts`, `geometry`, `canvas` |
| `progress` | `contracts`, `geometry`, `strategy`, `resources`, `progress` |
| `resources` | `contracts`, `resources` |
| `upgrades` | `contracts`, `resources`, `progress`, `upgrades` |
| `work` | `contracts`, `geometry`, `strategy`, `progress`, `resources`, `template` (uniquement le CRC-32 partagé des lignes du journal), `work` |

## Limites des contrôles automatiques

- Le test d'architecture vérifie les **imports** (aucun paquet externe,
  aucun module `node:`). L'absence d'API Node ou DOM utilisées comme
  globales est garantie par la compilation de `core` (`types: []`), pas par
  ce test.
- Les garanties de types (`@ts-expect-error`) ne sont vérifiées que par
  `npm run typecheck:packages`, inclus dans `npm run test:all` et
  `npm run check`.

## Documentation héritée

Le `README.md` racine (section d'installation) et `docs/*.md` en anglais
viennent du projet d'origine et ne sont pas mis à jour. Ils décrivent
encore un `.env` suivi par Git et les anciennes commandes. La documentation
à jour est en français, dans `docs/fr/`.

## Commandes

Voir [installation-windows.md](installation-windows.md) § 4 et
[qualite.md](qualite.md).
