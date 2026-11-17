# Installation sous Windows

Ce guide décrit l'installation **vérifiée** sur Windows 10 Pro (x64), avec
Node.js 22.23.2 et npm 10.9.8 : chemin manuel depuis la Phase 1A,
installation en une commande depuis la Phase 1B.10. Linux et macOS ne sont
pas vérifiés.

**En bref** : installer Node.js 22 LTS, récupérer le projet, puis
double-cliquer sur `setup.bat` (ou `npm run setup:windows`). Ensuite,
`start.bat` lance GeoPlacer et `start.bat --demo` la démonstration.

## Candidate consolidée 6.0.0-rc.1

Utiliser main, version de démonstration issue de la RC consolidée `fe392266`,
ou l’archive candidate correspondante. L’ancienne archive du commit `4a62e5d`
ne contient ni l’export intégré ni les palettes et ne représente plus la
candidate complète. Les connecteurs expérimentaux 2A–2D ne sont pas inclus.

```powershell
git clone --branch main https://github.com/Daneisra/GeoPlacer.git
cd GeoPlacer
npm run setup:windows
```

Après l’installation : tableau de bord pour la **simulation locale**, menu
**Préparer pour GeoPixels** pour le PNG et ses quatre modes de palette.
L’import du fichier dans GeoPixels et le dessin sont manuels. Les modèles
préparés sont inclus dans les sauvegardes du moteur.

L’utilisateur confirme le **Ctrl+C physique au clavier sous Windows**, le
16 novembre 2026. Cette confirmation ne se substitue pas aux tests automatiques
de reprise et ne prétend pas être une manipulation physique de Codex.

## 1. Prérequis

