# Architecture de GeoPlacer

État : **Phase 1B.0**. L'espace de travail du nouveau moteur est en place ;
seuls les contrats existent. Le serveur et l'interface hérités de Wplacer
fonctionnent comme avant.

## Arborescence

```
GeoPlacer/
├── packages/                     nouveau moteur (espaces de travail npm)
│   ├── core/                     @geoplacer/core
│   │   ├── src/
│   │   │   ├── index.ts          point d'entrée public
│   │   │   └── contracts/        interfaces et constantes, sans algorithme
│   │   ├── test/                 Vitest (constantes, types, architecture)
│   │   ├── tsconfig.json         compilation (sans types Node ni DOM)
│   │   ├── tsconfig.test.json    vérification des sources et des tests
│   │   └── vitest.config.ts
│   └── simulator/                @geoplacer/simulator (squelette, dépend de core)
├── src/                          serveur hérité (Express, Jest) — inchangé
├── frontend/                     interface React héritée — inchangée
├── tsconfig.base.json            configuration stricte commune aux paquets
└── tsconfig.json                 configuration du serveur hérité
```

Le déplacement de `src/` vers `apps/server` et de `frontend/` vers `apps/web`
est une décision séparée, qui n'est pas encore prise (ADR 0002, § 7).

## Règles de dépendance

```
@geoplacer/simulator  ──►  @geoplacer/core  ◄──  (futur) serveur
```

- `core` ne dépend d'**aucun** paquet externe, d'aucun module Node et d'aucune
  API du navigateur. Il n'effectue aucune entrée/sortie. Un test
  d'architecture le vérifie à chaque exécution.
- `simulator` dépend de `core` (référence de projet TypeScript). L'inverse
  est interdit, ce qui exclut tout cycle entre paquets.
- Dans `core`, les contrats sont organisés en couches ; un fichier n'importe
  que des couches inférieures (vérifié par test) :

| Couche | Fichiers | Contenu |
|---|---|---|
| 0 | `primitives`, `config` | Identifiants nominaux, `Rgb`, sentinelles de transparence, `Clock`, `EngineConfig` |
| 1 | `geometry`, `palette`, `resources`, `accounts` | `Projection`, `PaletteManager`, `ColorDistance`, `ResourceManager`, `UpgradePlanner`, `AccountManager` |
| 2 | `template`, `canvas` | `TemplateManager`, métadonnées PNG + JSON, `CanvasReader`, `CanvasWriter`, `CanvasProvider` |
| 3 | `strategy`, `work`, `progress` | `DrawingStrategy`, `WorkPlanner`, `AttemptManager`, journal, historique, `ProgressCalculator`, `EtaEstimator` |
| 4 | `scheduler` | `TaskScheduler`, événements du moteur |

## Séparation des responsabilités

| Niveau | Emplacement | Phase |
|---|---|---|
| Contrats (interfaces, constantes) | `packages/core/src/contracts/` | 1B.0 (fait) |
| Logique métier pure | `packages/core/src/<domaine>/` | 1B.1 à 1B.8 |
| Implémentations simulées | `packages/simulator/src/` | 1B.7 |
| Adaptateurs d'E/S (fichiers, WebSocket) | serveur | 1B.9 |

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
