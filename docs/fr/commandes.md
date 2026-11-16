# Commandes (Phase 1B.10)

Toutes les commandes se lancent depuis le dossier du projet, dans
PowerShell ou l'invite de commandes. GeoPlacer V1 est une simulation
locale : aucune de ces commandes ne contacte un service de dessin réel.

## Utilisation

| Commande | Effet |
|---|---|
| `npm run setup:windows` (ou double-clic sur `setup.bat`) | Installation complète en une commande : vérifications, dépendances, binaire `canvas` précompilé, compilation, dossiers, `.env`, démarrage de contrôle. Journal dans `test-logs\` |
| `start.bat` | Installe si nécessaire, puis lance GeoPlacer dans la même fenêtre |
| `start.bat --demo` | Idem, sur le dossier de démonstration `data\demo` |
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
| `npm run bench:scheduler`, `bench:planner`, `bench:progress`… | Mesures des composants du moteur |
