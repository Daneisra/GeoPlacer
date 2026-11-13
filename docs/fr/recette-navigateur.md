# Recette navigateur (Windows)

Procédure manuelle d'environ 15 minutes pour vérifier l'interface dans un
vrai navigateur. Elle complète les tests automatisés, qui ont tous été
exécutés depuis Node.

> **Règles** :
> - n'utiliser aucun compte Wplace ni GeoPixels ;
> - ne pas charger l'extension `LOAD_UNPACKED` ;
> - ne pas ajouter de compte ;
> - ne pas créer ni démarrer de modèle.

## Limites connues, à ne pas signaler comme régressions

- **F13** : en production, les adresses des pages (`/logs`, `/users`,
  `/templates`, `/settings`) sont aussi des routes de l'API. Un **F5** sur
  ces pages affiche du JSON ou du texte brut. Naviguer uniquement par le menu
  latéral, et recharger depuis `http://127.0.0.1:3000/`.
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
node --env-file=.env dist/server.js
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
| Templates | Liste vide | « Start all », « Stop all », démarrer un modèle (routes absentes du serveur, F12) | |
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

2. Relancer `node --env-file=.env dist/server.js`, ouvrir
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
| Port 3000 occupé | `$env:PORT=3100; node --env-file=.env dist/server.js` (sans modifier `.env`), puis ouvrir `http://127.0.0.1:3100/`. Le flux de logs en direct sera indisponible (port fixé à 3000). |
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
