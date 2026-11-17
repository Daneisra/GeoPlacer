# Plan de nettoyage Git et dossiers — actualisation Phase 2D

Relevé du **17 novembre 2026**. La seule publication autorisée et effectuée est `feat/phase2c-connector-transport`, sur origin, SHA `ea897de4aac0a174ef038733ace29f6c20dcdad0`. La branche 2D reste locale. Aucun nettoyage n'a été exécuté. Main, remotes, tags, branches historiques et dossiers originaux sont conservés.

## 1. Inventaire et preuve de conservation

Les relations ci-dessous sont contrôlées par `git merge-base --is-ancestor`, pas déduites de l'ancienneté. RC = `fe392266a0605349f227e005a5e62904903b531f`. La référence distante conservée origin/2C contient la RC, 2A, 2B et les sept commits validés de 2C. Elle fournit maintenant une conservation distante aux cinq anciennes branches de phases ; leurs noms peuvent néanmoins rester nécessaires à des liens ou des PR.

| Branche | SHA au relevé avant commit documentaire | Présence | Commit accessible depuis | Proposition |
|---|---|---|---|---|
| `backup/avant-reecriture-email` | `19d64239e883b8e77a5fefd8e3061a45b0bdd7c8` | Locale | RC, origin/2C | Candidate locale, après accord et contrôles |
| `feat/geopixels-ghost-export` | `b8fd851a4cedaa8050a98986a2225bd226738e10` | Locale | RC, origin/2C | Candidate locale, après accord et contrôles |
| `feat/phase1a-fondation` | `19d64239e883b8e77a5fefd8e3061a45b0bdd7c8` | Locale | RC, origin/2C | Candidate locale, après accord et contrôles |
| `feat/phase1b0-workspace` | `01bad6921522a9b30350e4048a7eb965df5de7e9` | Locale | RC, origin/2C | Candidate locale, après accord et contrôles |
| `feat/phase1b1-geometry-colors` | `1309f38d97b9cad11bf53c57a17427c7301c8bcc` | Locale | RC, origin/2C | Candidate locale, après accord et contrôles |
| `feat/phase1b10-demo-hardening` | `6bee19cb0463b17c1b18d7d8c5c9a11e7e560a9e` | Locale | RC, origin/2C | Candidate locale, après accord et contrôles |
| `feat/phase1b2-template-manager` | `9a686e3ce9ba498043fe59ff7c445ec0bb22fe2a` | Locale | RC, origin/2C | Candidate locale, après accord et contrôles |
| `feat/phase1b3-drawing-strategies` | `9b55cdea1ea04b697eba833342e8327ab7f54ea9` | Locale | RC, origin/2C | Candidate locale, après accord et contrôles |
| `feat/phase1b4-progress-eta` | `25c4a64c95a75ea0ce15ec1ce0513c39a5c85074` | Locale | RC, origin/2C | Candidate locale, après accord et contrôles |
| `feat/phase1b5-resources-upgrades` | `da27c8d3a8ab9bbc3a042a6d6b541fc176e07bd1` | Locale | RC, origin/2C | Candidate locale, après accord et contrôles |
| `feat/phase1b6-work-planner` | `1988edd267358654a6f4c10569cd1ee391d8be6a` | Locale | RC, origin/2C | Candidate locale, après accord et contrôles |
| `feat/phase1b7-journal-simulator` | `a6c8adfa488e8e58ad3182355f15caf3ae2be034` | Locale | RC, origin/2C | Candidate locale, après accord et contrôles |
| `feat/phase1b8-single-agent-scheduler` | `61c3efa7eae16aa648627575c41493bdf2913c30` | Locale | RC, origin/2C | Candidate locale, après accord et contrôles |
| `feat/phase1b9-server-dashboard` | `5132edee7710b1537de0f30c31f548049eff8e29` | Locale | RC, origin/2C | Candidate locale, après accord et contrôles |
| `feat/phase1c0-release-candidate` | `c57e4788281a319376c0f4d8699f98c170601ffa` | Locale | RC, origin/2C | Candidate locale, après accord et contrôles |
| `feat/phase2a-geopixels-provider` | `c658dd2bb58ba79a079d9316507c80c7a9ecaf2a` | Locale | origin/2C | Référence historique récente à conserver |
| `feat/phase2b-reader-validation` | `54add74aca4f1281fcba9f2e698ab7af0dceee91` | Locale | origin/2C | Référence historique récente à conserver |
| `feat/phase2c-connector-transport` | `ea897de4aac0a174ef038733ace29f6c20dcdad0` | Locale | origin/2C | Référence publiée conservée, ne pas supprimer |
| `feat/phase2d-live-observation` | `2758d270a63c7465590323c56fadfa88d52a9727` | Locale | Branche active locale | Branche active locale ; conserver |
| `integrate/6.0.0-rc.1-geopixels` | `fe392266a0605349f227e005a5e62904903b531f` | Locale | RC, origin/2C | Conserver |
| `main` | `46877e120f9e7bc721084fdf88a9ae8f006cb117` | Locale | RC, origin/2C | Conserver |
| `release/6.0.0-rc.1` | `4a62e5d43e69ecf5a7932c13fe11e6153cd47d44` | Locale | RC, origin/2C | Candidate locale, après accord et contrôles |
| `origin/HEAD` | `46877e120f9e7bc721084fdf88a9ae8f006cb117` | Distante suivie | RC, origin/2C | Conserver |
| `origin/feat/phase1b10-demo-hardening` | `6bee19cb0463b17c1b18d7d8c5c9a11e7e560a9e` | Distante suivie | RC, origin/2C | Candidate distante, après accord et contrôle des liens/PR |
| `origin/feat/phase1b7-journal-simulator` | `a6c8adfa488e8e58ad3182355f15caf3ae2be034` | Distante suivie | RC, origin/2C | Candidate distante, après accord et contrôle des liens/PR |
| `origin/feat/phase1b8-single-agent-scheduler` | `61c3efa7eae16aa648627575c41493bdf2913c30` | Distante suivie | RC, origin/2C | Candidate distante, après accord et contrôle des liens/PR |
| `origin/feat/phase1b9-server-dashboard` | `5132edee7710b1537de0f30c31f548049eff8e29` | Distante suivie | RC, origin/2C | Candidate distante, après accord et contrôle des liens/PR |
| `origin/feat/phase1c0-release-candidate` | `c57e4788281a319376c0f4d8699f98c170601ffa` | Distante suivie | RC, origin/2C | Candidate distante, après accord et contrôle des liens/PR |
| `origin/feat/phase2c-connector-transport` | `ea897de4aac0a174ef038733ace29f6c20dcdad0` | Distante suivie | origin/2C | Référence publiée conservée, ne pas supprimer |
| `origin/main` | `46877e120f9e7bc721084fdf88a9ae8f006cb117` | Distante suivie | RC, origin/2C | Conserver |
| `upstream/HEAD` | `46877e120f9e7bc721084fdf88a9ae8f006cb117` | Distante suivie | RC, origin/2C | Conserver |
| `upstream/main` | `46877e120f9e7bc721084fdf88a9ae8f006cb117` | Distante suivie | RC, origin/2C | Conserver |

