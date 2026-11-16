# Phase 2B — Plan de nettoyage Git et dossiers

État relevé le 16 novembre 2026, avant correctifs : `feat/phase2a-geopixels-provider`, HEAD `c658dd2bb58ba79a079d9316507c80c7a9ecaf2a`, arbre propre. Branche de travail créée : `feat/phase2b-reader-validation`. **Ce document propose les opérations futures ; aucune suppression, aucun déplacement, aucun tag ni push n'a été exécuté.** Aucun autre projet n'a été modifié.

## 1. Inventaire et relations d'historique

Commandes exécutées : `git status --short`, `git status --short --ignored`, `git branch -avv`, `git for-each-ref`, `git worktree list --porcelain`, `git remote -v`, `git tag --list`, `git fsck --full`, `git merge-base`, `git merge-base --is-ancestor`, `git rev-list`, `git ls-remote --heads --tags`. Les SHA annoncés ont été contrôlés sur les remotes sans les modifier ; les références locales n'ont pas été actualisées par un fetch pendant cet inventaire.

- 19 branches locales au départ, 20 après création de la branche 2B ; 7 références de branches distantes suivies et 2 HEAD symboliques. Aucun tag. Un seul worktree : le dossier GeoPlacer.
- `origin` : `https://github.com/Daneisra/GeoPlacer.git` ; `upstream` : `https://github.com/Arknight38/wplacer-dev.git`, push désactivé par `DISABLED_NO_PUSH`.
- Attention : **main suit actuellement upstream/main**, et non origin/main. Corriger ce suivi lors de sa promotion autorisée, avant d'utiliser un simple `git pull`.
- `main` = `origin/main` = `upstream/main` = `46877e120f9e7bc721084fdf88a9ae8f006cb117`.
- Main est ancêtre de la RC `fe392266a0605349f227e005a5e62904903b531f` : `rev-list --left-right --count main...integrate/6.0.0-rc.1-geopixels` donne **0 / 162**. L'avance rapide est donc possible à cet état précis.
- Toutes les branches locales antérieures à Phase 2A sont contenues dans la RC ; Phase 2A contient la RC et ses six nouveaux commits. Les correctifs 2B prolongent Phase 2A, sans modifier ces références anciennes.
- Les cinq branches de phases publiées ont les mêmes pointes que leurs branches locales. Main ne contient encore aucune de ces phases.

