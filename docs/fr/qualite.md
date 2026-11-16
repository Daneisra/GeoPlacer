# Qualité : tests, lint et outillage

## Commandes

Deux lanceurs coexistent (Phase 1B.0) : **Jest** pour le serveur hérité
(`src/__tests__`), **Vitest** pour les nouveaux paquets (`packages/*`).
Aucune migration globale de Jest vers Vitest n'est prévue à ce stade.

```powershell
npx tsc --noEmit              # types du serveur hérité (strict)
npm run test:legacy           # Jest (identique à « npm test »)
npm run lint                  # ESLint backend
npm run typecheck:packages    # types des paquets, tests compris
npm run test:packages         # Vitest
npm run lint:packages         # ESLint des paquets
npm run test:all              # typecheck des paquets, puis Jest, puis Vitest
npm run lint:frontend         # ESLint de l'interface, 0 avertissement toléré (1B.10)
npm run typecheck:frontend    # types de l'interface (1B.10)
npm run check                 # tsc, lint du serveur, des paquets et de l'interface, types de l'interface, puis test:all
npm run check:logged          # idem, sortie complète dans test-logs\
```

Sur un **clone neuf**, `npm run build` construit aussi le frontend, qui a
ses propres dépendances hors des workspaces. Il faut donc lancer
`cd frontend; npm ci` en plus du `npm ci` racine, sinon le build échoue
dans `frontend` (modules `react`, `vite`… introuvables). C'est vérifié en
Phase 1B.8 : les tests passent sans cette étape, le build la requiert.

## Phase 1C.0 : version candidate

**`npm run check:logged`** (dépôt, commit `2a52df2`, code de sortie 0, 407 s,
machine à 35 %) :
- Jest : 16 suites, **151 tests** (145 en 1B.10) ;
- Vitest : 49 fichiers, **546 tests** + 1 exhaustif optionnel :
  - core 368 ;
  - adapters-node 66 ;
  - engine-service 62 ;
  - simulator 50 ;
- lint du serveur : 0 erreur, **47 avertissements** (65 en 1B.10 ; aucune
  règle désactivée) ; paquets et interface : 0 ;
- `npm run build` : réussi.

**Contrôle final** (commit `a498816`, après la relecture : protection des
dossiers de démonstration mis de côté, test du compactage pendant une
cession, test de sauvegarde corrigé) : code de sortie 0, Jest 151, Vitest
**547** + 1 optionnel (simulator 51), lint 0 erreur, build réussi. Le
contrôle précédent (`ff55fe9`) avait échoué sur un test, cause démontrée
ci-dessous.

**Clone neuf** (commit `2a52df2`, cache npm vide, `npm run setup:windows`) :
mêmes résultats (151 + 546 tests, 0 échec) ; build réussi ; recettes Edge et
Firefox complètes à 0 échec, recette 1B.7 à 29/0, recette d'arrêt réussie
(voir [recette-navigateur.md](recette-navigateur.md)). Audit d'installation :
0 échec (voir [installation-windows.md](installation-windows.md)).

**Tests ajoutés** :

| Où | Fichier | Couvre |
|---|---|---|
| core | `slices.test.ts` | Calcul découpé = calcul synchrone pour toutes les tailles de tranche ; progression incrémentale découpée = calcul complet à chaque pas ; appel abandonné à **chaque** frontière de tranche sans effet ; `invalidate()` pendant un appel ; abandon asynchrone |
| simulator | `cooperative.test.ts` | Ordonnanceur coopératif : même course qu'avant avec des cessions vides ; action injectée à la k-ième cession, pour k réparti sur toute la course et pour toutes les cessions des premiers cycles : acteur extérieur, déplacement du modèle, pause, arrêt avec abandon ; aucun bail après une pause ou un arrêt, rien à l'ancienne position après un déplacement, rien appliqué deux fois |
| engine-service | `backup-scenarios.test.ts` | Démonstration interrompue, sauvegardée, restaurée dans un nouveau dossier puis terminée ; plusieurs modèles et révisions ; restauration répétée ; démonstration et projet jamais mélangés |
| engine-service | `service.test.ts` | Acteur extérieur simulé : nombre exact, seulement des pixels peints, plafonné, repeints |
| serveur | `release-safety.test.ts` | Keep-alive jamais appelé ; `.env.example`, scripts et `package.json` sans fonction héritée ; `update.bat` sans winget |
| serveur | `validation-express5.test.ts` | Validateurs de requête sur une vraie application Express 5 |

**Contre-épreuves (mutations)** : sans la vérification de révision avant le
bail, le test de déplacement échoue (pixels peints à l'ancienne position) ;
sans la vérification de pause et d'arrêt avant le bail, les tests de pause
et d'arrêt échouent (bail pris après la demande) ; le test des validateurs
échoue sur l'ancien code (500 au lieu de 200).

**Défauts trouvés pendant la phase** :
- par l'audit d'installation : Node.js dans un chemin avec espaces (étape
  `canvas`), constante utilisée avant son initialisation, archive cherchée
  dans le mauvais cache (empreinte jamais vérifiée) ; voir
  [installation-windows.md](installation-windows.md) ;
- par la revue des avertissements de lint : `validateQuery` répondait 500
  sous Express 5 ;
- par la recette Firefox de la 1B.10 : heures au format anglais (corrigé
  en 1B.10) ;
- par le diagnostic : l'acteur extérieur simulé créait un objet par pixel ;
  le banc de réactivité mesurait mal la latence HTTP.

**Délais intermittents et échecs : suivi.**
- **Cause démontrée (nouvelle)** : le test de crash exigeait, aux étapes de
  point de contrôle de la toile, qu'une écriture soit démarrée au moment où
  le processus est tué. C'est une course entre deux suites d'E/S
  indépendantes (le point de contrôle, le journal de la tentative suivante) ;
  le produit ne la garantit pas. Échecs constatés avec et sans cession,
  journaux conservés. Non re-mesuré sur le code d'avant la 1C.0 (la version
  de la 1B.9 de ce test passait ; son timing a pu être différent). Exigence
  retirée à ces étapes, garanties de reprise toujours vérifiées ; trois
  passages consécutifs réussis.
- **Cause démontrée** : un délai de test trop court pour une démonstration
  qui avance en temps réel (scénario de sauvegarde) ; porté à 240 s.
- **Cause démontrée** : échec du contrôle complet final (commit `ff55fe9`,
  journal conservé) dans le même scénario, écart de 40 pixels, exactement un
  lot de la démonstration. Le test prenait pour référence le `correct` du
  statut de l'ordonnanceur, calculé au début du dernier cycle, avant
  l'écriture de son lot ; un arrêt juste après une écriture le décalait d'un
  lot. Le test compte désormais les pixels corrects sur la toile ; le
  produit n'était pas en cause.