**Les 16 candidates locales explicites :**

- `backup/avant-reecriture-email` — `19d64239e883b8e77a5fefd8e3061a45b0bdd7c8`.
- `feat/geopixels-ghost-export` — `b8fd851a4cedaa8050a98986a2225bd226738e10`.
- `feat/phase1a-fondation` — `19d64239e883b8e77a5fefd8e3061a45b0bdd7c8`.
- `feat/phase1b0-workspace` — `01bad6921522a9b30350e4048a7eb965df5de7e9`.
- `feat/phase1b1-geometry-colors` — `1309f38d97b9cad11bf53c57a17427c7301c8bcc`.
- `feat/phase1b10-demo-hardening` — `6bee19cb0463b17c1b18d7d8c5c9a11e7e560a9e`.
- `feat/phase1b2-template-manager` — `9a686e3ce9ba498043fe59ff7c445ec0bb22fe2a`.
- `feat/phase1b3-drawing-strategies` — `9b55cdea1ea04b697eba833342e8327ab7f54ea9`.
- `feat/phase1b4-progress-eta` — `25c4a64c95a75ea0ce15ec1ce0513c39a5c85074`.
- `feat/phase1b5-resources-upgrades` — `da27c8d3a8ab9bbc3a042a6d6b541fc176e07bd1`.
- `feat/phase1b6-work-planner` — `1988edd267358654a6f4c10569cd1ee391d8be6a`.
- `feat/phase1b7-journal-simulator` — `a6c8adfa488e8e58ad3182355f15caf3ae2be034`.
- `feat/phase1b8-single-agent-scheduler` — `61c3efa7eae16aa648627575c41493bdf2913c30`.
- `feat/phase1b9-server-dashboard` — `5132edee7710b1537de0f30c31f548049eff8e29`.
- `feat/phase1c0-release-candidate` — `c57e4788281a319376c0f4d8699f98c170601ffa`.
- `release/6.0.0-rc.1` — `4a62e5d43e69ecf5a7932c13fe11e6153cd47d44`.