| Branche / référence | SHA au relevé | Présence | Contenue dans | Action proposée |
|---|---|---|---|---|
| `backup/avant-reecriture-email` | `19d64239e883b8e77a5fefd8e3061a45b0bdd7c8` | locale | RC fe392266 et Phase 2A c658dd2 | Archiver par référence/bundle ; candidate à suppression locale après accord |
| `feat/geopixels-ghost-export` | `b8fd851a4cedaa8050a98986a2225bd226738e10` | locale | RC fe392266 et Phase 2A c658dd2 | Archiver par référence/bundle ; candidate à suppression locale après accord |
| `feat/phase1a-fondation` | `19d64239e883b8e77a5fefd8e3061a45b0bdd7c8` | locale | RC fe392266 et Phase 2A c658dd2 | Archiver par référence/bundle ; candidate à suppression locale après accord |
| `feat/phase1b0-workspace` | `01bad6921522a9b30350e4048a7eb965df5de7e9` | locale | RC fe392266 et Phase 2A c658dd2 | Archiver par référence/bundle ; candidate à suppression locale après accord |
| `feat/phase1b1-geometry-colors` | `1309f38d97b9cad11bf53c57a17427c7301c8bcc` | locale | RC fe392266 et Phase 2A c658dd2 | Archiver par référence/bundle ; candidate à suppression locale après accord |
| `feat/phase1b10-demo-hardening` | `6bee19cb0463b17c1b18d7d8c5c9a11e7e560a9e` | locale | RC fe392266 et Phase 2A c658dd2 | Archiver par référence/bundle ; candidate à suppression locale après accord |
| `feat/phase1b2-template-manager` | `9a686e3ce9ba498043fe59ff7c445ec0bb22fe2a` | locale | RC fe392266 et Phase 2A c658dd2 | Archiver par référence/bundle ; candidate à suppression locale après accord |
| `feat/phase1b3-drawing-strategies` | `9b55cdea1ea04b697eba833342e8327ab7f54ea9` | locale | RC fe392266 et Phase 2A c658dd2 | Archiver par référence/bundle ; candidate à suppression locale après accord |
| `feat/phase1b4-progress-eta` | `25c4a64c95a75ea0ce15ec1ce0513c39a5c85074` | locale | RC fe392266 et Phase 2A c658dd2 | Archiver par référence/bundle ; candidate à suppression locale après accord |
| `feat/phase1b5-resources-upgrades` | `da27c8d3a8ab9bbc3a042a6d6b541fc176e07bd1` | locale | RC fe392266 et Phase 2A c658dd2 | Archiver par référence/bundle ; candidate à suppression locale après accord |
| `feat/phase1b6-work-planner` | `1988edd267358654a6f4c10569cd1ee391d8be6a` | locale | RC fe392266 et Phase 2A c658dd2 | Archiver par référence/bundle ; candidate à suppression locale après accord |
| `feat/phase1b7-journal-simulator` | `a6c8adfa488e8e58ad3182355f15caf3ae2be034` | locale | RC fe392266 et Phase 2A c658dd2 | Archiver par référence/bundle ; candidate à suppression locale après accord |
| `feat/phase1b8-single-agent-scheduler` | `61c3efa7eae16aa648627575c41493bdf2913c30` | locale | RC fe392266 et Phase 2A c658dd2 | Archiver par référence/bundle ; candidate à suppression locale après accord |
| `feat/phase1b9-server-dashboard` | `5132edee7710b1537de0f30c31f548049eff8e29` | locale | RC fe392266 et Phase 2A c658dd2 | Archiver par référence/bundle ; candidate à suppression locale après accord |
| `feat/phase1c0-release-candidate` | `c57e4788281a319376c0f4d8699f98c170601ffa` | locale | RC fe392266 et Phase 2A c658dd2 | Archiver par référence/bundle ; candidate à suppression locale après accord |
| `feat/phase2a-geopixels-provider` | `c658dd2bb58ba79a079d9316507c80c7a9ecaf2a` | locale | Phase 2A c658dd2 ; hors RC | Conserver comme référence historique récente |
| `feat/phase2b-reader-validation` | `c658dd2bb58ba79a079d9316507c80c7a9ecaf2a` | locale | c658dd2 au départ ; contient les correctifs 2B ensuite | Conserver activement : branche de cette phase |
| `integrate/6.0.0-rc.1-geopixels` | `fe392266a0605349f227e005a5e62904903b531f` | locale | RC fe392266 et Phase 2A c658dd2 | Conserver activement : RC validée |
| `main` | `46877e120f9e7bc721084fdf88a9ae8f006cb117` | locale | RC fe392266 et Phase 2A c658dd2 | Conserver ; main à promouvoir après validation |
| `release/6.0.0-rc.1` | `4a62e5d43e69ecf5a7932c13fe11e6153cd47d44` | locale | RC fe392266 et Phase 2A c658dd2 | Archiver par référence/bundle ; candidate à suppression locale après accord |
| `origin/HEAD` | `46877e120f9e7bc721084fdf88a9ae8f006cb117` | distante suivie | RC fe392266 et Phase 2A c658dd2 | Référence symbolique à conserver |
| `origin/feat/phase1b10-demo-hardening` | `6bee19cb0463b17c1b18d7d8c5c9a11e7e560a9e` | distante suivie | RC fe392266 et Phase 2A c658dd2 | Candidate à archivage puis suppression distante, après publication de la RC et accord |
| `origin/feat/phase1b7-journal-simulator` | `a6c8adfa488e8e58ad3182355f15caf3ae2be034` | distante suivie | RC fe392266 et Phase 2A c658dd2 | Candidate à archivage puis suppression distante, après publication de la RC et accord |
| `origin/feat/phase1b8-single-agent-scheduler` | `61c3efa7eae16aa648627575c41493bdf2913c30` | distante suivie | RC fe392266 et Phase 2A c658dd2 | Candidate à archivage puis suppression distante, après publication de la RC et accord |
| `origin/feat/phase1b9-server-dashboard` | `5132edee7710b1537de0f30c31f548049eff8e29` | distante suivie | RC fe392266 et Phase 2A c658dd2 | Candidate à archivage puis suppression distante, après publication de la RC et accord |
| `origin/feat/phase1c0-release-candidate` | `c57e4788281a319376c0f4d8699f98c170601ffa` | distante suivie | RC fe392266 et Phase 2A c658dd2 | Candidate à archivage puis suppression distante, après publication de la RC et accord |
| `origin/main` | `46877e120f9e7bc721084fdf88a9ae8f006cb117` | distante suivie | RC fe392266 et Phase 2A c658dd2 | Conserver ; main à promouvoir après validation |
| `upstream/HEAD` | `46877e120f9e7bc721084fdf88a9ae8f006cb117` | distante suivie | RC fe392266 et Phase 2A c658dd2 | Référence symbolique à conserver |
| `upstream/main` | `46877e120f9e7bc721084fdf88a9ae8f006cb117` | distante suivie | RC fe392266 et Phase 2A c658dd2 | Conserver ; main à promouvoir après validation |

