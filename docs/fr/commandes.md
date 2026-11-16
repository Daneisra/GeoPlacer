# Commandes (Phase 1B.10, complétées en 1C.0)

Toutes les commandes se lancent depuis le dossier du projet, dans
PowerShell ou l'invite de commandes. GeoPlacer V1 est une simulation
locale : aucune de ces commandes ne contacte un service de dessin réel.

## Utilisation

| Commande | Effet |
|---|---|
| `npm run setup:windows` (ou double-clic sur `setup.bat`) | Installation complète en une commande : vérifications, dépendances, binaire `canvas` précompilé, compilation, dossiers, `.env`, démarrage de contrôle. Journal dans `test-logs\` |
| `start.bat` | Vérifie l'installation (`--check`) : installe si nécessaire (première fois, installation interrompue, dépendances modifiées), recompile si le code a changé, puis lance GeoPlacer dans la même fenêtre |
| `node scripts/setup-windows.mjs --check` | État de l'installation, sans rien écrire : 0 à jour, 1 installation nécessaire, 2 recompilation nécessaire |
| `start.bat --demo` | Idem, sur le dossier de démonstration `data\demo` |
| `update.bat` | Hérité du projet d'origine : `git pull`, puis l'installation de GeoPlacer (`scripts\setup-windows.mjs`). Si Git est absent, il explique comment l'installer et s'arrête, sans rien installer (testé avec un `PATH` sans Git) |
| `npm start` | Lance GeoPlacer compilé : `http://127.0.0.1:3000` |
| `npm run demo` | Lance la démonstration, dans le dossier séparé `data\demo` (voir [demonstration.md](demonstration.md)) |
| **Ctrl+C** (une fois) | Arrêt propre : la simulation s'arrête après l'écriture en cours |

## Sauvegarde et restauration

GeoPlacer arrêté (voir [sauvegarde-restauration.md](sauvegarde-restauration.md)) :

| Commande | Effet |
|---|---|
| `npm run backup` | Sauvegarde `data\engine` dans `sauvegardes\geoplacer-sauvegarde-<date>\` |
| `npm run backup -- --data data\demo` | Sauvegarde la démonstration |
| `npm run backup:verify -- <dossier>` | Vérifie une sauvegarde (lecture seule) |
| `npm run restore -- <dossier>` | Restaure ; les données actuelles sont conservées dans `data\engine.avant-restauration-<date>` |
| `npm run restore -- --resume` | Termine ou annule une restauration interrompue |
| `npm run restore -- <dossier> --allow-kind-change` | Restaure malgré tout une sauvegarde de la démonstration dans un projet (ou l'inverse) ; refusé sans cette option |

Options communes : `--data <dossier du moteur>`, `--out <dossier des
sauvegardes>`.

## Journal des tentatives

| Commande | Effet |
|---|---|
| `npm run journal:diagnose -- data\engine` | Diagnostic en lecture seule (voir [diagnostic.md](diagnostic.md)) |
| `npm run journal:repair -- data\engine` | Plan de réparation ; appliqué seulement avec `--apply <identifiant du plan>` |

## Développement

| Commande | Effet |
|---|---|
| `npm run dev` | Serveur (rechargé à chaque modification) et interface Vite (`http://localhost:5173`) |
| `npm run dev:backend` / `npm run dev:frontend` | L'un des deux seulement |
| `npm run build` | Paquets du moteur, serveur, interface |
| `npm run check` | Contrôle complet : compilation, lint du serveur, des paquets et de l'interface, types de l'interface, tests Jest et Vitest |
| `npm run check:logged` | Idem, sortie complète conservée dans `test-logs\` |
| `npm test` | Tests Jest du serveur |
| `npm run test:packages` | Tests Vitest des paquets |
| `npm run lint`, `lint:packages`, `lint:frontend` | ESLint : 0 erreur partout ; 0 avertissement pour les paquets et l’interface (65 avertissements hérités `no-explicit-any` dans `src/`) |
| `npm run typecheck:frontend` | Types de l'interface |

## Recettes et mesures

| Commande | Effet |
|---|---|
| `node scripts/recette-simulation.mjs <dossier> [--quick]` | Recette de la Phase 1B.10 dans Edge ; Firefox avec `GEOPLACER_BROWSER_ENGINE=firefox`. Demande `GEOPLACER_PLAYWRIGHT_CORE`, un `playwright-core` installé **hors du dépôt** (voir [recette-navigateur.md](recette-navigateur.md)) |
| `node scripts/recette-navigateur.mjs` | Recette de l'interface (Phase 1B.7, mise à jour en 1B.10) |
| `npm run bench:responsiveness -- <côté> <secondes> [full\|incremental]` | Réactivité du serveur pendant une simulation (voir [qualite.md](qualite.md)) |
| `node --expose-gc --import tsx packages/engine-service/bench/blocking.bench.ts <côté> <secondes>` | Ce qui bloque la boucle d'événements : blocages horodatés, attribués par profil CPU (Phase 1C.0) |
| `node --import tsx packages/engine-service/bench/worker-transfer.bench.ts <côté>` | Coût d'un worker thread (envoi d'un instantané) |
| `node scripts/recette-arret-windows.mjs <GeoPlacer installé> <compte rendu>` | Recette d'arrêt : événement Ctrl+C, reprise, sauvegarde, restauration |
| `node scripts/audit-installation-windows.mjs <dépôt> <branche> <dossier neuf>` | Audit d'installation sur clone neuf (espaces et accents, installation interrompue, mises à jour, droits) |
| `npm run bench:scheduler`, `bench:planner`, `bench:progress`… | Mesures des composants du moteur |