| Outil | Minimum (vérifié par l'installation) | Recommandé (vérifié en recette) | Remarque |
|---|---|---|---|
| Node.js | **22.12.0** | **22 LTS**, testé en 22.23.2 | Exigé par Vite 8 (`engines` du `package.json`) ; 23 et plus non testés |
| npm | 10 | 10.9.8 (livré avec Node.js 22) | Ne pas mettre npm à jour globalement pour GeoPlacer |
| Git | récent | — | Pour cloner et mettre à jour ; facultatif avec l'archive ZIP |

Aucun compilateur, Python, GTK ou Visual Studio Build Tools n'est nécessaire :
le module natif `canvas` est installé depuis son binaire officiel précompilé.

Vérification :

```powershell
node -v   # v22.12.0 ou plus récent
npm -v
```

Node.js s'installe avec l'installateur Windows de https://nodejs.org
(version 22 LTS) ; il fournit npm. Rien d'autre n'est installé
globalement.

## 2. Installation en une commande (Phase 1B.10)

Depuis le dossier du projet :

```powershell
npm run setup:windows
```

ou un double-clic sur **`setup.bat`**, qui lance la même commande puis
attend une touche pour laisser lire le résultat.

Six étapes, chacune expliquée en français en cas d'échec (« ÉCHEC à
l'étape … », puis « Que faire : … ») :

1. Node.js 22.12 ou plus récent, npm 10 ou plus récent ;
2. dépendances exactes des lockfiles, scripts d'installation désactivés :
   racine (avec les paquets du moteur, workspaces npm), puis interface ;
3. module natif `canvas` : son **binaire officiel précompilé**, sans
   compilation, puis un vrai chargement ;
4. compilation : paquets du moteur, serveur, interface ;
5. dossiers `data\` et `sauvegardes\`, et `.env` copié depuis
   `.env.example` **seulement s'il est absent** (aucun secret) ;
6. démarrage de contrôle dans un **dossier temporaire** (vos données ne
   sont pas utilisées) : le serveur démarre, l'API répond, l'arrêt contrôlé
   réussit.

Aucune modification globale : ni paquet npm global, ni réglage de
Windows, ni droits administrateur. La sortie complète est conservée dans
`test-logs\<date>-setup.log`. Options : `--verbose` (affiche toute la
sortie), `--skip-install` (saute l'étape 2).

**Vérifié sur un clone neuf** (16/11/2026) : dépôt cloné dans un dossier
vide, **cache npm vide** (aucune dépendance déjà présente), puis
`npm run setup:windows` : six étapes réussies en 3 min 40 environ (597
paquets à la racine, 262 pour l'interface), binaire `canvas` téléchargé
avec l'empreinte SHA-256 attendue (§ 3).

**Points d'entrée vérifiés sur un second clone neuf** (16/11/2026, cache
npm vide, `core.autocrlf=false` : les `.bat` restent en CRLF grâce à
`.gitattributes`) :

| Point d'entrée | Résultat |
|---|---|
| `.\start.bat` depuis zéro (`GEOPLACER_SETUP_ONLY=1`) | installation complète déclenchée par `start.bat`, six étapes réussies |
| `.\start.bat` (lancement) | serveur compilé démarré, API 200, interface servie |
| `start.bat --demo` | démonstration, Ctrl+C, reprise, sauvegarde, restauration (voir [recette-navigateur.md](recette-navigateur.md)) |
| `setup.bat` | six étapes réussies, puis « Appuyez sur une touche » |
| `update.bat` | `git pull` puis installation complète ; « All done ». Sans Git : en 1B.10, la branche héritée lançait winget (non testée) ; depuis la 1C.0, explication et arrêt, testé |
| `npm start` | dans Edge : bandeau, temps réel connecté, API 200, route héritée refusée (410), aucune erreur console, aucune requête externe |
| `npm run dev` | idem à travers Vite (`http://localhost:<port>`), ports libérés à l'arrêt |

### Audit de l'installation (Phase 1C.0)

`scripts/audit-installation-windows.mjs` rejoue, sur un **clone neuf**, les
cas qu'un utilisateur rencontre. Résultat du 16/11/2026 : **0 échec**.

| Cas | Résultat |
|---|---|
| Clone dans un chemin **avec espaces et accent**, installation par un Node.js placé dans un chemin **avec espaces** (comme `C:\Program Files\nodejs`), cache npm vide | Installation complète en 140 s ; empreinte SHA-256 de l'archive `canvas` vérifiée et conforme |
| Installation **interrompue** pendant `npm ci` (processus tué) | Jamais vue comme complète (`--check` = 1) ; `start.bat` la reprend entièrement |
| Installation **répétée** sur une installation existante | Réussie ; `.env` et `data\` conservés |
| **Nouveau commit** (comme après `git pull`) | `--check` = 2 ; `start.bat` recompile sans réinstaller (18 s) |
| **Dépendances modifiées** (lockfile) | `--check` = 1 : réinstallation |
| Dossier **impossible à créer** (un fichier porte son nom) | Échec expliqué (« ÉCHEC à l'étape « dossiers » », « Que faire »), sans pile d'erreur ; corrigé puis relancé : réussi |
| **Aucune modification globale** | Paquets npm globaux et préfixe identiques avant et après |

Défauts trouvés et corrigés pendant la Phase 1C.0 :
- l'étape `canvas` lançait Node.js à travers le shell : avec Node.js dans
  `C:\Program Files\nodejs` (installation standard), elle échouait
  (« … n'est pas reconnu en tant que commande interne », reproduit) ;
- une première version de la vérification d'empreinte plantait à chaque
  installation (constante utilisée avant son initialisation), puis ne
  trouvait pas l'archive : elle demandait le dossier à `npm config get
  cache`, qui renvoie le cache de npm (`%LOCALAPPDATA%\npm-cache`) et que
  npm refuse quand `npm_config_cache` est défini, alors que
  `prebuild-install`, lancé par `start.bat` ou `setup.bat`, télécharge dans
  `%APPDATA%\npm-cache`. Le dossier est maintenant calculé par la règle de
  `prebuild-install` ; vérifié dans les deux cas (sous `npm run`, et lancé
  directement avec un `APPDATA` de test). Trouvés par cet audit, corrigés,
  puis audit refait en entier.

Rejouer l'audit (télécharge les dépendances, n'écrit que dans le dossier
indiqué) :

```powershell
node scripts/audit-installation-windows.mjs <dépôt> <branche> <dossier neuf>
```

**Archive ZIP** (sans Git) : vérifiée sur une archive produite par
`git archive` (comme celle de GitHub), extraite dans un dossier neuf :
`start.bat` installe tout, `--check` fonctionne sans Git (le commit n'est
alors pas comparé : après avoir remplacé les fichiers par une nouvelle
archive, lancer `npm run setup:windows`), `npm start` fonctionne.

Les **droits d'administration** ne sont jamais demandés. Un dossier en
lecture seule (ACL Windows) n'a pas été testé tel quel : son effet est le
même échec expliqué que le cas « dossier impossible à créer ».

### `start.bat`

`start.bat` (double-clic) est le lanceur :

- il demande d'abord l'état de l'installation
  (`node scripts\setup-windows.mjs --check`, Phase 1C.0) : au premier
  lancement, après une installation interrompue ou si les dépendances ont
  changé, il lance l'installation complète ; si seul le code a changé
  (après un `git pull`), il recompile seulement ;
- puis il lance GeoPlacer **dans la même fenêtre** (`npm start`) ;
  `start.bat --demo` lance la démonstration (`npm run demo`) ;
- Ctrl+C l'arrête proprement.

Avec `GEOPLACER_SETUP_ONLY=1`, il s'arrête après l'installation :

```powershell
$env:GEOPLACER_SETUP_ONLY = "1"; .\start.bat; Remove-Item Env:GEOPLACER_SETUP_ONLY
```

Jusqu'à la Phase 1B.9, `start.bat` ouvrait deux fenêtres de développement
(`tsx watch` et Vite). Le mode développement reste `npm run dev` (§ 5).

## 3. Installation manuelle (chemin vérifié)

C'est ce que fait `npm run setup:windows`, étape par étape.

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

L'installation vérifie elle-même cette empreinte (Phase 1C.0). L'archive
est conservée dans le dossier `_prebuilds` du cache utilisé par
`prebuild-install` : `%APPDATA%\npm-cache` après `start.bat` ou
`setup.bat`, `%LOCALAPPDATA%\npm-cache` après `npm run setup:windows`.
Pour comparer à la main :

```powershell
Get-FileHash "$env:APPDATA\npm-cache\_prebuilds\*canvas-v3.2.3-napi-v7-win32-x64.tar.gz", "$env:LOCALAPPDATA\npm-cache\_prebuilds\*canvas-v3.2.3-napi-v7-win32-x64.tar.gz" -Algorithm SHA256 -ErrorAction SilentlyContinue
```

## 4. Compiler et vérifier

Le dépôt contient deux ensembles de code, testés avec deux outils :
- le **serveur hérité** (`src/`), testé avec **Jest** ;
- les **nouveaux paquets** (`packages/core`, `packages/simulator`), testés
  avec **Vitest**.

```powershell
# Serveur
npm run build:packages        # nécessaire avant tsc et Jest : le serveur importe les paquets compilés
npx tsc                       # compile le backend dans dist/
npm run test:legacy           # Jest (identique à « npm test » ; construit d'abord les paquets)
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

Le serveur affiche `Engine ready: local simulation only`, puis `Server
listening on http://127.0.0.1:3000`. L'interface compilée
(`frontend/dist`) est servie à la même adresse ; le tableau de bord pilote
la simulation locale (voir [guide-utilisateur.md](guide-utilisateur.md)).

Sur un **clone neuf**, `npm run build` exige aussi `cd frontend; npm ci`
(fait par `npm run setup:windows`).

**Démonstration** : `npm run demo` lance le même serveur sur un dossier
séparé, `data\demo` (voir [demonstration.md](demonstration.md)).

**Arrêt** : une fois **Ctrl+C**. Le moteur s'arrête après l'écriture en
cours, libère son dossier et le serveur affiche `Graceful shutdown
completed`. Le détail est dans le guide utilisateur, § 4.

**Une seule instance par dossier de moteur** : un second `npm start` sur
le même dossier s'arrête aussitôt (code 2) avec « already used by another
GeoPlacer instance ». Pour deux instances, lancer la seconde depuis un
**autre dossier de travail**, avec un autre port. Changer seulement
`GEOPLACER_ENGINE_DIR` ne suffit pas : les fichiers hérités
`data\*.json` resteraient partagés.

`start.bat`, `start.sh`, `npm start`, `npm run dev` et `npm run
dev:backend` construisent d'abord les paquets du moteur (Phase 1B.9).

### Mettre à jour

`git pull`, puis `start.bat` (il recompile, ou réinstalle si les
dépendances ont changé). `update.bat` (hérité) fait la même chose ; s'il ne
trouve pas Git, il explique comment l'installer et s'arrête, sans rien
installer lui-même (branche testée avec un `PATH` sans Git).

### Mode développement (corrigé en Phase 1B.3)

```powershell
npm run dev             # backend (port 3000) + frontend Vite (port 5173)
npm run dev:backend     # backend seul
npm run dev:frontend    # frontend seul
```

Le backend tourne sous `node --watch --env-file-if-exists=.env --import tsx
src/server.ts`. Node relance le serveur dès qu'un fichier chargé change, et
`tsx` compile le TypeScript à la volée. `Ctrl+C` arrête tout ; Windows
demande ensuite « Terminer le programme de commandes (O/N) ? ». Ce message
vient de cmd.exe et des raccourcis `.cmd` de npm, les serveurs sont déjà
arrêtés.

#### Problème corrigé

Jusqu'à la Phase 1B.2, le backend lancé par `npm run dev` ne démarrait
jamais. C'est un problème connu de `tsx` sous Windows
([privatenumber/tsx#623](https://github.com/privatenumber/tsx/issues/623),
toujours ouvert) :
- `tsx watch` écoute son entrée standard (touche Entrée pour relancer) ;
- quand cette entrée est un **tube**, le processus du serveur se bloque à
  l'import du module `process` (analyse publiée dans l'issue, non
  confirmée par le mainteneur) ;
- `chalk` 5 fait cet import (ici via `gradient-string`, pour la bannière de
  démarrage).

`concurrently` donne toujours un tube à ses enfants : `npm run dev`
bloquait donc aussi dans un vrai terminal. La Phase 1B.2 avait isolé ce
déclencheur (`tsx watch`, entrée en tube, `chalk`) sans en connaître la
cause.

#### Comparaison des deux corrections (14/11/2026)

Essais automatisés sous Windows 10 :
- lancement dans une **vraie console** (nouvelle fenêtre réduite, `Ctrl+C`
  envoyé à la console) ou avec une entrée en **tube** (tâches d'éditeur,
  scripts) ;
- modification d'un fichier du backend (`src/routes/palette.ts`) et du
  frontend (`frontend/src/index.css`), restaurés ensuite ;
- arbre de processus relevé avant l'arrêt.

| Commande | Entrée | Démarrage | Modification backend | Modification frontend | Arrêt par `Ctrl+C` |
|---|---|---|---|---|---|
| Ancien `npm run dev` | console | **backend bloqué** | — | prise en compte | — |
| Ancien `npm run dev:backend` | console | backend en 21 s | relancé, de retour en 7 s | — | propre en 4 s |
| `concurrently -r` + `tsx watch` (issue #623) | console | backend en 31 s, frontend en 26 s | relancé, de retour en 8 s | prise en compte en 0,9 s | propre en 4 s |
| `concurrently -r` + `tsx watch` | tube | **backend bloqué** | — | prise en compte | non testé |
| `concurrently` + `node --watch --import tsx` | console | backend en 21 s, frontend en 25 s | relancé, de retour en 7 s | prise en compte en 0,9 s | propre en 5 s |
| `concurrently` + `node --watch --import tsx` | tube | backend en 20 s, frontend en 25 s | relancé, de retour en 8 s | prise en compte en 0,8 s | non testé |

Les durées de démarrage varient d'un essai à l'autre (cache disque, charge
de la machine). Dans tous les cas, l'arrêt n'a laissé ni processus Node
orphelin ni port 3000 ou 5173 occupé.

**Choix : `node --watch --import tsx`.**
- **Fiabilité** : il fonctionne aussi avec une entrée en tube, car aucun
  processus n'écoute l'entrée standard. L'option `-r` de `concurrently`
  donne simplement la console aux enfants : elle ne marche que dans un vrai
  terminal et bloque encore dans une tâche d'éditeur ou un script.
- **Simplicité** : `node --watch` est intégré à Node 22, sans nouvelle
  dépendance ; `tsx` ne sert plus qu'à charger le TypeScript.
- **Lisibilité** : avec `-r`, `concurrently` perd les préfixes
  `[backend]` / `[frontend]` et les couleurs.

Ce qui change : la touche Entrée ne relance plus le backend (fonction de
`tsx watch`). Il suffit d'enregistrer un fichier, ou d'arrêter et de
relancer.

#### Vérification des scripts corrigés

| Script | Entrée | Démarrage | Modification backend | Modification frontend | Arrêt par `Ctrl+C` |
|---|---|---|---|---|---|
| `npm run dev` | console | backend en 11 s, frontend en 14 s | relancé, de retour en 6 s | prise en compte en 0,8 s | propre en 4 s, ports libérés |
| `npm run dev` | tube | backend en 10 s, frontend en 14 s | relancé, de retour en 7 s | prise en compte en 0,8 s | non testé |
| `npm run dev:backend` | console | backend en 11 s | relancé, de retour en 6 s | — | propre en 4 s, port libéré |
| `npm run dev:backend` | tube | backend en 8 s | relancé, de retour en 13 s | — | non testé |

Avec une entrée en tube, il n'y a pas de console à qui envoyer `Ctrl+C` :
l'arrêt de ces essais a été forcé (`taskkill /T /F`).

## 6. Configuration (`.env`)

`.env` est **local** : il n'est pas suivi par Git et ne doit jamais être
commité. Il ne doit contenir aucun secret.

- **Génération** : `npm run setup:windows` (lancé aussi par `setup.bat`
  et par `start.bat` au premier lancement) crée `.env` à partir de
  `.env.example`
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
| `GEOPLACER_ENGINE_DIR` | `data\engine` | Dossier du moteur : modèles, journal, toile simulée, réglages (Phase 1B.9). `npm run demo` utilise `data\demo` |
| `GEOPLACER_BACKUP_DIR` | `sauvegardes` | Dossier des sauvegardes, pour le serveur et pour `npm run backup` (Phase 1B.10) |
| `LEGACY_KEEPALIVE` | *(ignoré)* | Depuis la Phase 1B.10, le keep-alive hérité n'existe plus : la variable est ignorée, avec un avertissement au démarrage |

Voir `docs/fr/securite.md` pour le détail des protections.

## 7. Dépannage

- **L'installation s'arrête sur « ÉCHEC à l'étape … »** : lire la ligne
  « Que faire », puis le journal `test-logs\<date>-setup.log`. Relancer
  `npm run setup:windows` après correction ne casse rien.
- **`Cannot find module '../build/Release/canvas.node'`** : l'étape 3 de
  l'installation n'a pas abouti (relancer `npm run setup:windows`).
- **« GeoPlacer cannot start on this data directory »** : une autre
  instance tourne sur ce dossier, ou une restauration a été interrompue
  (voir [sauvegarde-restauration.md](sauvegarde-restauration.md), § 4).
- **`npm ci` échoue avec `EBADENGINE`** : la version de Node.js est
  inférieure à 22.12.
- **Le pare-feu Windows demande une autorisation** : le serveur écoute sur
  autre chose que `127.0.0.1`. Vérifier `HOST` dans `.env`.
- **403 `forbidden-host` ou `forbidden-origin`** : l'adresse utilisée dans
  le navigateur n'est ni `localhost` ni `127.0.0.1`. Ajouter le nom à
  `ALLOWED_HOSTS` si c'est voulu.