Les doublons locale/distante sont volontairement explicites. « Contenue » résulte d'une vérification d'ancêtres, pas de l'âge du nom. La preuve doit être refaite juste avant chaque suppression. Un ancien nom de branche peut rester utile pour des liens ou des PR même si son code est conservé.

Deux références internes Codex sont également présentes, hors tableau des branches : `refs/codex/turn-diffs/captures/1794865209121/dfc3cb0d-9a2c-4d21-933b-4272e5959d6d/base` → `dbc6b4edb2486e6508540717a74ae7967ecf4bc6` et `refs/codex/turn-diffs/checkpoints/34a696d7326a458a4e6c9bdf793f39c3/c4a752e8b379cc128e238154aeeb4b2e/1794851722041/8146a572-2c27-4732-a930-d558dabf8011` → `d69fce287b23d382eba7451a15b1051d104f4238`. Elles ont été inventoriées et conservées avec les références du bundle/pack ; elles ne sont pas des branches à nettoyer manuellement.

## 2. Stratégie pour main

### Choix recommandé

Promouvoir d'abord la **RC consolidée validée** ; conserver le connecteur expérimental sur sa branche tant que son transport et les observations réelles ne sont pas validés. Le passage de main à GeoPlacer change 348 fichiers (+61 891 / −606 lignes par rapport à l'ancien main) : nouveau moteur local, dashboard, installation, journaux, sauvegardes, palettes et export PNG. Les anciennes routes Wplace restent désactivées. Ce n'est pas une mise à jour mineure du bot Wplacer.

Le dépôt GitHub est toujours un fork public de `Arknight38/wplacer-dev`, branche par défaut `main`. Une avance rapide ne détache pas ce lien de fork et ne modifie pas les forks des autres utilisateurs. Les liens à SHA restent stables ; les liens vers main changent de contenu. Des forks qui ont divergé devront intégrer volontairement ces changements. Ne pas conseiller de reset forcé. Prévenir les utilisateurs que l'installation et le fonctionnement changent.

L'API GitHub indique `protected: false` sur main à la consultation ; les rulesets n'ont pas été inventoriés exhaustivement. Proposer une protection adaptée au dépôt : empêcher suppression/force push, revue avant intégration, puis contrôles CI obligatoires **après création d'un workflow réel**. Aucun workflow GitHub Actions n'est présent aujourd'hui. Ne pas imposer un nom de contrôle qui n'existe pas. Si une règle impose une PR, utiliser la PR et son mode de fusion autorisé ; un merge commit change le SHA final et impose de reconstruire l'archive depuis ce nouveau SHA. Ne pas contourner les règles pour forcer une avance rapide.

### Procédure future, uniquement après accord pour main et publication

Arrêter les serveurs/watchers GeoPlacer ; sauvegarder aussi les données ignorées. Une bascule vers l'ancien main ne doit pas relancer son ancien code. Dans PowerShell, après sauvegarde externe vérifiée :

