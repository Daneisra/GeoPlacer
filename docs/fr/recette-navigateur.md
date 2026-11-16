# Recette navigateur (Windows)

## Ctrl+C au clavier : validation utilisateur requise (Phase 1C.0)

L'arrêt a été vérifié en envoyant l'événement Ctrl+C de Windows à la
console (voir plus bas). Une **frappe physique** de Ctrl+C n'a jamais été
faite par l'automate : ce test court (5 minutes) reste à faire par vous.
Ne pas le considérer comme fait tant qu'il ne l'a pas été.

1. **Lancer**, dans PowerShell, depuis le dossier de GeoPlacer installé :
   ```powershell
   node --env-file-if-exists=.env dist/server.js --demo
   ```
   (`node` directement : le code de sortie est alors celui du serveur ; avec
   `start.bat`, Windows ajoute sa propre question, voir l'étape 5.)
   Attendre la ligne `Server listening on http://127.0.0.1:3000` (le port
   peut différer : utiliser celui affiché).
2. **Ouvrir** cette adresse, cliquer « Préparer la démonstration »
   (si la carte le propose), puis « Démarrer ». Attendre que la progression
   dépasse 10 %. Noter la valeur.
3. **Appuyer une fois sur Ctrl+C** dans la fenêtre PowerShell, pendant que
   la progression avance.
4. **Messages attendus**, dans cet ordre :
   - `Received SIGINT. Starting graceful shutdown...`
   - `Engine stopped and data directory released`
   - `Graceful shutdown completed`

   puis l'invite PowerShell revient. **Code de sortie attendu : 0** :
   ```powershell
   $LASTEXITCODE        # 0
   ```
5. Variante `start.bat --demo` (fenêtre lancée par double-clic ou depuis
   PowerShell) : après les mêmes messages, Windows demande
   `Terminer le programme de commandes (O/N) ?`. Le serveur est déjà
   arrêté : **répondre O**.
6. **Port libéré** (remplacer 3000 par le port affiché) :
   ```powershell
   Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
   ```
   ne doit rien afficher.
7. **Reprise** : relancer la commande de l'étape 1. La console affiche
   `[engine] simulated world restored (generation …, N change(s) replayed)`
   avec N supérieur à 0. Dans la page : même modèle, progression au moins
   égale à la valeur notée (et non 0). « Démarrer » : la démonstration va
   jusqu'à 100 %.
8. **Compte rendu** : copier les lignes de la console des étapes 4 et 7,
   le code de sortie de l'étape 4 et le résultat de l'étape 6.

Un **second** Ctrl+C pendant l'arrêt force la sortie (code 1) ; la reprise
de l'étape 7 doit fonctionner aussi dans ce cas (facultatif).

## Recette de la Phase 1B.10

### Parcours dans le navigateur

`scripts/recette-simulation.mjs` (réécrit) joue le parcours de la 1B.10
contre le serveur compilé, lancé dans un dossier temporaire : les données
du dépôt ne sont jamais touchées, rien ne sort de la machine.
`playwright-core` est installé **hors du dépôt**.

```powershell
$env:GEOPLACER_PLAYWRIGHT_CORE = "<dossier>\node_modules\playwright-core"
npm run build
node scripts/recette-simulation.mjs recette-edge              # Edge (ou Chrome)
$env:GEOPLACER_BROWSER_ENGINE = "firefox"                     # Firefox de Playwright
node scripts/recette-simulation.mjs recette-firefox --quick   # --quick : démonstration arrêtée au lieu d'aller au bout
```

Contrôles : ouverture (bandeau, temps réel) ; démonstration proposée sur
un projet vide ; fonctions héritées absentes du menu ; modèle d'exemple
chargé ; ressources de démonstration ; pixels placés sur la toile
affichée ; pause et reprise ; fin de la démonstration ; raisons d'état et
refus en français ; heures au format français ; accès direct à `/users`
désactivé ; sauvegarde depuis l'interface ; modèle de 2000 × 2000 affiché
entier avec l'échelle, zoom et déplacement annoncés, « Ajuster » ; arrêt
contrôlé ; restauration par `npm run restore` ; après redémarrage, le
modèle et la progression sauvegardés sont retrouvés sans rien repeindre ;
console sans erreur inattendue ; **aucune requête de la page (documents,
scripts, polices, API, WebSocket) vers un autre hôte que 127.0.0.1 ou
localhost**, sur tout le parcours.

**Résultats du 16/11/2026, sur le clone neuf** (installé par
`npm run setup:windows`) :

| Navigateur | Parcours | Résultat |
|---|---|---|
| Edge (Windows 10) | complet | **0 échec** ; démonstration terminée 143 s après la reprise |
| Firefox 132 de Playwright (isolé, navigateur en anglais) | complet | **0 échec** ; 142 s après la reprise. Défaut vu dans le journal : heures affichées « 12:56:19 AM » |
| Firefox (correctif des heures) | rapide | contre-épreuve sur l'ancienne interface : **1 échec attendu** (« 1:03:35 AM ») ; après correctif : **0 échec** |
| Edge (après correctif) | rapide | **0 échec** |
| Edge (contrôle des hôtes ajouté, second clone neuf) | rapide | **0 échec** ; contre-épreuve avec une requête injectée vers `example.invalid` : **2 échecs attendus** (hôte étranger, erreur console) |

La recette de la Phase 1B.7 (`scripts/recette-navigateur.mjs`), adaptée
aux pages désactivées (accès direct à `/users`, `/templates`,
`/templates/add` : page « désactivé » ; démarrage hérité refusé par le
serveur, 410), donne **29 contrôles, 0 KO** sur le clone neuf.

**Firefox** : seule la version fournie par Playwright (132), installée à
part, a été testée. Une version officielle de Firefox n'est pas installée
sur la machine de développement : la procédure manuelle (§ « Recette
manuelle ») reste valable pour elle.

### Arrêt par Ctrl+C, reprise, sauvegarde et restauration (Windows)

`scripts/recette-arret-windows.mjs`, sur une copie **installée** (il
refuse de tourner si `data\demo` existe déjà) :

```powershell
node scripts/recette-arret-windows.mjs <dossier de GeoPlacer> <dossier du compte rendu>
```

1. `start.bat --demo` dans sa **propre fenêtre de console** ;
2. démonstration préparée et démarrée par l'API ;
3. un **événement CTRL_C_EVENT** est envoyé à cette console
   (`GenerateConsoleCtrlEvent`) : c'est l'événement que Windows produit
   pour la touche Ctrl+C, **mais pas une frappe au clavier** ;
4. redémarrage : la toile simulée et le modèle doivent être retrouvés ;
5. démonstration menée au bout, sauvegarde par l'API, nouvel arrêt ;
6. toile simulée supprimée, sauvegarde vérifiée puis restaurée en ligne
   de commande ;
7. redémarrage : l'état restauré est complet (un démarrage se termine
   aussitôt, rien à repeindre).