- **Charge de la machine** : les mesures de performance faites quand la
  machine était occupée à 85-97 % par un autre logiciel sont environ deux
  fois plus lentes ; elles sont identifiées comme telles, et les mesures de
  référence ont été refaites au calme.
- Les causes supposées des phases précédentes (antivirus sur un clone neuf)
  restent non démontrées.

## Phase 1B.10 : stabilisation, sécurisation, démonstration

**Clone neuf, procédure documentée seulement** (16/11/2026) : dépôt cloné
dans un dossier vide, cache npm **vide**, puis `npm run setup:windows`
(six étapes réussies, 3 min 40 environ), `npm run check:logged`,
`npm run build`, recettes et mesures. Journaux complets conservés hors du
dépôt.

**`npm run check:logged`** sur le clone (commit `fd10b98`, code de sortie 0) :
- Jest : 14 suites, **145 tests** (122 en 1B.9) ;
- Vitest : 46 fichiers, **530 tests** + 1 exhaustif optionnel :
  - core 363 ;
  - adapters-node 66 ;
  - engine-service 57 ;
  - simulator 44 ;
- lint du serveur : 0 erreur (65 avertissements hérités `no-explicit-any`) ;
- lint des paquets : 0 ;
- **lint de l'interface : 0 erreur, 0 avertissement** (17 erreurs et 3
  avertissements hérités en 1B.9), désormais inclus dans `npm run check`
  avec `--max-warnings 0` ; types de l'interface vérifiés ;
- `npm run build` : réussi (26 s).

Le contrôle complet a été refait sur le commit final (voir le rapport de
phase). **Second clone neuf** (cache vide, `core.autocrlf=false`) :
installation par `start.bat` seul, puis `start.bat`, `setup.bat`,
`update.bat`, `npm start` et `npm run dev` vérifiés (voir
[installation-windows.md](installation-windows.md) § 2).

**Erreurs de données** : dans le navigateur, la recette couvre un réglage
refusé. Les sauvegardes corrompues, incomplètes, modifiées ou
incompatibles, la toile simulée endommagée et le modèle hors de la toile
sont couverts par des tests automatisés seulement (`backup.test.ts`,
`world-store.test.ts`, `large-display.test.ts`).

**Tests ajoutés** :