```powershell
Set-Location -LiteralPath 'D:\Téléchargements\Code\GeoPlacer'
git status --porcelain=v1
# Exiger une sortie vide et vérifier la branche courante.
git fetch --no-prune origin
git ls-remote origin refs/heads/main
git rev-parse main origin/main integrate/6.0.0-rc.1-geopixels
# Arrêter si origin/main a changé depuis le relevé ; examiner alors sa divergence.
git merge-base --is-ancestor main fe392266a0605349f227e005a5e62904903b531f
if ($LASTEXITCODE -ne 0) { throw 'Main a divergé : réexamen requis' }
git switch main
git merge --ff-only fe392266a0605349f227e005a5e62904903b531f
if ($LASTEXITCODE -ne 0) { throw 'Avance rapide refusée' }
git branch --set-upstream-to=origin/main main
npm.cmd run check:logged
if ($LASTEXITCODE -ne 0) { throw 'Contrôles en échec' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build en échec' }
git diff --check
git status --porcelain=v1
git rev-parse main
# Contrôler le SHA final et l'autorisation de publication avant les deux lignes suivantes.
git push --dry-run origin main:main
git push origin main:main
git ls-remote origin refs/heads/main
```

Le contrôle doit s'arrêter sur chaque code d'échec et sur tout fichier non prévu. L'autorisation de cette Phase 2B **ne permet pas d'exécuter cette procédure**. Ne pas utiliser `update.bat` pour cette migration : il affiche origin, mais utilise le suivi configuré pour `git pull`, et propose un abandon de modifications après confirmation. Préférer les commandes explicites ci-dessus.

Le générateur `scripts/build-release-archive.mjs` doit rester épinglé au commit exact validé. Conserver l'archive RC actuelle (fe39226) comme telle ; les versions, notes et contenu doivent correspondre au commit effectivement diffusé. Une future release du connecteur ne doit pas réutiliser cette ancienne archive comme si elle le contenait. Aucun tag/release créé ici.

### Historique sensible, licence et attribution

L'ancien main suit un `.env` de valeurs de configuration par défaut (HOST, PORT, FRONTEND_PORT, NODE_ENV). Son historique reste accessible après promotion ; le retrait d'un fichier à HEAD n'efface pas son passé. Le scan local des **2 055 blobs** (y compris objets non référencés, taille ≤ 5 Mo) ne trouve pas de motif à forte confiance de clé privée ou jeton GitHub/AWS. Ce scan ne garantit pas l'absence de tout secret possible. Aucun secret découvert ne justifie ici une réécriture. Conserver `.env`, données et logs locaux hors publication, examiner tout nouveau diff avant publication.

Conserver `LICENSE` AGPL-3.0-only, les auteurs originaux JinxTheCatto/luluwaffless, le crédit Wplacer et l'historique des contributions. Le changement de branche stable ne change pas les obligations de licence.

## 3. Sauvegardes réellement vérifiées

Chaque bundle a été vérifié par `git bundle verify`, cloné en dépôt miroir temporaire indépendant, puis contrôlé avec `git fsck --full`. Tous les codes de retour sont 0 ; aucun dépôt restauré n'est shallow et aucun ne possède d'alternates. Les répertoires temporaires de vérification ont été conservés. Les références détaillées et journaux sont dans `test-logs/phase2b/bundles.json`.

| Bundle | Octets | Commits restaurés | Couverture vérifiée | SHA-256 |
|---|---:|---:|---|---|
| `GeoPlacer-sauvegardes/2026-11-14-avant-reecriture-email/geoplacer-feat-phase1a-fondation.bundle` | 4 515 048 | 493 | main et Phase 1A | `db6ea1a5f5b791958db9631b3081066f42a21941e25fee41dd213ed208a20761` |
| `GeoPlacer-sauvegardes/2026-11-15-avant-phase1b7/geoplacer-toutes-branches.bundle` | 4 979 284 | 549 | jusqu'à Phase 1B6 ; pas la pointe finale 1B7 | `b99cae785fa668cb78f374d85098f79a00325908ad2001cf94aa2db2ce011560` |
| `GeoPlacer-sauvegardes/2026-11-16-avant-phase2a/GeoPlacer-avant-phase2a.bundle` | 5 562 552 | 637 | toutes anciennes phases et RC fe392266 ; pas Phase 2A | `2488299ccc278095e20dfd887f7b312ac94c1c814c0c68ffbdc380360d59dc5c` |
| `GeoPlacer/test-logs/phase2b/GeoPlacer-avant-phase2b.bundle` | 5 634 309 | 643 | jusqu'à Phase 2A c658dd2 | `3fc07cc7717b83fb80e024f8ec58bae6192bdfbaf19fa9cf375e93688b08cfd8` |

