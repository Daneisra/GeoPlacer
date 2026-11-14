# Installation sous Windows

Ce guide décrit le chemin d'installation **vérifié pendant la Phase 1A** sur
Windows 10 Pro (x64), avec Node.js 22.23.2 et npm 10.9.8.

## 1. Prérequis

| Outil | Version | Remarque |
|---|---|---|
| Node.js | **≥ 22.12.0** | Exigé par Vite 8 (`engines` du `package.json`) |
| npm | ≥ 10 | Livré avec Node.js 22 |
| Git | récent | Pour cloner le dépôt |

Aucun compilateur, Python, GTK ou Visual Studio Build Tools n'est nécessaire :
le module natif `canvas` est installé depuis son binaire officiel précompilé.

Vérification :

```powershell
node -v   # v22.12.0 ou plus récent
npm -v
```

## 2. Installation automatique (`start.bat`)

Depuis le dossier du projet :

```powershell
# Installe les dépendances sans lancer les serveurs
$env:GEOPLACER_SETUP_ONLY = "1"; .\start.bat; Remove-Item Env:GEOPLACER_SETUP_ONLY
```

`start.bat` exécute exactement les étapes manuelles ci-dessous. Sans
`GEOPLACER_SETUP_ONLY`, il ouvre ensuite deux fenêtres (backend et frontend en
mode développement).

## 3. Installation manuelle (chemin vérifié)

```powershell
# 1. Backend : dépendances exactes du lockfile, scripts d'installation désactivés
npm ci --ignore-scripts

# 2. Binaire officiel précompilé de canvas (sans node-gyp)
cd node_modules\canvas
node ..\prebuild-install\bin.js -r napi
cd ..\..

# 3. Frontend
cd frontend
npm ci --ignore-scripts
cd ..
```

Pourquoi `--ignore-scripts` ? Seuls quatre paquets ont des scripts
d'installation :

| Paquet | Script | Traitement |
|---|---|---|
| `canvas` | `prebuild-install -r napi \|\| node-gyp rebuild` | `prebuild-install` lancé seul, ce qui évite le repli sur une compilation C++ |
| `esbuild` | vérification du binaire | inutile, le binaire de la plateforme est installé par npm |
| `@scarf/scarf` | télémétrie d'installation | désactivée (`scarfSettings.enabled: false`) et non exécutée |
| `fsevents` | — | macOS uniquement |

Un `npm ci` **avec** scripts n'a pas été testé.

### Vérifier le binaire `canvas` (facultatif)

`prebuild-install` télécharge
`canvas-v3.2.3-napi-v7-win32-x64.tar.gz` depuis la release officielle
`Automattic/node-canvas` v3.2.3. Empreinte SHA-256 publiée par GitHub :

```
ba953cc8c38303ab94cc83461c7561506a5a3af37d6c678de4a47914d2d0bb48
```

L'archive est conservée dans le cache npm (`_prebuilds`). Pour comparer :

```powershell
Get-FileHash "$(npm config get cache)\_prebuilds\*canvas-v3.2.3-napi-v7-win32-x64.tar.gz" -Algorithm SHA256
```

## 4. Compiler et vérifier

Le dépôt contient deux ensembles de code, testés avec deux outils :
- le **serveur hérité** (`src/`), testé avec **Jest** ;
- les **nouveaux paquets** (`packages/core`, `packages/simulator`), testés
  avec **Vitest**.

```powershell
# Serveur hérité
npx tsc                       # compile le backend dans dist/
npm run test:legacy           # Jest (identique à « npm test »)
npm run lint                  # ESLint backend (0 erreur attendue)

# Nouveaux paquets
npm run build:packages        # tsc -b packages/core packages/simulator
npm run typecheck:packages    # types des sources et des tests (dont les @ts-expect-error)
npm run test:packages         # Vitest dans chaque paquet
npm run lint:packages         # ESLint sur packages/

# Tout
npm run test:all              # typecheck des paquets, puis Jest, puis Vitest
npm run check                 # tsc, lint, lint:packages, puis test:all (contrôle complet)
npm run build                 # paquets + backend + frontend

# Benchmarks géométrie et couleurs (quelques minutes)
npm run bench:core

# Un seul paquet, ou en mode surveillance
npm run test --workspace=packages/core
cd packages/core; npx vitest; cd ....

# Frontend seul
cd frontend; npm run build; cd ..
```

## 5. Lancer

### Mode production (vérifié)

```powershell
npm start               # node --env-file-if-exists=.env dist/server.js
```

Le serveur affiche `Server listening on http://127.0.0.1:3000`. L'interface
compilée (`frontend/dist`) est servie à la même adresse.

### Mode développement : anomalie ouverte (diagnostic de la Phase 1B.2)

Dans l'environnement de test, qui est non interactif, le backend lancé par
`npm run dev` ne démarre pas. Diagnostic du 14/11/2026 :
- sorties standard et d'erreur capturées séparément ;
- arbre de processus relevé ;
- cmd.exe et PowerShell essayés ;
- arrêt de tout l'arbre (`taskkill /T /F`) après chaque essai.