**Les cinq candidates distantes explicites :**

- `origin/feat/phase1b10-demo-hardening` — `6bee19cb0463b17c1b18d7d8c5c9a11e7e560a9e`.
- `origin/feat/phase1b7-journal-simulator` — `a6c8adfa488e8e58ad3182355f15caf3ae2be034`.
- `origin/feat/phase1b8-single-agent-scheduler` — `61c3efa7eae16aa648627575c41493bdf2913c30`.
- `origin/feat/phase1b9-server-dashboard` — `5132edee7710b1537de0f30c31f548049eff8e29`.
- `origin/feat/phase1c0-release-candidate` — `c57e4788281a319376c0f4d8699f98c170601ffa`.

Conserver activement main, la RC consolidée, 2C publiée et 2D active. Conserver 2A et 2B comme jalons récents ; ne pas supprimer les références upstream/HEAD ou les références internes Codex. Un seul worktree de développement a été relevé. Les clones de vérification sont des dépôts autonomes dans Temp, sans alternates ; ils ne sont pas des worktrees à détacher.

La recherche des PR ouvertes dans Daneisra/GeoPlacer au 17 novembre ne renvoie aucune PR ; cette vérification est à refaire avant tout retrait et ne couvre pas tous les liens ou PR dans d'autres dépôts. Pas de tag d'archive créé. Un tag par ancienne branche n'est pas indispensable si les pointes sont conservées et inventoriées ; tout tag futur demande un accord explicite.

### Contrôles et commandes futures de branches

**Ces commandes sont un plan, pas une autorisation d'exécution.** Arrêter les serveurs avant les changements de branches ; préserver le travail non commité et sauvegarder les données ignorées. Créer un nouveau bundle comprenant le dernier état 2D et tester sa restauration avant la première suppression.

```powershell
git status --porcelain=v1
git fetch --no-prune origin
git ls-remote origin refs/heads/feat/phase2c-connector-transport refs/heads/main
git for-each-ref --format='%(refname)|%(objectname)|%(upstream)'
git worktree list --porcelain
git fsck --full
git bundle verify '<bundle-externe-verifie>'
# Contrôler également le pack WIP et la sauvegarde des données privées.
```

Exemple précis, **uniquement après accord de suppression locale** :

```powershell
$brancheHistorique = 'feat/phase1b0-workspace'
$shaHistorique = '01bad6921522a9b30350e4048a7eb965df5de7e9'
if ((git rev-parse $brancheHistorique) -ne $shaHistorique) { throw 'Pointe modifiée' }
if ((git rev-parse origin/feat/phase2c-connector-transport) -ne 'ea897de4aac0a174ef038733ace29f6c20dcdad0') { throw 'Référence de conservation à réexaminer' }
git merge-base --is-ancestor $shaHistorique origin/feat/phase2c-connector-transport
if ($LASTEXITCODE -ne 0) { throw 'Commit non conservé à distance' }
git merge-base --is-ancestor $shaHistorique HEAD
if ($LASTEXITCODE -ne 0) { throw 'Branche active insuffisante' }
git branch -d $brancheHistorique
# Si -d refuse, arrêter ; aucun -D et aucun forçage.
```