**Résultat sur le clone neuf** (deux passages, dont un avec le script
versionné) :
- à chaque Ctrl+C : « Received SIGINT. Starting graceful shutdown… »,
  « Engine stopped and data directory released », puis « Graceful shutdown
  completed » en 14 à 16 ms ; port libéré ;
- Windows affiche ensuite « Terminer le programme de commandes (O/N) ? »
  dans la fenêtre de `start.bat`, le serveur étant déjà arrêté ;
- au redémarrage : « simulated world restored (generation 1, 37 change(s)
  replayed) », même modèle ; démonstration terminée 127 s après la reprise
  (142 à 143 s dans les recettes navigateur, interrompues plus tôt) ;
- sauvegarde de 10 fichiers ; vérification et restauration réussies ;
  données précédentes conservées dans `data\demo.avant-restauration-<date>` ;
- après restauration : état « Terminé », « the canvas matches the
  template ».

**Reste manuel** : une vraie frappe de Ctrl+C dans un terminal, et la
réponse à « Terminer le programme de commandes ». Le chemin de code est le
même (signal SIGINT reçu par le serveur), mais une frappe réelle n'a pas
été faite par l'automate.

## Recette de la simulation (Phase 1B.9)

`scripts/recette-simulation.mjs` joue tout le parcours utilisateur dans un
vrai Edge, sans fenêtre, contre le serveur compilé lancé dans un dossier
temporaire. Il prend des captures d'écran et écrit un journal.