Les bundles autonomes couvrent les commits accessibles par leurs références, **pas** les fichiers ignorés ou les modifications non commitées. Le bundle initial 2B n'inclut pas les futurs correctifs de cette phase ; un nouveau bundle sera nécessaire avant nettoyage.

### Objets WIP non référencés : conservation impérative

`fsck` ne signale aucune corruption ni objet manquant, mais quatre anciens commits WIP/stash non rattachés à une référence, ainsi que des blobs/arbre isolés. `git stash list` est vide : ne pas les considérer comme des branches ou un stash encore nommé.

- `938fe05710b2ed300cb6ef2bd7911c9964fda8cf`
- `745de607b7f8dd041f665af2db326b292a32ebce`
- `52f32f4b7011631ae809342b4e34219713c5223f`
- `1eb4d4ebafac7709cc4cb592d39f12286547cd80`

Ils proviennent de travaux WIP sur Phase 1B7 (base 9713e765). Un bundle `--all` ne garantit pas leur conservation. Un pack de **tous les 4 611 objets** a donc été créé sans ajouter de référence au dépôt : `test-logs/phase2b/all-objects-before-phase2b.pack`, 7 047 283 octets, SHA-256 `5847a9dd2e2c91c44852e100f3cc953b71a5297a81936333e246c27325afb939`. Restauration dans un dépôt nu vide, recréation des références depuis le manifeste et fsck : réussis, sans dépendance au dépôt source. Conserver avec `refs-initial.txt`, `object-pack-restore.json`, `unreferenced-commits.json` et l'empreinte. **Ce pack est encore dans le projet et ignoré par Git**, pas une sauvegarde externe contre la perte du disque. Sa copie externe requiert votre accord. Aucune commande de GC/prune n'est recommandée avant archivage et examen de ces WIP.

Politique simple : garder les jalons avant réécriture et avant Phase 2A, le dernier état validé et le dernier état avant nettoyage ; conserver séparément trois sauvegardes de données récentes et trois mensuelles. Ne commencer aucune rotation avant validation d'une restauration complète et conservation des preuves uniques. Un autre support est nécessaire pour couvrir la perte du disque.

## 4. Inventaire réel des dossiers

Tailles **logiques** au relevé initial, pas l'allocation NTFS ; les jonctions ne sont pas additionnées deux fois. Les preuves et tests de cette phase augmentent ensuite GeoPlacer. Inventaire : `dossiers-initial.json`, `historical-folders-files.json`, `ignored-data-files.json`, `nested-repositories.json`, `complements.json` dans les journaux locaux de phase.

| Dossier | Octets / fichiers | Nature et état | Recommandation |
|---|---:|---|---|
| GeoPlacer | 433 158 320 / 31 138 | dépôt principal ; propre à c658dd2 avant phase ; seul worktree | Conserver actif ; sauvegarder aussi données/config ignorées |
| GeoPlacer-Audit | 431 468 346 / 29 005 | rapports, preuves, snapshots et quatre clones ; pas de Git à la racine | Conserver séparé, ne pas reconstruire l'audit |
| GeoPlacer-phase0 | 531 897 / 18 | rapports, logs, copies de lockfiles ; aucun Git/worktree | Archivage intégral futur, pas suppression |
| GeoPlacer-phase1a | 99 498 / 32 | rapports, logs et anciens scripts de vérification ; aucun Git/worktree | Archivage intégral futur, scripts laissés inertes |
| GeoPlacer-sauvegardes | 15 065 200 / 10 | trois bundles et manifestes/journaux | Conserver externe au projet, enrichir seulement après accord |
| GhostPixelBot-FR | 39 434 600 / 1 775 | dépôt indépendant GPL, propre, branche feat/i18n-french, HEAD 505348f028f20efa11b1c34b7b419ba3cd45c3f7 | Conserver actif et indépendant ; aucune modification |

### Données uniques et dépendances