| Où | Fichier | Couvre |
|---|---|---|
| serveur | `legacy-isolation.test.ts` | Chaque route héritée désactivée : 410 `LEGACY_DISABLED` avant son traitement ; contournements (casse, barre finale, `HEAD`, démarrage déguisé) ; routes locales conservées ; client réseau hérité fermé ; aucune connexion hors boucle locale |
| serveur | `server-engine.test.ts` | Serveur réel : `LEGACY_KEEPALIVE=1` ignoré, `POST /user` refusé, écoute sur `127.0.0.1`, aucun fichier servi hors des dossiers prévus (chemins encodés compris) |
| serveur | `engine-api.test.ts` | Routes `/backup` (aucun chemin accepté du client : 400) et `/demo` |
| engine-service | `backup.test.ts` | Sauvegarde restaurée dans un autre dossier puis reprise sans repeindre ; refus pendant l'exécution ; sauvegarde corrompue, incomplète, modifiée, incompatible ou incohérente refusée sans toucher aux données ; données précédentes conservées ; ligne de commande en français ; **vrais processus tués à chaque étape de la restauration**, reprise ou annulation |
| engine-service | `demo.test.ts` | Image d'exemple déterministe, opaque, couleurs débloquées ; préparation sur un projet vide puis démarrage ; refus sur un projet qui a des données (rien n'est modifié) et pendant une simulation |
| engine-service | `i18n.test.ts` | Chaque code d'erreur, code d'estimation et de refus d'amélioration, raison d'état (y compris chaque littéral du code de l'ordonnanceur) a sa traduction ; avis, verdicts, paramètres ; repli marqué pour l'inconnu |
| engine-service | `large-display.test.ts` | 256², 1000², 2000², 4096² et non carrés affichés entiers au zoom d'ajustement, proportions, lecture bornée ; zoom et déplacement bornés ; correspondance pixel de toile, pixel affiché, axe Y dans les deux sens ; toile 4096² lue entière, chaque échantillon exact ; modèle non carré : superposition alignée et pixels affichés conformes aux compteurs du moteur ; modèle partiellement hors toile refusé |
| engine-service | `service.test.ts` | Simulation complète, sauvegarde et diagnostics sans aucune connexion réseau |
| core | `progress-incremental.test.ts` | Égalité exacte avec le calcul complet, reconstructions, désaccord détecté et corrigé |

**Contre-épreuves** :
- sans le verrou des routes héritées, 16 tests d'isolation échouent ;
- la recette Firefox avec le nouveau contrôle des heures, sur l'interface
  d'avant le correctif : 1 échec attendu (« 1:03:35 AM »), puis 0 après.

**Recettes** (clone neuf) : Edge complet 0 échec, Firefox de Playwright
complet 0 échec, recette 1B.7 29 contrôles 0 KO, arrêt par événement
Ctrl+C réel sur la console de `start.bat` réussi deux fois (voir
[recette-navigateur.md](recette-navigateur.md)).

**Mesures sur le clone** (`npm run bench:responsiveness`), **machine
chargée** : un autre logiciel occupait le processeur (94 % mesurés juste
après). Les valeurs absolues sont donc environ deux fois moins bonnes que
celles de [progression.md](progression.md) § 6, mesurées machine calme ;
la comparaison des deux modes, faite dans les mêmes conditions, reste
valable.

| Modèle | Mode | Import | Premier lot | Cycle médian / p95 | Débit | HTTP médian / max | Événements `status` : écart médian / max | Mémoire |
|---|---|---|---|---|---|---|---|---|
| 256² | incrémental | 0,2 s | 0,4 s | 28 / 45 ms | 29 084 px/s | 2,6 / 22 ms | 256 / 371 ms | 184 Mio |
| 2000² | complet | 2,4 s | 1,2 s | 403 / 485 ms | 2 394 px/s | 4,0 / 33 ms | 403 / 1 139 ms | 223 Mio |
| 2000² | incrémental | 2,2 s | 1,0 s | 238 / 459 ms | 3 759 px/s | 3,1 / 28 ms | 454 / 924 ms | 231 Mio |
| 4096² | incrémental | 8,8 s | 3,6 s | 876 / 1 770 ms | 1 002 px/s | 3,5 / 26 ms | 875 / 3 547 ms | 566 Mio |

Lecture d'une région de 2000² ou 4096² pour l'affichage : 83 à 86 ms,
environ 21 Mio de JSON ; l'interface ne lit que la zone visible, à
l'échelle de l'affichage. Sous cette charge, l'attente maximale de la
boucle d'événements atteint 2,7 s à 4096² (0,67 s à 2000²) ; les requêtes
HTTP mesurées sont restées sous 35 ms.

**Délais intermittents : suivi.**
- **Phase 1B.10** : aucun échec par délai dépassé dans les contrôles
  complets de la phase (le contrôle du clone neuf ci-dessus, et le
  contrôle final), ni dans les essais ciblés. Ce n'est pas une preuve que
  le problème a disparu : la machine était calme pendant certains
  passages et chargée pendant d'autres, sans mesure systématique.
- **Causes démontrées** (phases précédentes) : une course dans un test
  (checkpoint lu avant `close()`, corrigée en 1B.9) ; des tests trop
  courts sous forte charge, mesurée (un jeu occupait 9 des 12 processeurs
  logiques, la suite core prenait 47 s au lieu de 6 s).
- **Cause supposée, non démontrée** : l'analyse antivirus des fichiers
  d'un clone neuf, qui ralentirait les premiers tests.
- **Non expliqué** : la rétention du journal à 2,6 s dans un passage
  sans charge connue (Phase 1B.6).
- Le budget de 30 s par test (Vitest) reste en place ; un vrai blocage
  échoue toujours.

## Phase 1B.9 : serveur, toile durable, tableau de bord

**Résultats** (`npm run check:logged`, machine calme) :
- Jest : 13 suites, **122 tests** ;
- Vitest : 40 fichiers, **488 tests** + 1 exhaustif optionnel :
  - core 358 ;
  - adapters-node 66 ;
  - simulator 43 ;
  - engine-service 21 ;
- lint : 0 erreur (65 avertissements hérités) ;
- lint du frontend : 17 erreurs et 3 avertissements hérités, aucun
  ajouté ;
- build : réussi.

**Clone neuf** (installation documentée de
[installation-windows.md](installation-windows.md) § 3) :
- installation ;
- 488 tests Vitest + 1 ignoré, 122 tests Jest ;
- construction ;
- démarrage réel du serveur compilé : « Engine ready: local simulation
  only », API `/api/v1/engine/status` en 200, interface servie.

Sans l'étape 2 (binaire précompilé de `canvas`), le serveur hérité ne
démarre pas (`Cannot find module '../build/Release/canvas.node'`). Les
deux tests du vrai serveur échouent alors, et le test affiche désormais
la sortie du serveur. Le binaire téléchargé a l'empreinte documentée.

| Où | Fichier | Couvre |
|---|---|---|
| engine-service | `world-store.test.ts` | Toile durable : restauration (pixels, énergie dépensée une fois), checkpoints, échec d'enregistrement sans effet, ligne déchirée coupée, dommage et identité refusés, restes d'un checkpoint interrompu ; **vrais processus tués à 9 étapes nommées** |
| engine-service | `service.test.ts` | Exécution complète et événements (numérotés, toile par lots), instantané et numéro de séquence, commandes concurrentes et incompatibles, arrêt pendant une écriture avec et sans abandon, révision pendant l'exécution, compactage unique, diagnostic, réglages et réinitialisation, ressources et améliorations (confirmation, refus en écriture, proposition périmée), seconde instance, redémarrage |
| engine-service | `crash.test.ts` | Vrai processus tué en pleine simulation (3 points), reprise sans double consommation |
| adapters-node | `adapters.test.ts` | Garde par canal nommé : nom canonique, refus dans un processus, deux processus et libération après arrêt brutal |
| simulator | `scheduler.test.ts` | Ordonnanceur avec une horloge qui avance à chaque lecture (régression) |
| serveur | `engine-api.test.ts` | Routes `/api/v1` (moteur factice) : commandes, codes, validation stricte, aucune fuite, 404 JSON ; protections : origine étrangère, Host étranger, origine d'extension, corps non JSON, taille ; canal WebSocket : hello, ordre, client lent, reconnexion |
| serveur | `server-engine.test.ts` | **Vrai serveur** : API, WebSocket, déconnexion sans effet, seconde instance refusée (code 2), arrêt contrôlé par IPC, redémarrage cohérent, arrêt brutal en pleine simulation et reprise |

**Défauts réels trouvés et corrigés** :
- **Ordonnanceur de la 1B.8** : avec une horloge réelle, il demandait
  l'état des ressources avant leur observation (`TIME_BEFORE_STATE`).
  C'était invisible avec l'horloge virtuelle. Test de régression ajouté.
- **Service**, trouvé par ses tests : l'abonnement à la fin de la boucle,
  posé avant le démarrage, se résolvait aussitôt.
- **Recette navigateur** : après une pause, « Reprendre » restait grisé
  jusqu'au statut suivant. Après un arrêt, la réponse HTTP portait un
  statut calculé pendant l'arrêt et masquait « Démarrer ». Corrigé, test
  vérifié par mutation.
- **Performance**, mesurée avant correction : `status()` recomptait les
  4 millions de pixels du modèle à chaque appel.
- **Keep-alive hérité** : il contactait Wplace pour les comptes
  enregistrés. Coupé par défaut.

**Erreurs de mise au point** :
- énergie régénérée et horloge repartie en arrière dans l'enfant de test ;
- nom de canal nommé mal échappé dans une sonde : le refus `EACCES` a
  d'abord été attribué à tort au bac à sable ;
- chargeur `tsx` cherché depuis un dossier temporaire ;
- `prefer-const` ;
- `any` dans des tests ;
- règles React (`set-state-in-effect`, `refs`), corrigées sans
  désactivation ;
- noms d'états et d'améliorations du core mal recopiés dans l'interface.

**Délais dépassés : suivi** (point toujours ouvert, voir 1B.8 plus
bas). Deux échecs avant le push de la 1B.8, sur le commit déjà validé,
journaux complets conservés hors du dépôt :
- **propriétés multi-agents** : plus de 30 s, contre 3,9 s au repos ;
- **réparation du journal par injection de fautes** : plus de 120 s,
  contre 26 à 30 s au repos.

Pendant ces échecs, un jeu occupait environ 9 des 12 processeurs
logiques. La suite core prenait 47 s au lieu de 6 s, et chaque worker
mettait 4,6 s à démarrer au lieu de 0,5 s. Le même test seul prenait
8,1 s. Machine redevenue calme, le même commit passait entièrement.

Même mécanisme que celui reproduit en 1B.8 : saturation de la machine
par un autre programme. Ce mécanisme reste une explication plausible des
dépassements historiques, **pas une preuve de leur cause**.

**Ajout** : `scripts/run-logged.mjs` enregistre maintenant :
- la durée ;
- le nombre de processeurs et la mémoire ;
- la charge de la machine, relevée toutes les 5 s (moyenne, maximum,
  nombre de relevés à 90 % ou plus).

Une saturation sera donc visible dans le journal même du contrôle. Aucune
relance silencieuse n'est faite.

**Performances** (`npm run bench:responsiveness`, toile 2048², énergie
abondante, latence nulle) :

| Mesure | Modèle 2000² | Modèle 256² |
|---|---|---|
| Premier lot | 510 à 650 ms | 306 ms |
| Pixels par seconde | 4 600 → 5 070 après correction | 53 000 |
| Durée d'un cycle | 217 → 197 ms | 18 ms |
| Retard de la boucle d'événements : p50 / p99 / max | 12 / 204 / 216 ms | 11 / 18 / 27 ms |
| `status()` | 12,5 ms → ≈ 0 ms | ≈ 0 ms |
| Pause (attend l'opération en cours) | 52 → 4 ms | — |
| Lecture de la zone du modèle (HTTP) | 42 ms, 20 Mio de JSON | 0,3 Mio |
| Événements | 7 par seconde, 64 Kio/s pour la toile | — |
| Checkpoint de la toile 2048² avec compactage | 148 ms | — |
| Mémoire maximale du processus | 230 Mio | 141 Mio |

**Long essai dans Edge** (relecture de la phase), avec les réglages **par
défaut** (énergie 300, régénération 200 ms), un modèle de 350², deux
onglets, 150 s :
- l'attente de ressources a lieu ;
- aucune réponse 429, aucune requête en échec, aucune erreur console ;
- aucune tâche longue (> 50 ms) dans le navigateur ; tas JavaScript de 6
  à 9 Mio ;
- environ 4 messages WebSocket par seconde ;
- la pause est vue dans l'autre onglet, 60 ms après le clic.

**Correction trouvée par cet essai** : 93 requêtes par minute et par
onglet. Les panneaux relançaient leur lecture à chaque alternance entre
« En cours » et « Attente ressources », soit à chaque lot. Elles sont
maintenant sur des minuteries fixes : **52 requêtes par minute**, cinq
onglets sous la limite de 300.

Navigateur sur un modèle de **2000²** :
- premier affichage de la toile en 620 à 645 ms ;
- 20 s de simulation (106 000 pixels) sans tâche longue, tas de 41 Mio ;
- pause en 200 ms.

**Mode développement** (`npm run dev`) : le tableau de bord à travers le
proxy de Vite fonctionne. Le WebSocket est connecté, l'API `/api/v1` et
les routes héritées répondent 200, sans erreur console.

**Tests ajoutés après la relecture** (`service-waits.test.ts` et
`crash.test.ts`) :
- attente de régénération sur horloge réelle jusqu'à la fin, sans boucle
  active ; pause et arrêt pendant une attente, puis redémarrage ;
- checkpoints automatiques de la toile (seuil réglable), y compris un
  vrai processus tué au milieu d'un checkpoint ;
- reprise documentée d'un monde endommagé par réinitialisation
  explicite ;
- sélection jamais remplacée par la consultation d'un autre modèle.

**Échec de la passe finale sur clone neuf** (journal complet conservé hors
du dépôt) : le test des checkpoints automatiques lisait la génération de
la toile avant `close()`. Or un checkpoint lancé par le dernier cycle
pouvait encore être en cours : il était attendu par `close()` et donnait
la génération suivante. C'est une course dans le test, pas dans le
produit. Le test lit maintenant la génération sur le disque après la
fermeture (5 passages sur 5 réussis), et la passe finale a été refaite.

Côté serveur, un canal WebSocket est refusé pour une origine d'extension,
et un client lent est resynchronisé même sans nouvel événement.

Le navigateur n'est jamais bloqué : les calculs ont lieu dans le serveur.
En 2000², une requête peut attendre jusqu'à environ 0,2 s pendant un
cycle. La piste d'optimisation était une progression incrémentale dans
l'ordonnanceur : elle est faite et mesurée en Phase 1B.10 (voir
[progression.md](progression.md), § 6). La vérification complète
périodique de la toile, qui détecte les modifications extérieures, est
conservée : chaque cycle relit la zone du modèle.

## Tests des paquets (Phase 1B.8 : Vitest, 37 fichiers, 463 tests + 1 exhaustif optionnel)

| Paquet | Fichier | Objet |
|---|---|---|
| core | `constants.test.ts` | Valeurs des constantes (un seul agent, sentinelles, versions) |
| core | `contracts.types.test.ts` | Garanties de types : lecture seule sans `writer`, ordonnanceur limité aux fournisseurs inscriptibles, identifiants et couleurs nominaux, manifeste et gestionnaire de modèles |
| core | `architecture.test.ts` | Aucun import externe ni Node/DOM ; couches sans cycle ; aucun algorithme dans les contrats |
| core | `package.test.ts` | Point d'entrée |
| core | `geometry.test.ts` | Projection (1×1, non carrée, négatifs, origine non nulle, Y inversé), limites et placement partiel, allers-retours, entrées invalides, conversion de repère |
| core | `color.test.ts` | RVB et hexadécimal, alpha, noir ≠ transparent, OKLab (références d'Ottosson, gris, aller-retour), distances (métrique, espace euclidien) |
| core | `palette.test.ts` | Plus proche couleur, règle d'égalité, doublons, chemin rapide = chemin générique, quantification déterministe, palettes par agent, couleurs absentes |
| core | `template-validation.test.ts` | En-tête PNG (types, profondeurs, CRC, tronqué), limites avant décodage (bombe PNG), identifiants et noms, pixels canoniques, quantification par défaut |
| core | `template-manifest.test.ts` | Manifeste : aller-retour stable, `extensions` conservées et validées (noms, profondeur, taille, clés interdites), graine et `colorOrder` validés, schéma plus récent refusé, 41 manifestes malformés refusés ; règles de révision |
| core | `template-manager.test.ts` | Création, PNG invalide ou corrompu, dimensions excessives, image entièrement transparente ou opaque, seuil alpha, déterminisme, révisions, réglages sans révision, restauration, concurrence, conflit, empreinte fausse, récupération, manifeste malformé ou étranger, projets, duplication, suppression ; listage isolé (manifeste illisible, schéma plus récent, erreur de lecture, sans fuite de contenu) ; réparation (diagnostic, application, manifeste absent, refus) ; avertissement de placement partiel |
| core | `template-storage.test.ts` | Suite de conformité sur le stockage mémoire (panne injectée à chaque appel, réparation comprise ; `replaceManifest`) |
| core | `strategy-directional.test.ts` | Ordres exacts des 4 stratégies directionnelles, 1 × 1, images transparentes, taille des lots, région éligible (y descendant ou ascendant), placement et Y inversé, entrées invalides |
| core | `strategy-center-random.test.ts` | PCG32 : vecteurs de référence et implémentation BigInt indépendante ; centre (côtés pairs et impairs, trous, tri exact sur images aléatoires, centre de l'image et non de la région) ; aléatoire (permutation, graine, ordre figé de la version 1, répartition) |
| core | `strategy-color-outline.test.ts` | Couleur par couleur (fréquences, égalités, `colorOrder`, couleurs absentes, comptage sur l'image entière) ; contours (carré plein, trou, autre couleur, formes fines, définition vérifiée sur images aléatoires) |
| core | `progress.test.ts` | Progression : modèle entièrement correct, incorrect (autre couleur, vide), partiel, pixels inconnus, valeurs invalides, aucun pixel éligible, 1 × 1, non carré, axe y montant, repère différent refusé, placement partiel, coordonnées proches de 2^53, provenance et fraîcheur, entrées invalides ; propriétés contre une implémentation naïve (150 cas) ; indépendance de la stratégie |
| core | `eta.test.ts` | ETA : 0 pour un modèle terminé (même sans agent), absence d'agent, couleur indisponible, énergie insuffisante, observation incomplète ou ancienne, paramètres invalides, dépassement ; énergie nulle, régénération, cadence, disponibilité, pauses, plusieurs agents ; borne contre une simulation milliseconde par milliseconde ; monotonie |
| core | `resources-model.test.ts` | Règles : jeu complet accepté, 22 règles invalides refusées, capacité et intervalle par niveau ; observations valides et 16 invalides ; état : invariants, sérialisation canonique, nature exigée, règles différentes refusées |
| core | `resources-energy.test.ts` | Régénération partielle et longue durée, composition (400 cas), attentes exactes, dépenses, améliorations simulées, monnaie et plafonds ; gestionnaire : observation seule acceptée (`@ts-expect-error`), états séparés, doublons, ordre, absorption, contradictions, report de phase, agents séparés ; propriétés (150 séquences) ; chemin rapide = rejeu |
| core | `eta-equivalence.test.ts` | ETA identique à la version 1B.4 figée sur 2 000 cas aléatoires |
| core | `upgrades.test.ts` | Améliorations possibles et impossibles, effets, ETA avant / après, couleur rendant l'estimation possible, bénéfice nul non recommandé, autres agents, instantané périmé, déterminisme, comparaison exacte, confirmation, application unique, propriétés |
| core | `strategy-properties.test.ts` | Propriétés des 8 stratégies sur images aléatoires : chaque pixel peignable exactement une fois, jamais un transparent, déterminisme, taille des lots, région = ordre filtré, placement et sens de l'axe y ; intégration avec le gestionnaire de modèles |
| core | `strategy-keys.test.ts` | Clés de classement (1B.6) : trier par clé redonne exactement l'ordre validé de chaque stratégie (régions, graines, `colorOrder`) ; table des rangs de l'aléatoire |
| core | `order-cache.test.ts` | Cache de l'ordre aléatoire : aller-retour, clé différente refusée, longueur, SHA-256, permutation invalide, en-tête illisible ; régénération et réécriture au mieux, problème signalé ; magasin en panne |
| core | `work-planner.test.ts` | `WorkPlanner` : modèle correct, partiellement incorrect, presque terminé ; pixels inconnus (deux politiques), couleurs indisponibles, points en cours, budget et attente, refus (instantané périmé ou futur, repère, ressources périmées ou incertaines, agent indisponible) ; nouvelle révision ; propriété « premiers k de l'ordre filtré » (160 cas, 8 stratégies) ; cache = sans cache |
| core | `attempts.test.ts` | `AttemptManager` : succès, échec, annulation, bail déjà réservé, doublons, énergie insuffisante, couleur ou agent indisponible, duplication concurrente, bail expiré, changement de révision, résultat inconnu, réponse perdue, écriture refusée puis replanifiée, réconciliation (lecture trop ancienne refusée), pixel redevenu incorrect, reprise après interruption, reprise idempotente, registre des dépenses perdu, observation rapportée sans double consommation, journal corrompu, fin déchirée, événements incohérents, injection de fautes à chaque écriture du journal, machine d'états complète ; propriétés : trois agents simulés sur une toile locale, actions entrelacées (baux concurrents, chevauchements, fautes, crashs, expirations) |
| core | `journal-codec.test.ts` | Format des lignes : aller-retour ASCII, somme valide sur un contenu invalide, version inconnue ; propriétés : coupure à chaque octet, octet altéré jamais lu comme un événement |
| adapters-node | `adapters.test.ts` | Même suite de conformité sur le stockage fichiers ; décodage pngjs (palette + tRNS, gris 1/16 bits, entrelacé…) ; disposition des fichiers ; fichiers modifiés sur disque ; réparation sur disque (octets corrompus conservés) ; chemins refusés ; arrêt brutal d'un processus réel ; numéros jamais réutilisés malgré arrêts, corruption et réparations interrompues (1B.6) ; réservations sur disque ; cache d'ordre sur disque ; journal et historique sur disque (fin déchirée mise de côté, dommage conservé, ajout échoué après une ligne partielle), processus réels tués pendant les ajouts au journal ; verrou du répertoire (un processus ; deux processus indépendants ; quatre lancés en même temps ; les deux mécanismes) ; dépendances du paquet |
| core | `journal-state.test.ts` | Phase 1B.7 : reconstruction depuis le journal complet (A) égale à la reconstruction depuis le checkpoint et les événements postérieurs (B), sur 25 scénarios et plus de 50 compactages avec crashs ; gestionnaires repris sur un journal compacté et sur un journal complet identiques ; tentatives ouvertes conservées par le compactage ; purge des résumés sans perte d'incertitude ; journal endommagé (lecture de la toile exigée, compactage refusé) ; checkpoint réparé |
| adapters-node | `journal.test.ts` | Générations et compactage sur disque, équivalence avec le rejeu complet, rétention, lecture du journal de la 1B.6, pointeur absent ou illisible, repli de checkpoint, séquence manquante ; injection de fautes avant et après chaque opération du compactage ; fin déchirée, ajout échoué ; rotation de l'historique ; processus réels arrêtés à 10 étapes nommées |
| adapters-node | `journal-tool.test.ts` | Diagnostic en lecture seule (empreinte du répertoire inchangée, aucun contenu ni chemin exposé) ; réparation (plan, identifiant, sauvegarde vérifiée, trace, préservation, fin déchirée, pointeur absent, checkpoint inutilisable, journal modifié après le plan) ; injection de fautes à chaque opération de la réparation ; ligne de commande |
| simulator | `package.test.ts` | Résolution de `@geoplacer/core` (valeurs et types) |
| simulator | `canvas.test.ts` | Fournisseur de toile simulé : contrats, lecture (limites, repère, `readRow`, copie datée), écriture (ordre des refus, énergie des règles du core, régénération), idempotence, pannes déterministes, acteurs externes |
| core | `damage-coverage.test.ts` | Phase 1B.8 : après un dommage, bail refusé avec une lecture d'un pixel ou de la moitié, accepté avec une lecture complète ; valeurs inconnues ou invalides ; plancher du WorkPlanner ; tentatives incertaines closes seulement une fois entièrement observées (un pixel, la moitié, tout ; plusieurs zones distinctes ; lectures progressives ; lecture trop ancienne) ; modification après réconciliation ; dommage persistant à travers compactage et reprise ; relecture prudente des données de la 1B.7 |
| core | `auto-compaction.test.ts` | Compactage automatique : seuils d'événements, d'octets et d'âge ; désactivation ; refus motivés (tentatives ouvertes, espace inconnu ou insuffisant) ; jamais sur un journal endommagé ; échec sans perte et journal en état inconnu ; défauts documentés ; concurrence : 80 opérations simultanées et compactages fréquents, sans chevauchement ni perte, même état que le journal complet |
| simulator | `scheduler.test.ts` | Ordonnanceur : exécution complète et statut, `step` déterministe, refus du multi-agent, attente d'énergie sans boucle active (attentes comptées), indisponibilité, palette individuelle, pause, arrêt avec et sans abandon, arrêt sans lecture possible, abonnés, toutes les pannes du simulateur, redémarrages, panne de journalisation, panne de compactage, nouvelle révision, compactage au long cours |
| simulator | `scenarios.test.ts` | Scénarios A (100 × 100, vrai TemplateManager), C (interruptions), D (modification externe), E (ressources incertaines) |
| simulator | `reconciliation.test.ts` | Les dix scénarios de réconciliation avec l'`AttemptManager`, le repère y vers le haut, le déterminisme |

Test exhaustif facultatif (aller-retour OKLab des 16,7 M couleurs, environ
10 s) : `$env:GEOPLACER_EXHAUSTIVE="1"; npm run test --workspace=packages/core`.

Benchmarks :
- `npm run bench:core` : résultats dans
  [geometrie-couleurs.md](geometrie-couleurs.md) § 4 ;
- `npm run bench:templates` : résultats dans [modeles.md](modeles.md) § 6 ;
- `npm run bench:strategies` : résultats dans [strategies.md](strategies.md) § 3 ;
- `npm run bench:color-by-color` : avant et après l'optimisation de la 1B.4,
  avec vérification de l'ordre ([strategies.md](strategies.md) § 3) ;
- `npm run bench:progress` : progression et ETA
  ([progression.md](progression.md) § 4) ;
- `npm run bench:resources` : ressources, ETA, planificateur
  ([ressources.md](ressources.md) § 6) ;
- `npm run bench:snapshot-read` : lecture par ligne contre lecture par
  pixel ([progression.md](progression.md) § 5) ;
- `npm run bench:order-cache` : cache d'ordre sur disque
  ([strategies.md](strategies.md) § 4) ;
- `npm run bench:reservations` : réservations de numéros
  ([modeles.md](modeles.md)) ;
- `npm run bench:scheduler` : ordonnanceur sur 2000 × 2000
  ([ordonnanceur.md](ordonnanceur.md) § 9) ;
- `npm run bench:planner-focus` : couleur par couleur et contours d'abord,
  médiane, p95, maximum, A/B dans un même processus
  ([planification.md](planification.md) § 8) ;
- `npm run journal:diagnose`, `npm run journal:repair` : outil local du
  journal ([journal.md](journal.md) § 6) ;
- `npm run bench:planner` : `WorkPlanner` en 1000², 2000², 4096²
  ([planification.md](planification.md) § 8) ;
- `npm run bench:journal` : coût du journal et de la reprise, avant et
  après compactage ([journal.md](journal.md) § 8).

Simulation de l'ETA sur d'autres graines :
`$env:GEOPLACER_ETA_SEED="5"; npx vitest run --root packages/core test/eta.test.ts`.

Mutation vérifiée en 1B.2 : publier le manifeste **avant** d'écrire les
blobs fait échouer la suite de conformité (scénario « nouvelle source »).

Mutations vérifiées en 1B.3 : calculer le centre sur la région au lieu de
l'image, ou compter les couleurs sur la région, fait échouer les tests de
propriétés (région = ordre filtré, placement).

Délais : trois calculs purs de 1 à 3 s ont un délai explicite de 30 s. Un
passage complet avait échoué une fois sur 2 fichiers, sans détail
conservé ; les passages suivants ont réussi. **La cause n'est pas
établie** : le dépassement du délai de 5 s sous charge reste une
hypothèse, et l'augmentation du délai n'en est pas une preuve.

**Journaux complets** (Phase 1B.4) : `npm run check:logged` et
`npm run test:packages:logged` enregistrent toute la sortie (avec la date,
le commit et la version de Node) dans `test-logs/<date>-<script>.log`,
réussite comme échec, en conservant le code de sortie
(`scripts/run-logged.mjs`). Le dossier est ignoré par Git. À utiliser pour
les contrôles complets, afin qu'un échec intermittent puisse être examiné.

Phase 1B.5 :
- mutation vérifiée : ne plus conserver la progression partielle de
  régénération fait échouer six tests ;
- tous les échecs rencontrés pendant la phase ont leur journal complet
  conservé, même quand la relance réussissait (erreurs de rédaction de
  tests, et trois défauts réels : deux bornes de l'ETA et le registre
  cubique).

Phase 1B.6, mutations vérifiées (chacune fait échouer au moins un test) :
- numéroter d'après le manifeste seul (sans les réservations) : suite de
  conformité et test en processus réels ;
- `nextBatch` qui ignore les points en cours (3 tests) ou qui inverse la
  comparaison du tas (propriété) ;
- parcours inversé des lignes qui saute une ligne (propriété) ;
- gestionnaire sans sérialisation (duplication concurrente) ;
- bail sans refus `OVERLAP`, ou planificateur sans exclusion des points en
  cours (test de propriétés multi-agents) ;
- journal fichier qui garde son descripteur après un ajout échoué ;
- reprise qui libère les baux malgré un journal endommagé (2 tests) ;
- incertitude non reconstruite à la reprise, lecture de réconciliation
  antérieure à l'envoi en réconciliation (2 tests), dépense enregistrée en
  plus de l'observation rapportée.

Phase 1B.8, mutations vérifiées (chacune fait échouer au moins un test) :
- bail sans contrôle de couverture (2 tests) ; réconciliation sans
  exigence d'observation complète (4 tests) ;
- compactage automatique lancé hors de la file sérialisée (5 tests) ;
- journal fichier sans sérialisation interne de `append` et `compact`
  (1 test : l'événement ajouté pendant un compactage était perdu) ;
- ordonnanceur qui renvoie une écriture incertaine (2 tests) ; arrêt sans
  réconciliation de la tentative démarrée (2 tests).

Phase 1B.8, échecs rencontrés (journaux complets conservés hors du
dépôt) :
- **Un défaut réel**, trouvé par les tests et corrigé : l'ordonnanceur
  attendait deux fois par lot (le temps d'un pixel, puis le reste) au lieu
  d'une. Ce n'était pas une boucle active, mais il y avait deux fois trop
  de cycles.
- **Un risque réel**, signalé par la revue puis démontré par un test : un
  `append` pendant un `compact` du journal fichier.
- **Erreurs de rédaction des tests**, corrigées :
  - un `Int32Array` convertissait NaN et 1,5 en valeurs valides ;
  - ressources non observées après une réconciliation ;
  - exemple « invalide » devenu valide (schéma 2) ;
  - horloge virtuelle partagée par des séries concurrentes ;
  - attente par tours d'événements sur une boucle en microtâches ;
  - écriture suspendue d'un processus « mort » relâchée par erreur ;
  - filtre d'étape qui ne testait que la fin du nom (réservations) ;
  - étapes de blob inatteignables sans nouvelle image ;
  - `prefer-const`.
- **Délais dépassés sur un clone neuf** (suivis depuis la 1B.6) :
  **mécanisme reproduit** en 1B.8 ; son lien avec l'échec d'origine est
  déduit, pas mesuré.
  - **Récidive** : sur le clone neuf de fin de phase, « failure at any
    call: restore » a dépassé le délai par défaut de 5 s (5,0 s, contre
    1,03 s dans le dépôt).
  - **Premières mesures** : juste après `npm ci`, les premiers tests sont
    2 à 3 fois plus lents, et une relance est normale. Exécuter les
    fichiers de test l'un après l'autre ne change ces tests que de 20 à
    25 %, moins que le bruit d'un passage à l'autre. L'hypothèse d'une
    concurrence entre fichiers de test est donc **écartée**.
  - **Reproduction dans le dépôt**, sans clone : trois passages de
    référence donnent 1,03 s. Pendant un `npm ci` lancé dans un autre
    dossier :
    - l'antivirus (`MsMpEng`) consomme environ 9 des 12 processeurs
      logiques et le processeur est saturé à 100 % ;
    - les tests ralentissent de 5 à 9 fois, de façon homogène à chaque
      itération, sans blocage isolé : placement 9,7 s, re-quantize 7,7 s,
      new source 6,5 s, soit trois échecs à 5 s ;
    - dès la fin de l'installation, le temps revient à 1,03 s.
  - **Mécanisme démontré** : une machine saturée (installation et analyse
    antivirus) ralentit tous les tests de façon homogène, sans blocage,
    jusqu'à dépasser 5 s. Ce n'est ni un défaut du produit ni un
    interblocage. La part de `npm` lui-même n'a pas été séparée de celle
    de l'antivirus, qui est le principal consommateur mesuré.
  - **Lien avec l'échec d'origine : déduit, pas mesuré.** Cet échec a eu
    lieu au premier passage après `npm ci`, la seule situation où des
    ralentissements ont été observés. Le diagnostic lancé juste après une
    installation montrait un ralentissement passager de 2 à 3 fois sur les
    premiers tests seulement. Mais dans l'expérience ci-dessus, les
    passages lancés juste après la fin de l'installation étaient déjà
    normaux, et la charge au moment de l'échec d'origine n'a pas été
    mesurée. Les clones neufs suivants n'ont plus reproduit de
    ralentissement : l'antivirus garde probablement en mémoire les
    fichiers déjà analysés, ce qui n'a pas été vérifié.
  - **Non expliqué** : la rétention du journal a pris 2,6 s dans un
    passage séquentiel sans installation en cours (0,6 à 0,8 s
    d'habitude).
  - **Remède : un budget de temps, et pourquoi c'est le bon levier.**
    Aucun défaut du produit n'est en cause et le ralentissement est
    homogène. Allonger un seul test ne protégerait pas les autres : le
    budget par défaut passe donc de 5 s à **30 s dans les trois paquets**
    (`testTimeout`). Les tests plus longs gardent leur budget propre, par
    exemple 60 s pour le test de la ligne de commande du journal, qui
    lance quatre processus et a pris 11,7 s sous charge. Un vrai blocage
    échoue toujours, au bout de 30 s. La durée de chaque itération lente
    reste journalisée, et ce suivi couvre maintenant les six boucles
    « failure at any call » en plus de la duplication.
  - **Vérifications** :
    - toute la suite des paquets passe pendant trois `npm ci` consécutifs
      (duplication 9,7 s, ligne de commande 4,6 s) ;
    - trois clones neufs, testés juste après leur installation, sont
      verts, mais **sans ralentissement observé** : ils ne prouvent pas le
      correctif.
  - **Limite** : la marge est d'environ 3 fois le pire temps mesuré. Une
    charge plus lourde pourrait encore la dépasser ; les durées
    journalisées le montreraient.

Phase 1B.7, mutations vérifiées (chacune fait échouer au moins un test) :
- reprise depuis un checkpoint sans `lastSpendAt` (3 tests) ; `lastSpendAt`
  non mis à jour à la clôture (1 test) ;
- carte des contours fausse sur la première colonne (propriété des clés) ;
- interface d'origine contre le contrat de routes (4 appels inexistants
  détectés).

Phase 1B.7, échecs rencontrés (journaux complets conservés hors du
dépôt) :
- **Deux défauts réels**, trouvés par les tests et corrigés :
  - lors du tout premier compactage, un arrêt après la création du
    checkpoint laissait des fichiers de génération sans pointeur, et la
    reprise refusait de démarrer. Correction : un pointeur est écrit avant
    tout fichier de génération (trouvé par les processus arrêtés aux
    étapes nommées) ;
  - une panne d'entrée-sortie pendant la réparation faisait reconstruire
    l'état depuis les seuls événements, ce qui perdait les tentatives
    ouvertes du checkpoint. Correction : le repli est limité au cas annoncé
    par le plan (trouvé par l'injection de fautes dans la réparation).
- **Une faiblesse corrigée** : un `catch` trop large dans l'empreinte des
  fichiers avalait une panne injectée et produisait une trace incomplète.
- **Erreurs de rédaction des tests**, corrigées :
  - fin déchirée vérifiée sans ajout préalable ;
  - attente fausse sur le nombre de segments lus par l'historique ;
  - horloge d'un deuxième harnais antérieure à la dernière dépense ;
  - lecture du fichier de verrou (EBUSY) ;
  - attente de 6 tentatives au lieu de 7 (la ligne endommagée était une
    clôture) ;
  - message attendu de `PLAN_CHANGED`.
- **Script de recette** : la première exécution est restée bloquée,
  faute d'arrêter le serveur après une erreur, à cause d'un sélecteur
  ambigu. Le script nettoie maintenant tout en sortie.
- **Avertissement** « FileHandle fermé par le ramasse-miettes » : des tests
  ne fermaient pas leurs journaux. Corrigé.
- **Délai de la duplication interrompue** (cause toujours non établie) : le
  test enregistre maintenant la durée de chaque itération lente, pour
  qu'une récidive laisse des données. Pas de récidive pendant la 1B.7.

**Lint du frontend** (`cd frontend; npx eslint .`) : 17 erreurs et
3 avertissements **hérités** (règles `react-refresh` et `no-explicit-any`).
Il est hors de `npm run check`. Les corrections de la recette n'en ajoutent
aucun : le compte est vérifié avant et après.

**Tests de processus** : depuis la Phase 1B.8, **tous** les tests d'arrêt
brutal arrêtent l'enfant à une étape nommée, sans minuteur :
- pour le journal : les opérations de fichier du compactage et des ajouts ;
- pour les modèles : `NodeTemplateStorage.onStep`, avec le fichier
  temporaire créé, écrit et renommé, et les réservations, blobs PNG
  compris.

Les tests du verrou entre processus gardent une durée de détention du
verrou : c'est l'objet même du test, pas une attente de synchronisation.

Phase 1B.6, échecs rencontrés (journaux complets conservés hors du dépôt) :
- **test des processus tués pendant les ajouts au journal**, deux échecs :
  - sur un clone neuf : `history.log` absent ;
  - en local, une fois sur trois : `attempts.log` absent.

  **Cause établie** : l'enfant pouvait être tué avant sa première clôture,
  ou même avant son premier ajout, car le démarrage est plus lent sur un
  clone neuf. Le test supposait que ces fichiers existent toujours. Ce
  n'est pas un défaut du produit. **Correction** : l'enfant ne se déclare
  prêt qu'après 12 itérations, et un historique absent compte comme vide.
  Cinq passages consécutifs ont ensuite réussi.
- **Test de propriétés multi-agents** : dépassement du délai de 5 s dans
  la suite complète (6,7 s, contre environ 3,3 s seul). La charge est
  déterministe (graine fixe) : 30 toiles de 300 actions. Ce n'est pas un
  blocage. Délai explicite de 30 s, comme les autres calculs lourds.
- **Conformité du stockage fichiers, duplication interrompue** : délai de
  5 s atteint une fois sur un clone neuf (5,0 s). Le test prend 1,9 à
  2,2 s dans le dépôt et avait réussi sur deux clones neufs précédents.
  C'est une boucle d'injection de fautes sur disque réel, avec un fsync
  par opération. **Cause non établie** : des entrées-sorties plus lentes
  dans le dossier temporaire du clone restent une hypothèse. Délai
  explicite de 30 s pour les trois tests d'opérations interrompues ; ce
  délai ne prouve rien sur la cause.
  Mécanisme reproduit en 1B.8 : saturation de la machine par une
  installation et son analyse antivirus (voir plus haut).
- Deux échecs de mise au point n'ont été conservés que sous forme
  d'extraits, pas de journal complet :
  - premier passage de `attempts.test.ts` : erreurs de rédaction du test ;
  - `EPERM` de `ftruncate` sous Windows sur un descripteur en ajout,
    corrigé par un descripteur séparé.

Mutation vérifiée en 1B.4 : compter un pixel `UNKNOWN` comme correct fait
échouer deux tests de progression. Écraser la sauvegarde lors d'une
réparation fait échouer quatre tests. Deux assertions de la 1B.3 étaient
vides (elles lisaient une entrée détachée du stockage mémoire) : elles ont
été corrigées.

Les garanties de types sont vérifiées par `npm run typecheck:packages` : un
`@ts-expect-error` devenu inutile fait échouer la vérification. Deux
mutations volontaires (un `writer` ajouté au fournisseur en lecture seule ;
un import vers une couche supérieure) ont bien été détectées.

## Tests backend (Phase 1B.0 : 9 suites, 94 tests)

| Suite | Objet |
|---|---|
| `validation.test.ts` | Schémas Zod existants (dont le contrat `expirationDate`) |
| `validation-dos.test.ts` | Charges malveillantes : matrices, listes, cookies (GHSA-mrhx-c7xc-m3w5) |
| `network.test.ts` | Résolution de l'adresse d'écoute |
| `local-access.test.ts` | Host, Origin, Sec-Fetch-Site, WebSocket |
| `redact.test.ts` | Masquage des secrets, `toPublicUser` |
| `log-redaction.test.ts` | Masquage dans un vrai pipeline Winston |
| `settings-update.test.ts` | Validation, bornes alignées sur chaque contrôle de la page Paramètres, mise à jour sur place, nettoyage au chargement |
| `json-store.test.ts` | Écriture atomique, quarantaine, restauration, arrêts brutaux réels |
| `server-config.test.ts` | Configuration absente, vide, partielle ou invalide ; cohérence de `.env.example` |

Les tests n'émettent aucune requête vers un service public. Les tests de
persistance travaillent dans des dossiers temporaires du système.

Non couvert : le moteur de dessin hérité (`template-manager.ts`,
`wplacer-client.ts`), qui sera remplacé.

## Lint

- **Backend** : 0 erreur. Les avertissements restants sont des
  `no-explicit-any` hérités, à traiter au fil des modules réécrits.
- **Frontend** : 17 erreurs héritées, classées par priorité :

| Priorité | Règle | Nb | Fichiers | Nature |
|---|---|---|---|---|
| Moyenne | `react-hooks/purity` | 1 | `ManageUsers.tsx:116` | `Date.now()` pendant le rendu : le badge de suspension ne se met pas à jour seul |
| Moyenne | `react-hooks/set-state-in-effect` | 3 | `useServerStatus.ts:48`, `useSettings.ts:79`, `useUsers.ts:68` | Rendus en cascade (performance) |
| Basse | `react-hooks/immutability` | 5 | `AddTemplate.tsx:36`, `ManageTemplates.tsx:33`, `ManageUsers.tsx:22`, `Settings.tsx:26`, `useLogs.ts:55` | Fonction appelée dans un `useEffect` avant sa déclaration : faux positif à l'exécution |
| Basse | `react-refresh/only-export-components` | 3 | `ui/Button.tsx`, `ui/Toast.tsx`, `router.tsx` | Rechargement à chaud en développement uniquement |
| Basse | `no-explicit-any`, `no-unused-vars`, `no-empty-object-type` | 5 | `ui/collapsible.tsx`, `ui/Input.tsx`, `useSettings.ts`, `vite.config.ts` | Style |

Le hook `useLogs` n'est importé par aucun composant (code mort probable).

## Évaluation de Vitest (Phase 1A)

Essai réalisé dans un clone jetable, sans modifier le projet :

- Vitest 5.1.0 exige `@types/node` en ^22 ou ≥ 24. Le projet est en ^20, ce
  qui est par ailleurs incohérent avec l'exécution sous Node 22.
- Avec `globals: true`, **83 tests sur 85** passent sans modification. Les 2
  échecs viennent de `jest.fn()` (4 appels à remplacer par `vi.fn()`).
- Durée : 3,7 s avec Vitest, contre 9,5 s avec Jest.

Décision (14/11/2026), appliquée en Phase 1B.0 : Vitest 5.1.0 pour
`packages/core` et `packages/simulator` ; Jest conservé pour le code hérité ;
`@types/node` aligné sur ^22.