Répéter les contrôles pour chaque nom du tableau, sans boucle de suppression. Pour une ancienne branche distante, après accord distinct, revue des PR et liens, vérification de son SHA par `git ls-remote`, et conservation de ce SHA dans origin/2C :

```powershell
git push --dry-run origin --delete feat/phase1b7-journal-simulator
# Seulement après l'accord de suppression distante :
git push origin --delete feat/phase1b7-journal-simulator
git ls-remote --heads origin
```

Ces deux push de suppression ne sont PAS autorisés en Phase 2D. Ne pas supprimer origin/2C ou publier 2D implicitement en appliquant ce plan.

## 2. Promotion proposée de main

Main local et origin/main restent `46877e120f9e7bc721084fdf88a9ae8f006cb117`. Main local suit **upstream/main**, pas origin/main. L'avance rapide vers la RC `fe392266` est vérifiée possible ; ne pas promouvoir le portage expérimental à la place de cette RC validée.

La promotion conserve le lien de fork et les anciens commits. Les liens à SHA restent stables ; le contenu des liens à main changera. Les forks divergents ne sont pas mis à jour automatiquement. Prévenir que l'ancien Wplacer devient l'application locale GeoPlacer, avec nouvelle installation et routes historiques désactivées. Conserver LICENSE AGPL-3.0-only, MODIFICATIONS et les attributions JinxTheCatto, luluwaffless, Arknight38 et contributeurs.

Avant promotion : sauvegarde Git et données à froid, serveur arrêté, arbre propre, protection de branche recontrôlée sur GitHub, compatibilité des instructions d'installation. Si une règle impose une PR, respecter cette règle et réexaminer le SHA obtenu ; ne pas contourner la protection pour imposer une avance rapide. Un workflow CI obligatoire ne peut être exigé sous un nom inexistant.

**Procédure future après accord spécifique pour main et son push :**

```powershell
git status --porcelain=v1
git fetch --no-prune origin
git ls-remote origin refs/heads/main
if ((git rev-parse main) -ne '46877e120f9e7bc721084fdf88a9ae8f006cb117') { throw 'Main local a changé' }
if ((git rev-parse origin/main) -ne '46877e120f9e7bc721084fdf88a9ae8f006cb117') { throw 'Main distant a changé' }
git merge-base --is-ancestor origin/main fe392266a0605349f227e005a5e62904903b531f
if ($LASTEXITCODE -ne 0) { throw 'Avance rapide impossible' }
git switch main
git merge --ff-only fe392266a0605349f227e005a5e62904903b531f
if ($LASTEXITCODE -ne 0) { throw 'Arrêter et examiner' }
git branch --set-upstream-to=origin/main main
npm.cmd run check:logged
if ($LASTEXITCODE -ne 0) { throw 'Contrôles en échec' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build en échec' }
git diff --check
git status --porcelain=v1
git rev-parse HEAD
# Exiger arbre propre et SHA fe392266 avant le push explicitement approuvé :
git push --dry-run origin main:main
git push origin main:main
git ls-remote origin refs/heads/main
```

Aucun git pull sur main. Ne pas utiliser update.bat pour cette promotion : il dépend du suivi courant. Le générateur d'archive doit rester épinglé au commit réellement diffusé ; l'archive RC fe39226 est conservée comme RC et n'inclut pas 2A–2D. Aucun tag ni release ne découle de ce plan.

L'ancien historique contient un .env de configuration par défaut, déjà examiné en 2B ; retirer un fichier de HEAD n'efface pas l'histoire. Le contrôle de publication 2C a examiné les 162 blobs des 31 commits non encore présents sur origin, sans secret à forte confiance ni données privées détectées. Cela ne garantit pas l'absence de tout secret imaginable et ne justifie aucune réécriture de l'histoire.

## 3. Sauvegardes vérifiées et rétention