- **GeoPlacer** : `.env` 235 octets, `.vscode/settings.json`, `data/settings.json` et copies `.bak`, `data/engine/` (3 681 814 octets), journaux, archives `release/` et `test-logs/` ignorés. Les fichiers users/templates hérités contiennent ici des objets/listes vides, mais le dossier engine contient des modèles et états utiles : ne pas déduire « aucune donnée » de ces deux petits fichiers. Sauvegarder à froid les données complètes. Quatre liens `node_modules/@geoplacer/*` ciblent les packages **à l'intérieur** de GeoPlacer, sans dépendance aux anciens dossiers de phases.
- **Phase0** : `RAPPORT-PHASE0.md`, `logs/`, `lockfiles/` ; 17/18 fichiers n'ont pas d'équivalent identique dans l'arbre suivi courant et 16/18 ne sont pas retrouvés comme blobs dans l'histoire accessible de Phase 2A. Les lockfiles sont des copies historiques de package-lock, pas des verrous actifs. Leurs empreintes sont conservées dans le manifeste original. Un bundle Git ne suffit pas à sauvegarder ce dossier.
- **Phase1a** : `RAPPORT-PHASE1A.md`, `AUDIT-ENV.md`, `COMMITS.txt`, recette, logs et scripts atomic/crash/smoke/security. 32/32 fichiers absents à l'identique de l'arbre courant, 31/32 absents des blobs historiques accessibles. Certains scripts visent explicitement les anciens chemins GeoPlacer/GeoPlacer-phase1a et un ancien scratchpad temporaire. Un déplacement exigera de conserver ces scripts comme preuves inertes ; ne pas les relancer sans révision. Aucune dépendance applicative actuelle envers eux n'a été trouvée dans les chemins examinés.
- **Audit** : `sources/` représente 428 363 273 octets ; présence de dépendances volumineuses et d'un snapshot Phase1C0 sans `.git`. Les clones : library `c3224ca90440ceb3cd4583cb3341486190f3c51e`, plusplus `880cd6cbd94c1ad609b34ac957b5b60f0507ad7d`, nymtuta `218ccdd1c511e59fcfc56202444491deb9d80f76`, wplacer `46877e1`. **La bibliothèque possède une modification préexistante de `dist/geopixelcons-library.js`**, 2 324 683 octets, SHA-256 `f9cc02c62d4ef1abe9f2ca903d0f1d0ac1ecbf6417f017207da188bf0a2a9823`. Les autres clones sont propres. Préserver cette différence avec les rapports, captures, preuves et scripts ; ne pas la perdre par restauration du clone.
- **GhostPixelBot-FR** : origin Daneisra/GeoPixelsBot, upstream Dax233/GeoPixelsBot ; node_modules et résultats de tests ignorés. L'historique de traduction et les captures lui appartiennent. Le dossier n'est pas un worktree de GeoPlacer.
- Déplacer les deux petits dossiers de phases ne libérerait qu'environ **0,6 Mo** ; l'intérêt est le rangement. Les dépendances constituent l'essentiel du volume. Leur suppression/reconstruction n'est pas autorisée ici et ne vaut pas preuve de sauvegarde des fichiers non suivis.

## 5. Organisation cible et opérations futures

```text
Code/
├── GeoPlacer/
├── GeoPlacer-Audit/
├── GhostPixelBot-FR/
├── GeoPlacer-sauvegardes/
└── Archives-Projets/
    ├── GeoPlacer-phase0/
    └── GeoPlacer-phase1a/
```

Aucune création dans Archives-Projets n'a été effectuée. Préférer **copie + manifeste vérifié + conservation temporaire de l'original**, puis déplacement/suppression uniquement après une autorisation distincte. Exemple complet pour Phase0, à répéter explicitement pour Phase1a après examen (ne pas automatiser une liste inconnue de chemins) :

