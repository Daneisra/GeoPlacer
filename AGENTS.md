# GeoPlacer — règles permanentes

## Travail courant
- Lire ces règles, puis seulement les fichiers utiles à la demande.
- Commencer par `git status --short`, branche courante et HEAD ; préserver le travail existant.
- Respecter le périmètre et les autorisations de la session ; ne pas redemander un accord acquis.
- Chercher avec `rg` ; lire des extraits ciblés, pas des dossiers ou historiques entiers.
- Les Phases 2A–2E sont acquises : consulter leurs rapports uniquement si nécessaire.
- Pas de nouvel audit, clone, benchmark ou rapport détaillé sans besoin démontré.
- Préférer un correctif limité ; ne pas refondre, reformater ou ajouter des dépendances sans raison.

## Architecture et garanties
- `packages/core` : logique pure, géométrie, couleurs, stratégies, progression et planification.
- `packages/adapters-node` : entrées/sorties Node, images et persistance.
- `packages/simulator` : simulation de référence, à conserver fonctionnelle.
- `packages/engine-service` : orchestration, fournisseurs, journaux, checkpoints et reprise.
- `src` : serveur, API `/api/v1` et WebSocket ; `frontend` : dashboard React.
- `browser` : lecteur GeoPixels et transport privilégié ; aucun scheduler de peinture supplémentaire.
- Réutiliser TemplateManager, WorkPlanner, AttemptManager/Journal, ResourceManager et TaskScheduler.
- Réutiliser ProgressCalculator, EtaEstimator, quantification OKLab et export PNG existants.
- Distinguer simulation, fournisseur factice et observations réelles dans les états et l'interface.
- Inconnu ≠ incorrect ; cache relu ≠ source actualisée ; expiration par pixel maintenue à 30 s.
- Préserver identité du modèle/position/session, couverture, séquences et réconciliation.
- Lecteur réel en lecture seule : pas de récupération automatique de tuiles, cookies ou tokens du site.
- Conserver couplage volontaire, approbation, capacités éphémères, révocation et contrôles locaux.
- Écritures/achats réels désactivés ; leur évolution exige un périmètre explicite et un essai interactif autorisé.
- Ne pas réactiver les anciennes routes Wplace ni fusionner les dépôts indépendants.

## Validation proportionnée
- Sous Windows, utiliser `npm.cmd` / `npx.cmd` ; Node >= 22.12, npm >= 10.
- Pendant le développement : tests des comportements touchés, puis contrôles des consommateurs concernés.
- Jest ciblé : `npm.cmd run test:legacy -- --runInBand src/__tests__/<fichier>.test.ts`.
- Vitest ciblé : `npm.cmd run test --workspace=@geoplacer/engine-service -- test/<fichier>.test.ts`.
- Adapter le workspace ; ses chemins de tests sont relatifs au paquet.
- Recompiler les packages si leurs contrats changent : `npm.cmd run build:packages`.
- Lint ciblé backend : `npx.cmd eslint src/<fichier>.ts` ; frontend : `npm.cmd run lint:frontend`.
- Avant publication ou livraison majeure : `npm.cmd run check:logged`, puis `node scripts/run-logged.mjs build`.
- Le contrôle complet inclut Jest, Vitest, types et lints : ne pas les relancer séparément sans raison.
- Réutiliser `scripts/recette-connecteur.mjs` pour une modification du parcours navigateur concerné.
- Installation/clone neuf seulement si installation, packaging ou dépendances changent, ou sur demande.
- Benchmarks seulement pour une question de performance ; mocks locaux, jamais de placement/achat réel.
- Documentation seule : vérifier contenu, liens, commandes et `git diff --check` ; pas de tests applicatifs.
- Garder les journaux utiles sous `test-logs/` ; afficher résumé, échec pertinent et chemin du log.
- Après un contrôle vert, répéter seulement si modification, échec ou incertitude nouvelle le justifie.
- Ne pas masquer un défaut par un timeout accru ; ne déclarer réel que ce que l'utilisateur confirme.

## Git, sauvegardes et publication
- Développer hors `main` ; conserver branches historiques, sauvegardes, données ignorées et attributions AGPL.
- Avant commit : examiner fichiers inclus, diff, secrets et `git diff --check` ; staging explicite.
- Créer des commits locaux cohérents seulement quand autorisés ; ne pas réécrire l'historique existant.
- Push, PR, promotion de main, tag, release, suppression ou déplacement : autorisation explicite ciblée.
- Avant publication autorisée : fetch sans prune, vérifier remotes/base et seulement les commits sortants.
- Vérifier secrets/licence, contrôles complets, push à blanc puis normal ; confirmer le SHA distant.
- Origin vise le fork ; upstream reste en lecture seule sauf autorisation explicite contraire.
- Sauvegardes externes seulement dans le périmètre autorisé ; vérifier empreinte et restauration si requises.
- Pas de force, `gc`, `prune`, `clean -fd` ou `reset --hard` sans autorisation dédiée.

## Communication et références
- Donner de brefs points d'avancement utiles ; éviter répétitions et comptes rendus disproportionnés.
- Final : résultat, vérifications, limites pertinentes et commit ; arrêter au périmètre demandé.
- Prompts : `docs/fr/PROMPTS-CODEX.md` ; qualité détaillée : `docs/fr/qualite.md`.
- Lecteur : `docs/fr/phase2c-lecteur-http.md` ; état validé : `docs/fr/RAPPORT-PHASE2E.md`.