Les sauvegardes Git n'incluent pas automatiquement les fichiers ignorés. Le pack WIP complète les bundles : ne pas le remplacer par un simple bundle --all. Les résultats détaillés de restauration 2C restent dans [RAPPORT-PHASE2C.md](RAPPORT-PHASE2C.md).

| Sauvegarde externe sous GeoPlacer-sauvegardes | SHA-256 | Preuve |
|---|---|---|
| 2026-11-16-phase2c-avant-transport / GeoPlacer-avant-phase2c.bundle | `5fb955cf3d1dc1f14ec15495b9b1f2011476206bc1e4b6a84d4949ff5eba14f4` | Restaurée en 2C |
| 2026-11-17-phase2c-final / GeoPlacer-phase2c-final.bundle | `bd8289a9a733cd340a56d5a2d14d12057e26ff9b9545ae1c8a13c4fdc1496b64` | Restauration Git indépendante, quatre WIP, 433 fichiers privés vérifiés en 2C |
| 2026-11-17-avant-phase2d / GeoPlacer-avant-phase2d.bundle | `093f08f73f06a58be4489f7379b5b9d335d5f8ef04a5fef8935553d6cb3ea8fb` | Toutes références identiques après restauration miroir, fsck 0, aucun alternates ; avant modification applicative 2D |


Pack externe `wip-objects/all-objects-before-phase2b.pack` : SHA-256 `5847a9dd2e2c91c44852e100f3cc953b71a5297a81936333e246c27325afb939`. Quatre WIP conservés : `938fe05710b2ed300cb6ef2bd7911c9964fda8cf`, `745de607b7f8dd041f665af2db326b292a32ebce`, `52f32f4b7011631ae809342b4e34219713c5223f`, `1eb4d4ebafac7709cc4cb592d39f12286547cd80`. L'utilitaire de récupération et les manifestes sont externes et privés ; les références de récupération sont créées uniquement dans une destination neuve de restauration.

Conserver les jalons avant réécriture, avant 2A, 2C validée et le dernier état avant nettoyage. Pour les données, conserver trois sauvegardes récentes et trois mensuelles, sans entamer une rotation pendant cette phase. Inclure configuration, modèles, journaux, checkpoints, simulateur et `connector-observations.json`. Les capacités de canal ne sont pas restaurées. Garder une copie sur un autre support physique et vérifier une restauration avant toute suppression. Aucun GC/prune, nettoyage forcé ou réécriture requis.

## 4. Dossiers : inventaire historique et vérification actualisée

L'inventaire détaillé suivant est conservé du **16 novembre 2026 (2B)** ; les tailles de GeoPlacer, sauvegardes et dépendances ne sont pas des mesures courantes du 17. La vérification SHA-256 actuelle porte sur les deux dossiers candidats et leurs copies, pas sur une reconstruction de l'audit.


Tailles **logiques** au relevé initial, pas l'allocation NTFS ; les jonctions ne sont pas additionnées deux fois. Les preuves et tests de cette phase augmentent ensuite GeoPlacer. Inventaire : `dossiers-initial.json`, `historical-folders-files.json`, `ignored-data-files.json`, `nested-repositories.json`, `complements.json` dans les journaux locaux de phase.

| Dossier | Octets / fichiers | Nature et état | Recommandation |
|---|---:|---|---|
| GeoPlacer | 433 158 320 / 31 138 | dépôt principal ; propre à c658dd2 avant phase ; seul worktree | Conserver actif ; sauvegarder aussi données/config ignorées |
| GeoPlacer-Audit | 431 468 346 / 29 005 | rapports, preuves, snapshots et quatre clones ; pas de Git à la racine | Conserver séparé, ne pas reconstruire l'audit |
| GeoPlacer-phase0 | 531 897 / 18 | rapports, logs, copies de lockfiles ; aucun Git/worktree | Copies vérifiées en 2C/2D ; original conservé |
| GeoPlacer-phase1a | 99 498 / 32 | rapports, logs et anciens scripts de vérification ; aucun Git/worktree | Copies vérifiées en 2C/2D ; scripts inertes |
| GeoPlacer-sauvegardes | 15 065 200 / 10 | trois bundles et manifestes/journaux | Conserver externe ; sauvegardes 2C/2D ajoutées avec accord |
| GhostPixelBot-FR | 39 434 600 / 1 775 | dépôt indépendant GPL, propre, branche feat/i18n-french, HEAD 505348f028f20efa11b1c34b7b419ba3cd45c3f7 | Conserver actif et indépendant ; aucune modification |