```powershell
# FUTUR, après autorisation d'écriture hors GeoPlacer et de copie uniquement.
$codeRoot = (Resolve-Path -LiteralPath 'D:\Téléchargements\Code').Path
$source = (Resolve-Path -LiteralPath (Join-Path $codeRoot 'GeoPlacer-phase0')).Path
$archiveRoot = [IO.Path]::GetFullPath((Join-Path $codeRoot 'Archives-Projets'))
$destination = [IO.Path]::GetFullPath((Join-Path $archiveRoot 'GeoPlacer-phase0'))
if ($source -ne (Join-Path $codeRoot 'GeoPlacer-phase0')) { throw 'Source inattendue' }
if (-not $destination.StartsWith($archiveRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Destination hors archive' }
if (Test-Path -LiteralPath $destination) { throw 'Destination déjà présente : ne rien écraser' }
# Refuser toute jonction/symlink non examinée avant copie.
if (Get-ChildItem -LiteralPath $source -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Lien à examiner' }
function Get-ArchiveManifest([string]$directory) {
    Get-ChildItem -LiteralPath $directory -Force -Recurse -File | ForEach-Object {
        '{0}|{1}|{2}' -f $_.FullName.Substring($directory.Length + 1), $_.Length, (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    } | Sort-Object
}
$before = @(Get-ArchiveManifest $source)
New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $destination -Recurse -ErrorAction Stop
$after = @(Get-ArchiveManifest $destination)
if (Compare-Object $before $after) { throw 'Copie différente : conserver les deux dossiers et examiner' }
$before | Set-Content -LiteralPath ($destination + '.sha256-manifest.txt') -Encoding UTF8
# L'original reste en place. Aucun Remove-Item dans cette procédure.
```

Pour obtenir ensuite l'arborescence sans doublon, le déplacement/suppression des originaux exige un second accord après lecture des manifestes. Si l'on choisit plutôt un déplacement direct, contrôler les mêmes chemins absolus, l'absence de destination et `Move-Item -LiteralPath $source -Destination $destination -WhatIf` ; n'enlever `-WhatIf` qu'après autorisation explicite. Ne jamais déplacer GeoPlacer, son `.git` ou un worktree en procédant ainsi.

### Archivage et suppression future de branches

Avant toute suppression : dernier état commité, copie externe des bundles/pack/manifestes, sauvegarde séparée des données ignorées, restauration testée, aucune PR ou utilisation du nom de branche à préserver. Créer les tags d'archive seulement après accord ; un tag par pointe peut documenter un jalon, mais dupliquer tous les noms n'est pas obligatoire si un manifeste et une référence conservée prouvent l'accessibilité.

Exemple **pour une branche précise** (pas de boucle de suppression), à exécuter uniquement après accord :

```powershell
$branch = 'feat/phase1b0-workspace'
$expected = '01bad6921522a9b30350e4048a7eb965df5de7e9'
if ((git rev-parse $branch) -ne $expected) { throw 'Pointe modifiée' }
git merge-base --is-ancestor $expected integrate/6.0.0-rc.1-geopixels
if ($LASTEXITCODE -ne 0) { throw 'Commit non conservé par la RC' }
git switch feat/phase2b-reader-validation
# Après vérification du bundle externe/restauration et autorisation de suppression :
git branch -d $branch
```

`-d` doit rester sans forçage ; s'il refuse à cause du suivi ou d'un changement d'historique, arrêter et examiner. Les cinq branches distantes ne sont candidates qu'après publication autorisée de la RC sur une référence conservée distante. Exemple futur, après contrôle de `git ls-remote`, des PR ouvertes et accord :

```powershell
git push --dry-run origin --delete feat/phase1b7-journal-simulator
# Après validation de la pointe et de l'impact des liens :
git push origin --delete feat/phase1b7-journal-simulator
git ls-remote --heads origin
```

Les quatre autres noms doivent être décidés explicitement à partir du tableau, jamais extrapolés automatiquement. Ne pas supprimer les refs upstream ni les HEAD symboliques pour « réduire le nombre ». Les liens GitHub fondés sur les branches supprimées cesseraient de fonctionner ; les liens à commits restent possibles tant que l'histoire est conservée.

## 6. Contrôles avant/après et décisions requises

Rejouer status, branches/ref SHA, tags, worktrees, merge-base et fsck ; comparer aux manifestes. Vérifier restauration Git **et** données, démarrage, modèle, simulation, import/export après toute migration réellement approuvée. Aucune commande `git clean`, reset dur, suppression forcée, GC/prune ou réécriture n'est nécessaire à ce plan.

Autorisations encore nécessaires : copie de la nouvelle sauvegarde/pack hors GeoPlacer, création d'Archives-Projets, copie puis éventuel déplacement des deux dossiers, tags éventuels d'archive, suppressions locales nommées, promotion de main, push et suppressions distantes. Les règles de protection/CI doivent aussi être validées avant modification GitHub. **Rien de cela n'est inclus dans l'autorisation de Phase 2B.**