| Lancement | Entrée standard | Backend |
|---|---|---|
| `npm run dev` (cmd.exe ou PowerShell, avec ou sans `--raw`) | tube fourni par `concurrently` | **ne démarre pas** (aucune sortie en 120 s) |
| `npm run dev:backend` seul | tube ouvert et muet | **ne démarre pas** |
| `npm run dev:backend` seul | fermée (`ignore`) | démarre en 6 s |
| `concurrently` + `tsx` **sans** `watch` | tube | démarre |
| `concurrently` + `node --watch --import tsx` | tube | démarre en 6 s |

**Cause identifiée (déclencheur)** : `tsx watch` lit son entrée standard
(touche Entrée pour relancer). Quand cette entrée est un **tube** resté
ouvert, ce qui est toujours le cas sous `concurrently`, le serveur se
bloque au chargement de `chalk` 5.6.2, importé par `gradient-string`
3.0.0 (bannière de démarrage).

Isolé par bissection :
- un script trivial, `express`, `ws` et `swagger` ne bloquent pas ;
- `tty.isatty` seul ne bloque pas.

La ligne exacte en cause dans `chalk` n'est pas identifiée.

Dans un vrai terminal, `npm run dev:backend` reçoit la console et non un
tube : il doit fonctionner. **`npm run dev` reste à vérifier dans un vrai
terminal**, car `concurrently` donne toujours un tube à ses enfants.

**Contournement** (deux terminaux, ou `start.bat`) :

```powershell
npm run dev:backend     # terminal 1 : tsx watch, port 3000
npm run dev:frontend    # terminal 2 : Vite, port 5173
```

**Correction proposée, non appliquée** (à valider) : remplacer
`npx tsx watch` par `node --watch --import tsx` dans `dev` et
`dev:backend`. Vérifiée sous `concurrently` : démarrage en 6 s, et
relance automatique quand un fichier `.ts` importé change.

## 6. Configuration (`.env`)

`.env` est **local** : il n'est pas suivi par Git et ne doit jamais être
commité. Il ne doit contenir aucun secret.

- **Génération** : `start.bat` crée `.env` à partir de `.env.example`
  s'il est absent, sans jamais écraser un fichier existant. Manuellement :
  `Copy-Item .env.example .env`.
- **Fichier facultatif** : sans `.env`, le serveur démarre avec les
  valeurs par défaut ci-dessous (vérifié sur un clone neuf). Une valeur
  vide est traitée comme absente ; une valeur invalide est remplacée par son
  défaut, avec un avertissement `Invalid …` au démarrage.
- **Interface** : depuis la Phase 1B.1, l'interface compilée
  (`frontend/dist`) est servie dès qu'elle existe, **avec ou sans `.env`**
  et quel que soit `NODE_ENV` (vérifié sur un clone neuf sans `.env`). Si
  elle n'est pas compilée, une page affiche « Interface non compilée » (503)
  et indique la commande à lancer (`npm run build:frontend`).
- **Attention aux anciennes branches** : `.env` est encore suivi sur
  `main`, `feat/phase1a-fondation` et `backup/*`. Passer sur l'une d'elles
  **écrase en silence** le `.env` local par la version suivie, et revenir
  sur une branche récente **le supprime** (vérifié). Avant de changer de
  branche, copier `.env` hors du dépôt (par exemple
  `Copy-Item .env ..GeoPlacer-env-sauvegarde`). Pour le récupérer :
  recopier cette sauvegarde, ou repartir de `Copy-Item .env.example .env`.
  Le problème disparaîtra une fois ces branches remplacées.
- **Fichiers ignorés** : `.env` et `.env.*` sont ignorés par Git, sauf
  `.env.example` et `.env.*.example`.

| Variable | Défaut | Rôle |
|---|---|---|
| `HOST` | `127.0.0.1` | Adresse d'écoute. Une valeur invalide retombe sur `127.0.0.1`. `0.0.0.0` expose le serveur au réseau local, avec un avertissement au démarrage. |
| `PORT` | `3000` | Port principal. S'il est occupé, le serveur essaie une liste de ports de repli. |
| `ALLOWED_HOSTS` | *(vide)* | Noms d'hôte supplémentaires acceptés (protection contre le DNS rebinding) |
| `ALLOWED_ORIGINS` | `http://localhost:*,http://127.0.0.1:*,chrome-extension://*` | Origines navigateur autorisées |
| `JSON_BODY_LIMIT` | `12mb` | Taille maximale d'un corps JSON (un modèle de 2000×2000 pèse environ 11,4 Mo). Format : un entier, suivi éventuellement de `b`, `kb` ou `mb` ; toute autre forme (`1gb`, `1.5mb`) est remplacée par `12mb`, avec un avertissement |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `60000` / `300` | Limiteur de débit, appliqué à toutes les routes |

Voir `docs/fr/securite.md` pour le détail des protections.

## 7. Dépannage

- **`Cannot find module '../build/Release/canvas.node'`** : l'étape 2 de
  l'installation manuelle n'a pas été exécutée.
- **`npm ci` échoue avec `EBADENGINE`** : la version de Node.js est
  inférieure à 22.12.
- **Le pare-feu Windows demande une autorisation** : le serveur écoute sur
  autre chose que `127.0.0.1`. Vérifier `HOST` dans `.env`.
- **403 `forbidden-host` ou `forbidden-origin`** : l'adresse utilisée dans
  le navigateur n'est ni `localhost` ni `127.0.0.1`. Ajouter le nom à
  `ALLOWED_HOSTS` si c'est voulu.