### Données uniques et dépendances

- **GeoPlacer** : `.env` 235 octets, `.vscode/settings.json`, `data/settings.json` et copies `.bak`, `data/engine/` (3 681 814 octets), journaux, archives `release/` et `test-logs/` ignorés. Les fichiers users/templates hérités contiennent ici des objets/listes vides, mais le dossier engine contient des modèles et états utiles : ne pas déduire « aucune donnée » de ces deux petits fichiers. Sauvegarder à froid les données complètes. Quatre liens `node_modules/@geoplacer/*` ciblent les packages **à l'intérieur** de GeoPlacer, sans dépendance aux anciens dossiers de phases.
- **Phase0** : `RAPPORT-PHASE0.md`, `logs/`, `lockfiles/` ; 17/18 fichiers n'ont pas d'équivalent identique dans l'arbre suivi courant et 16/18 ne sont pas retrouvés comme blobs dans l'histoire accessible de Phase 2A. Les lockfiles sont des copies historiques de package-lock, pas des verrous actifs. Leurs empreintes sont conservées dans le manifeste original. Un bundle Git ne suffit pas à sauvegarder ce dossier.
- **Phase1a** : `RAPPORT-PHASE1A.md`, `AUDIT-ENV.md`, `COMMITS.txt`, recette, logs et scripts atomic/crash/smoke/security. 32/32 fichiers absents à l'identique de l'arbre courant, 31/32 absents des blobs historiques accessibles. Certains scripts visent explicitement les anciens chemins GeoPlacer/GeoPlacer-phase1a et un ancien scratchpad temporaire. Un déplacement exigera de conserver ces scripts comme preuves inertes ; ne pas les relancer sans révision. Aucune dépendance applicative actuelle envers eux n'a été trouvée dans les chemins examinés.
- **Audit** : `sources/` représente 428 363 273 octets ; présence de dépendances volumineuses et d'un snapshot Phase1C0 sans `.git`. Les clones : library `c3224ca90440ceb3cd4583cb3341486190f3c51e`, plusplus `880cd6cbd94c1ad609b34ac957b5b60f0507ad7d`, nymtuta `218ccdd1c511e59fcfc56202444491deb9d80f76`, wplacer `46877e1`. **La bibliothèque possède une modification préexistante de `dist/geopixelcons-library.js`**, 2 324 683 octets, SHA-256 `f9cc02c62d4ef1abe9f2ca903d0f1d0ac1ecbf6417f017207da188bf0a2a9823`. Les autres clones sont propres. Préserver cette différence avec les rapports, captures, preuves et scripts ; ne pas la perdre par restauration du clone.
- **GhostPixelBot-FR** : origin Daneisra/GeoPixelsBot, upstream Dax233/GeoPixelsBot ; node_modules et résultats de tests ignorés. L'historique de traduction et les captures lui appartiennent. Le dossier n'est pas un worktree de GeoPlacer.
- Déplacer les deux petits dossiers de phases ne libérerait qu'environ **0,6 Mo** ; l'intérêt est le rangement. Les dépendances constituent l'essentiel du volume. Leur suppression/reconstruction n'est pas autorisée ici et ne vaut pas preuve de sauvegarde des fichiers non suivis.



### Vérification du 17 novembre et retrait des deux originaux

Les copies existent dans Archives-Projets depuis 2C. Les 50 fichiers cachés ou visibles, leurs tailles et tous leurs SHA-256 correspondent toujours aux originaux. Liens et jonctions refusés ; aucun ancien script exécuté. Manifestes conservés à côté des copies :