```powershell
$env:GEOPLACER_PLAYWRIGHT_CORE = (Resolve-Path ..\outils-recette\node_modules\playwright-core)
npm run build
node scripts/recette-simulation.mjs recette-simulation   # port 3917 libre
```

**Résultat du 15/11/2026** (Edge, trois passes, la dernière sur le
commit final) : parcours complet réussi.

| Étape | Résultat |
|---|---|
| Ouverture : bandeau « SIMULATION LOCALE », « Temps réel connecté », « Démarrer » grisé sans modèle | OK |
| Réglages par le panneau : réinitialisation du monde demandée et confirmée | OK |
| Import d'un PNG 48 × 48 (nom, position, stratégie), sélection automatique | OK |
| Ressources : énergie, capacité, régénération (« 200 ms »), monnaie, couleurs, améliorations | OK après correction (noms d'amélioration, durées sous la seconde) |
| Démarrer : « En cours », « Démarrer » grisé, progression, toile mise à jour par lots | OK |
| Pause : « Reprendre » actif en 8 à 18 ms | OK après correction (statut émis aussitôt après un changement d'état) |
| Reprendre, Arrêter : « Arrêté », aucune tentative ouverte, « Démarrer » de nouveau actif | OK après correction (réponse d'arrêt cohérente) |
| Démarrer jusqu'à « Terminé » : 100 % | OK |
| Acteur extérieur simulé : pixels effacés, détectés, repeints | OK |
| Amélioration : confirmation, monnaie 5000 → 4900 | OK |
| Diagnostic du journal (« healthy »), compactage | OK |
| Serveur tué puis relancé : « Déconnecté — reconnexion… », reconnexion **sans recharger la page**, même modèle et même toile, « Terminé » à 100 % | OK |
| Notifications : succès, informations, refus | OK (vérifiées sur les captures) |
| Console | Deux lignes attendues : le 409 `WORLD_RESET_REQUIRED` avant la confirmation, et la connexion WebSocket refusée pendant le redémarrage |

La recette de la Phase 1B.7 (§ suivant) a été rejouée, car le tableau de
bord a changé : **28 contrôles, 0 KO**. Deux contrôles ont été adaptés :
- le compteur de connexions WebSocket inclut maintenant le canal du
  moteur : on vérifie qu'il augmente, au lieu d'attendre « 2 total » ;
- la reconnexion refusée du canal du moteur pendant le redémarrage
  volontaire est attendue.

**Restent manuels** (en Phase 1B.9 ; voir la Phase 1B.10 ci-dessus pour
l'événement Ctrl+C envoyé à une vraie console et pour le Firefox de
Playwright) :
- un vrai **Ctrl+C** sous Windows (voir
  [guide-utilisateur.md](guide-utilisateur.md) § 4). L'arrêt contrôlé
  est testé automatiquement par IPC, car Windows ne transmet pas SIGINT à
  un processus enfant ;
- **Firefox**, qui n'est pas installé sur la machine de développement.

Vérifications manuelles proposées sous Firefox :
1. le parcours du guide utilisateur ;
2. la toile mise à jour en direct ;
3. la reconnexion après un redémarrage du serveur ;
4. les notifications.

## Recette automatisée (Phase 1B.7)

`scripts/recette-navigateur.mjs` exécute cette procédure dans un **vrai
navigateur**, Microsoft Edge ou Chrome installé sur la machine, sans
fenêtre et en profil privé.

- **Pilotage** : `playwright-core` sert à piloter le navigateur. Il n'est
  **pas** une dépendance du projet : on l'installe hors du dépôt, et il ne
  télécharge aucun navigateur.
- **Serveur** : le serveur compilé tourne dans un dossier temporaire, ce
  qui laisse intact le `data\` du dépôt.
- **Synchronisation** : le script attend que le serveur annonce son port
  (« listening ») avant de commencer.
- **Contrôles** : aucun compte ni modèle n'est créé ou démarré, et aucune
  requête ne quitte la machine.

```powershell
npm install playwright-core@1.49.1 --prefix ..\outils-recette --ignore-scripts
$env:GEOPLACER_PLAYWRIGHT_CORE = (Resolve-Path ..\outils-recette\node_modules\playwright-core)
npm run build
node scripts/recette-navigateur.mjs recette.json   # le port 3000 doit être libre
```

**Résultat du 15/11/2026** : Edge 157, commit de la correction, deux
passes, **28 contrôles, 0 KO**.

| Contrôle | Résultat |
|---|---|
| Démarrage du serveur compilé, affichage du tableau de bord, `GET /settings` à 200 | OK |
| Navigation par le menu : Dashboard, Users, Templates, Templates → Add, Logs, Settings | OK |
| Paramètres : enregistrement (`PUT` 200 et fichier écrit), valeur hors bornes refusée (`PUT` 400, fichier inchangé), notifications « Settings Saved » et « Save Failed » | OK après correction |
| Persistance après arrêt et redémarrage du serveur | OK |
| Logs et WebSocket : connexion `ws://127.0.0.1:3000`, messages d'abonnement, second onglet signalé en direct (« 2 total »), `data\logs.log` sans cookie ni jeton | OK |
| F13 : F5 sur `/logs`, `/users`, `/templates`, `/settings` | OK après correction |
| F12 : « Start All » | OK après correction |
| Autre origine qui lit `/users` | Bloquée (« Failed to fetch ») |
| Console | Seulement les 2 lignes attendues du refus 400 volontaire |

**Anomalies constatées puis corrigées**, avec des tests de non-régression
(Jest, `src/__tests__/ui-navigation.test.ts`) :

1. **F13** : un F5 sur une page dont l'adresse est aussi une route de l'API
   affichait du JSON. Les navigations de document reçoivent maintenant
   l'interface, et les appels d'API gardent l'API. La distinction se fait
   par `Sec-Fetch-Dest: document`, ou à défaut par `Accept` commençant par
   `text/html`.
2. **F12** : « Start All », « Stop All » et Start/Stop par modèle
   appelaient des routes inexistantes (404).
   - Le **démarrage** est désactivé et expliqué dans l'interface, car il
     lancerait le moteur hérité contre un service réel.
   - L'**arrêt** utilise la vraie route `PUT /template/:id`.
   - Un test vérifie que chaque appel HTTP de l'interface correspond à une
     route du serveur.
3. **Notifications jamais affichées** (défaut hérité, découvert par la
   recette) : chaque composant tenait sa propre liste, que `App` n'affichait
   pas. Elles passent maintenant par un magasin partagé, et les styles ont
   été ajoutés.

**Aspect des notifications** : vérifié en Phase 1B.8 par captures d'écran
dans Edge. Les notifications apparaissent en bas à droite, sans couvrir
la barre latérale ; l'étiquette est verte (« OK ») ou rouge (« ERR ») ;
le titre, le message et le bouton de fermeture sont lisibles sur le thème
sombre ; plusieurs notifications s'empilent.

**Restent manuels** :
- la section 5.1 (vrai Ctrl+C et message d'arrêt propre), car Windows ne
  transmet pas de signal à un processus enfant : le script l'arrête
  brutalement ;
- un essai sous **Firefox**, qui n'est pas installé sur la machine de
  développement.

## Recette manuelle

Procédure manuelle d'environ 15 minutes pour vérifier l'interface dans un
vrai navigateur.

> **Règles** :
> - n'utiliser aucun compte Wplace ni GeoPixels ;
> - ne pas charger l'extension `LOAD_UNPACKED` ;
> - ne pas ajouter de compte ;
> - ne pas créer ni démarrer de modèle.

## Limites connues, à ne pas signaler comme régressions

- **F13** (corrigé en Phase 1B.7) : un **F5** sur `/logs`, `/users`,
  `/templates` ou `/settings` affiche maintenant l'interface. Avant cette
  correction, il affichait du JSON.
- **F12** (corrigé en Phase 1B.7) : le démarrage des modèles est
  volontairement désactivé, et seul l'arrêt reste possible.
- **Flux de logs** : la page Logs n'affiche pas l'historique, seulement les
  lignes arrivées depuis l'ouverture de la page. Son port WebSocket est fixé
  à 3000.
- **Navigation intersite** : ouvrir l'interface en cliquant sur un lien
  depuis une autre page web (messagerie, document en ligne…) donne un 403
  `cross-site`. C'est la protection anti-CSRF. **Taper ou coller
  l'adresse** dans la barre du navigateur.

## 0. Préparation

PowerShell, dans le dossier du projet :

```powershell
git status                      # attendu : rien à valider
git log -1 --format=%h          # noter le commit testé
# Si un dossier data\ existe, le mettre de côté (hors du dépôt) :
if (Test-Path data) { Copy-Item -Recurse data "..\GeoPlacer-recette-sauvegarde-data" }
# Configuration locale (facultative ; l'interface compilée est servie sans .env) :
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npx tsc
cd frontend; npm run build; cd ..
```

Navigateur : utiliser une **fenêtre privée** (sans extensions) de Chrome,
Edge ou Firefox, puis ouvrir les outils de développement (**F12**) avant de
charger la page.

## 1. Démarrer le serveur

Lancer Node directement, sans `npm start` : ainsi, le Ctrl+C de l'étape 5
atteint bien le serveur.

```powershell
node --env-file-if-exists=.env dist/server.js
```

| Attendu | Résultat |
|---|---|
| La console affiche `Server listening on http://127.0.0.1:3000` | |
| **Aucune** fenêtre du pare-feu Windows (sinon : refuser et vérifier `HOST`, voir § Restauration) | |

Si un autre port est affiché, le port 3000 était occupé : voir
§ Restauration.

## 2. Ouvrir l'interface

Ouvrir `http://127.0.0.1:3000/`.

| Attendu | Résultat |
|---|---|
| Le tableau de bord s'affiche | |
| Onglet **Réseau** : `GET /settings` revient toutes les 5 s avec le statut 200 (indicateur de connexion) | |

## 3. Parcourir les pages (par le menu latéral)

| Page | Attendu | Interdit | Résultat |
|---|---|---|---|
| Dashboard | S'affiche | — | |
| Users | Liste vide ; `GET /users` renvoie `{}` | Ajouter un compte | |
| Templates | Liste vide ; « Start All » désactivé avec une explication | Démarrer un modèle (désactivé : moteur hérité non utilisé) | |
| Templates → Add | Le formulaire s'affiche | Créer un modèle | |
| Logs | S'affiche avec un indicateur vert « Connected » | — | |
| Settings | Le formulaire s'affiche avec les valeurs actuelles | — | |

## 4. Modifier et sauvegarder un paramètre

Dans **Settings** :

1. Régler **Drawing Direction** sur **Center Out** et **Account Cooldown**
   sur **25**, puis enregistrer.

   | Attendu | Résultat |
   |---|---|
   | Notification « Settings Saved » | |
   | Réseau : `PUT /settings` → **200**, réponse `{"ok":true,"changed":[…]}` | |
   | `data\settings.json` contient `"accountCooldown": 25000` et `"drawingDirection": "center_out"` | |

2. **Contrôle négatif** : régler **Account Cooldown** sur **5000**
   (au-delà du maximum d'une heure), puis enregistrer.

   | Attendu | Résultat |
   |---|---|
   | Notification d'échec « Save Failed » | |
   | Réseau : `PUT /settings` → **400** avec la liste des erreurs | |
   | `data\settings.json` inchangé (toujours 25000) | |

3. Remettre **Account Cooldown** sur **25** dans le formulaire.

## 5. Arrêt (vrai Ctrl+C) et persistance

1. Dans le terminal du serveur, **Ctrl+C**. Ce chemin n'a jamais été testé
   avec un vrai Ctrl+C : **noter ce qui s'affiche**.

   | Attendu | Résultat |
   |---|---|
   | `Received SIGINT. Starting graceful shutdown...`, puis `Graceful shutdown completed` (sinon, noter le message exact) | |

2. Relancer `node --env-file-if-exists=.env dist/server.js`, ouvrir
   `http://127.0.0.1:3000/`, puis aller dans **Settings** par le menu.

   | Attendu | Résultat |
   |---|---|
   | Center Out et 25 sont conservés | |

## 6. Journaux et WebSocket

1. Aller dans **Logs** par le menu.
2. Onglet **Réseau**, filtre **WS** (ou « Socket »).

| Attendu | Résultat |
|---|---|
| Connexion `ws://127.0.0.1:3000` avec le statut **101** | |
| Onglet **Messages** : une ligne contenant `WebSocket client subscribed to logs`, puis `{"type":"system","message":"Connected to log stream"}` | |
| Ouvrir `http://127.0.0.1:3000/` dans **un second onglet** et y aller dans Logs : le premier onglet reçoit en direct `WebSocket client connected (2 total)` | |
| `data\logs.log` existe et ne contient ni cookie ni jeton | |

## 7. Console JavaScript

Onglet **Console**, sur chaque page visitée :

| Attendu | Résultat |
|---|---|
| Aucune erreur rouge. Noter tout avertissement ou toute erreur (texte complet) | |

## 8. Contrôle intersite (facultatif)

1. Ouvrir un onglet sur `https://example.com`.
2. Dans sa console, lancer :

   ```js
   fetch('http://127.0.0.1:3000/users').then(r => r.status).catch(e => 'bloqué: ' + e.message)
   ```

Si le navigateur demande d'autoriser example.com à accéder au réseau local,
**refuser** : le blocage par le navigateur fait partie des résultats
attendus.

| Attendu | Résultat |
|---|---|
| Échec : erreur réseau ou CORS (le navigateur ou le serveur bloque), ou statut 403. Les comptes ne doivent jamais être lisibles. | |

## 9. Fin de recette

**Ctrl+C** pour arrêter le serveur. Le dossier `data\` ne contient que des
paramètres de test : il peut être supprimé.

## Restauration en cas de problème

| Situation | Action |
|---|---|
| Fenêtre du pare-feu Windows | Refuser l'accès. Vérifier que `.env` contient `HOST="127.0.0.1"`. |
| Page `{"error":"Forbidden","reason":"cross-site"}` | L'adresse a été ouverte depuis un lien d'une autre page : la taper ou la coller directement. |
| Page `…"reason":"forbidden-host"` | L'adresse utilisée n'est ni `127.0.0.1` ni `localhost` : utiliser `http://127.0.0.1:3000/`. |
| Port 3000 occupé | `$env:PORT=3100; node --env-file-if-exists=.env dist/server.js` (sans modifier `.env`), puis ouvrir `http://127.0.0.1:3100/`. Le flux de logs en direct sera indisponible (port fixé à 3000). |
| Le serveur ne démarre pas (`canvas.node` manquant, module absent) | `$env:GEOPLACER_SETUP_ONLY="1"; .\start.bat; Remove-Item Env:GEOPLACER_SETUP_ONLY`, puis `npx tsc`. |
| Ctrl+C ne rend pas la main | Fermer la fenêtre du terminal. Les écritures atomiques protègent `data\`. |
| Paramètres ou données incohérents | Serveur arrêté : supprimer `data\`, ou restaurer `..\GeoPlacer-recette-sauvegarde-data`. |
| Fichier du dépôt modifié par erreur | `git status` pour l'identifier, puis `git restore <fichier>`. Ne pas utiliser de commande destructive sur l'ensemble du dépôt sans vérifier. |
| Page blanche, JSON brut ou ancienne interface | Revenir à `http://127.0.0.1:3000/` (F13). Si le problème persiste : `cd frontend; npm run build; cd ..`, puis **Ctrl+F5**. |

## Compte rendu à transmettre

- Commit testé (étape 0).
- Le tableau des résultats (OK/KO) et, pour chaque KO, la capture ou le
  texte de l'erreur.
- Le message exact affiché au Ctrl+C (étape 5).
- Les messages de la console navigateur.
- Le navigateur et sa version.