| Dossier | Fichiers | Octets | SHA-256 du manifeste |
|---|---:|---:|---|
| GeoPlacer-phase0 | 18 | 531897 | `20b731a9e61cc196cce6d1399c1e8655f422bb0d76a880ecd03d3c3d212cbe60` |
| GeoPlacer-phase1a | 32 | 99498 | `89ad475b700f2d1966f9969c40abd3d5ce073a3a2bdcd3634729aaf599f9c14d` |

Seuls `D:\Téléchargements\Code\GeoPlacer-phase0` et `D:\Téléchargements\Code\GeoPlacer-phase1a` sont proposés à retrait ultérieur, avec accord explicite. Ne pas déplacer ou supprimer GeoPlacer, Audit, GhostPixelBot-FR, sauvegardes ou copies d'archives. Le gain est environ 0,6 Mo.

Avant retrait : choisir un autre disque physique, copier les deux archives ET leurs manifestes, les bundles, pack WIP, notices et données privées nécessaires ; comparer tous les fichiers au SHA-256, puis restaurer un bundle et les données dans une destination neuve. Une autre partition du même disque ne couvre pas sa perte. Exemple de contrôle du support, **sans supposer que E: existe** :

```powershell
# E: est un exemple à remplacer par le support réellement choisi.
$disqueProjet = Get-Partition -DriveLetter D | Get-Disk
$disqueSauvegarde = Get-Partition -DriveLetter E | Get-Disk
if ($disqueProjet.UniqueId -eq $disqueSauvegarde.UniqueId) { throw 'Même support physique : choisir un autre disque' }
# Copier vers un dossier neuf, refuser toute destination existante et les jonctions.
# Vérifier fichiers, tailles et SHA-256 après copie ET après restauration.
```

Les scripts historiques peuvent contenir des anciens chemins : les conserver comme preuves inertes. Les fichiers de sauvegarde sont privés et ne doivent pas être publiés sur GitHub.

Après validation de la copie sur autre support, réexaminer chaque chemin résolu et la présence des manifestes, puis demander l'accord précis de retrait. Prévisualisation seulement :

```powershell
$racineCode = (Resolve-Path -LiteralPath 'D:\Téléchargements\Code').Path
$ancienPhase0 = (Resolve-Path -LiteralPath 'D:\Téléchargements\Code\GeoPlacer-phase0').Path
$ancienPhase1a = (Resolve-Path -LiteralPath 'D:\Téléchargements\Code\GeoPlacer-phase1a').Path
if ($ancienPhase0 -ne (Join-Path $racineCode 'GeoPlacer-phase0')) { throw 'Chemin phase0 inattendu' }
if ($ancienPhase1a -ne (Join-Path $racineCode 'GeoPlacer-phase1a')) { throw 'Chemin phase1a inattendu' }
if ((Get-Item -LiteralPath $ancienPhase0 -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Lien à examiner' }
if ((Get-Item -LiteralPath $ancienPhase1a -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Lien à examiner' }
# Recontrôler aussi les descendants et les SHA-256 immédiatement avant le retrait.
Remove-Item -LiteralPath $ancienPhase0 -Recurse -WhatIf
Remove-Item -LiteralPath $ancienPhase1a -Recurse -WhatIf
```

Ces commandes ne sont pas exécutées ici. Retirer -WhatIf serait une action destructive nécessitant une nouvelle autorisation après lecture des preuves ; aucune commande de retrait réelle n'est préparée pour exécution automatique.

## 5. Organisation cible et décisions requises

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

Les deux originaux subsistent aujourd'hui en plus de cette arborescence. Les branches 2D et les commits documentaires sont locaux seulement. Autorisations encore nécessaires : copie sur un autre support choisi, retrait des deux originaux nommés, suppressions locales/distance des branches nommées, tags d'archive éventuels, promotion et push de main, modifications GitHub de protection/CI, toute publication 2D. Aucune de ces actions ne résulte automatiquement du push 2C autorisé.

Avant et après toute intervention future : status, refs et SHA, remotes, worktrees, fsck ; restauration réelle indépendante ; installation, import/export, modèle et simulation. Conserver les manifestes et journaux avec les sauvegardes. Arrêter sur toute divergence au lieu de forcer.
