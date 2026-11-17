# Plan de nettoyage Git et dossiers — actualisation Phase 2E

Relevé du **17 novembre 2026**. Publication 2D confirmée sur origin : `a52ebd2ce9b739fbd1c7e739e0c3be046bfc9af1`. Main est promue et publiée à `cb6521dd1890839ce50f3c0a6cae127451fc71da` : RC `fe392266` plus deux corrections documentaires explicitement approuvées. Elle suit désormais `origin/main`. La Phase 2E reste locale. Aucune suppression, aucun tag ni aucune release.

## 1. Inventaire et preuve de conservation

Relations vérifiées par `git merge-base --is-ancestor` après fetch sans prune. La RC exacte reste référencée par `integrate/6.0.0-rc.1-geopixels`. Les 16 pointes locales candidates et les cinq distantes sont toutes contenues dans **origin/main** et **origin/feat/phase2d-live-observation** ; elles figurent également dans les bundles externes restaurés. L'ancienneté ne suffit pas à autoriser leur retrait.

| Branche | SHA au relevé avant commit documentaire final | Présence | Contenue dans | Action proposée |
|---|---|---|---|---|
| `backup/avant-reecriture-email` | `19d64239e883b8e77a5fefd8e3061a45b0bdd7c8` | Locale | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `feat/geopixels-ghost-export` | `b8fd851a4cedaa8050a98986a2225bd226738e10` | Locale | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `feat/phase1a-fondation` | `19d64239e883b8e77a5fefd8e3061a45b0bdd7c8` | Locale | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `feat/phase1b0-workspace` | `01bad6921522a9b30350e4048a7eb965df5de7e9` | Locale | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `feat/phase1b1-geometry-colors` | `1309f38d97b9cad11bf53c57a17427c7301c8bcc` | Locale | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `feat/phase1b10-demo-hardening` | `6bee19cb0463b17c1b18d7d8c5c9a11e7e560a9e` | Locale | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `feat/phase1b2-template-manager` | `9a686e3ce9ba498043fe59ff7c445ec0bb22fe2a` | Locale | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `feat/phase1b3-drawing-strategies` | `9b55cdea1ea04b697eba833342e8327ab7f54ea9` | Locale | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `feat/phase1b4-progress-eta` | `25c4a64c95a75ea0ce15ec1ce0513c39a5c85074` | Locale | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `feat/phase1b5-resources-upgrades` | `da27c8d3a8ab9bbc3a042a6d6b541fc176e07bd1` | Locale | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `feat/phase1b6-work-planner` | `1988edd267358654a6f4c10569cd1ee391d8be6a` | Locale | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `feat/phase1b7-journal-simulator` | `a6c8adfa488e8e58ad3182355f15caf3ae2be034` | Locale | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `feat/phase1b8-single-agent-scheduler` | `61c3efa7eae16aa648627575c41493bdf2913c30` | Locale | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `feat/phase1b9-server-dashboard` | `5132edee7710b1537de0f30c31f548049eff8e29` | Locale | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `feat/phase1c0-release-candidate` | `c57e4788281a319376c0f4d8699f98c170601ffa` | Locale | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `feat/phase2a-geopixels-provider` | `c658dd2bb58ba79a079d9316507c80c7a9ecaf2a` | Locale | 2D | Conserver |
| `feat/phase2b-reader-validation` | `54add74aca4f1281fcba9f2e698ab7af0dceee91` | Locale | 2D | Conserver |
| `feat/phase2c-connector-transport` | `ea897de4aac0a174ef038733ace29f6c20dcdad0` | Locale | 2D | Conserver |
| `feat/phase2d-live-observation` | `a52ebd2ce9b739fbd1c7e739e0c3be046bfc9af1` | Locale | 2D | Conserver |
| `feat/phase2e-regional-observation` | `03dfa0919662b39552892499ed51b67402812b86` | Locale | 2D | Active locale ; ne pas publier en 2E |
| `integrate/6.0.0-rc.1-geopixels` | `fe392266a0605349f227e005a5e62904903b531f` | Locale | main, RC, 2D | Conserver |
| `main` | `cb6521dd1890839ce50f3c0a6cae127451fc71da` | Locale | main | Conserver |
| `release/6.0.0-rc.1` | `4a62e5d43e69ecf5a7932c13fe11e6153cd47d44` | Locale | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `origin/HEAD` | `cb6521dd1890839ce50f3c0a6cae127451fc71da` | Distante suivie | main | Conserver |
| `origin/feat/phase1b10-demo-hardening` | `6bee19cb0463b17c1b18d7d8c5c9a11e7e560a9e` | Distante suivie | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `origin/feat/phase1b7-journal-simulator` | `a6c8adfa488e8e58ad3182355f15caf3ae2be034` | Distante suivie | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `origin/feat/phase1b8-single-agent-scheduler` | `61c3efa7eae16aa648627575c41493bdf2913c30` | Distante suivie | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `origin/feat/phase1b9-server-dashboard` | `5132edee7710b1537de0f30c31f548049eff8e29` | Distante suivie | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `origin/feat/phase1c0-release-candidate` | `c57e4788281a319376c0f4d8699f98c170601ffa` | Distante suivie | main, RC, 2D | Candidate après accord explicite, SHA à revérifier |
| `origin/feat/phase2c-connector-transport` | `ea897de4aac0a174ef038733ace29f6c20dcdad0` | Distante suivie | 2D | Conserver |
| `origin/feat/phase2d-live-observation` | `a52ebd2ce9b739fbd1c7e739e0c3be046bfc9af1` | Distante suivie | 2D | Conserver |
| `origin/main` | `cb6521dd1890839ce50f3c0a6cae127451fc71da` | Distante suivie | main | Conserver |
| `upstream/HEAD` | `46877e120f9e7bc721084fdf88a9ae8f006cb117` | Distante suivie | main, RC, 2D | Conserver |
| `upstream/main` | `46877e120f9e7bc721084fdf88a9ae8f006cb117` | Distante suivie | main, RC, 2D | Conserver |

**Candidates locales nominatives (16)**

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

**Candidates distantes nominatives (5)**

- `origin/feat/phase1b10-demo-hardening` — `6bee19cb0463b17c1b18d7d8c5c9a11e7e560a9e`.
- `origin/feat/phase1b7-journal-simulator` — `a6c8adfa488e8e58ad3182355f15caf3ae2be034`.
- `origin/feat/phase1b8-single-agent-scheduler` — `61c3efa7eae16aa648627575c41493bdf2913c30`.
- `origin/feat/phase1b9-server-dashboard` — `5132edee7710b1537de0f30c31f548049eff8e29`.
- `origin/feat/phase1c0-release-candidate` — `c57e4788281a319376c0f4d8699f98c170601ffa`.

Conserver main, la RC exacte, 2C et 2D publiées, 2A/2B comme références récentes, la branche active 2E et les références internes de récupération. Aucun ancien commit n'est réécrit. Les quatre WIP restent dans leur pack externe : ils ne sont pas implicitement couverts par un bundle `--all`.

Deux worktrees : le dossier de développement sur 2E et le worktree propre de promotion de main dans Temp (`%TEMP%/gp-phase2e-main-promotion-…/GeoPlacer-main`). Celui-ci ne contient aucune donnée applicative ; il a ensuite été détaché à cb6521dd pour libérer main, sans supprimer ses fichiers. Les clones de restauration sont autonomes, sans alternates.

Contrôle GitHub au relevé : collections de PR ouvertes **et fermées** vides pour Daneisra/GeoPlacer et Arknight38/wplacer-dev. Les liens vers les SHA restent stables ; supprimer une branche casse ses liens `/tree/<branche>`. Les références dans les documents suivis ont été inventoriées (`test-logs/phase2e/historical-links.json`) ; les favoris et liens externes ne peuvent pas être garantis exhaustivement. Refaire ces vérifications juste avant toute suppression.

### Commandes futures, uniquement après autorisation nominative

Aucune commande de suppression ci-dessous n'a été exécutée. Arrêter les serveurs, vérifier l'arbre propre et sauvegarder aussi les données ignorées avant l'intervention.

```powershell
git fetch --no-prune origin
git status --porcelain=v1
git worktree list --porcelain
git fsck --full
git bundle verify '<bundle-externe-verifie>'
$brancheHistorique = 'feat/phase1b0-workspace'
$shaHistorique = '01bad6921522a9b30350e4048a7eb965df5de7e9'
if ((git rev-parse $brancheHistorique) -ne $shaHistorique) { throw 'Pointe modifiée' }
git merge-base --is-ancestor $shaHistorique origin/main
if ($LASTEXITCODE -ne 0) { throw 'Commit absent de main publié' }
git merge-base --is-ancestor $shaHistorique origin/feat/phase2d-live-observation
if ($LASTEXITCODE -ne 0) { throw 'Commit absent de 2D publiée' }
# Uniquement après accord sur cette branche précise :
git branch -d $brancheHistorique
# Si -d refuse : arrêter, aucun -D, aucun forçage.
```

Pour chaque candidate distante du tableau, vérifier son SHA par `git ls-remote origin refs/heads/<branche>` et son accessibilité depuis main/2D publiées, puis réexaminer PR/liens. Exemple uniquement après autorisation spécifique :

```powershell
$brancheDistante = 'feat/phase1b7-journal-simulator'
$shaAttendu = 'a6c8adfa488e8e58ad3182355f15caf3ae2be034'
$ligne = git ls-remote origin "refs/heads/$brancheDistante"
if (($ligne -split '\s+')[0] -ne $shaAttendu) { throw 'Pointe distante modifiée' }
git push --dry-run origin --delete $brancheDistante
# Après nouvelle validation du résultat :
git push origin --delete $brancheDistante
```

Pas de `--force`, `gc`, `prune`, `clean -fd`, `reset --hard`, ni suppression de références internes. Appliquer le contrôle SHA séparément à chaque ligne nominative, pas à une liste reconstruite de branches « anciennes ».

## 2. Main : promotion effectuée

Main est passée de `46877e120f9e7bc721084fdf88a9ae8f006cb117` à la RC `fe392266a0605349f227e005a5e62904903b531f` puis au commit documentaire `cb6521dd1890839ce50f3c0a6cae127451fc71da`, par une seule avance rapide contrôlée. L'écart au SHA RC initial a été demandé explicitement parce que README/installation décrivaient encore main comme Wplacer ; l'utilisateur a approuvé le nouveau SHA avant publication. Aucun code 2A–2E n'est présent sur main.

La RC a réussi ses **735 tests**, un facultatif ignoré, son build et son installation autonome. Le commit suivant change uniquement README.md et docs/fr/installation-windows.md. Serveurs arrêtés, worktree main propre, bundle documentaire restauré, push à blanc puis push normal ; SHA distant égal. Le suivi main → origin/main est corrigé. Aucun `pull` sur main, aucun push upstream.

Métadonnées GitHub examinées : branche non protégée, collection de rulesets vide ; aucun contournement. Pour la suite, proposer une PR obligatoire, au moins une revue et les checks CI avant fusion, avec protection contre force-push/suppression. Ces réglages n'ont pas été modifiés et requièrent un accord distinct. Le lien de fork et l'historique d'origine restent conservés ; les forks ne sont pas avancés automatiquement. Maintenir AGPL-3.0-only, LICENSE, MODIFICATIONS et les crédits JinxTheCatto/luluwaffless/Arknight38/contributeurs.

L'ancien `.env` était déjà dans main historique et ne contient que HOST/NODE_ENV/ports publics et commentaires ; il est absent de la RC. Contrôle des 163 commits accessibles supplémentaires : 1 140 blobs, aucun secret à forte confiance détecté. Ce contrôle ne constitue pas une preuve universelle d'absence de secret.

L'archive RC `fe39226` reste épinglée à son contenu, avec son empreinte d'origine. Aucun tag, release ou nouvel artefact public n'a été créé.

## 3. Sauvegardes vérifiées et rétention

Les sauvegardes Git et celles des données sont distinctes. Les nouveaux bundles externes sous `GeoPlacer-sauvegardes` :

| Sous-dossier / fichier | SHA-256 | Vérification |
|---|---|---|
| `2026-11-17-phase2d-publication/GeoPlacer-phase2d-publication.bundle` | `fb0b819a6c4878f03d50c9650866cf31d72f814069dd6ef99ced3a862ef8b68a` | Bundle vérifié, restauration autonome et fsck 0 ; aucun alternates |
| `2026-11-17-avant-phase2e/GeoPlacer-avant-phase2e.bundle` | `8379ebff4e21709f1a0dc3f7b88b8b599d47da68d8cf35eef579f0b1b1e4c524` | Bundle vérifié, restauration autonome et fsck 0 ; aucun alternates |
| `2026-11-17-main-rc-documentation/GeoPlacer-main-rc-documentation.bundle` | `f56a0831b6d502150acf0b872cbfde638a34416432bacb07d597a270812aa0e4` | Bundle vérifié, restauration autonome et fsck 0 ; aucun alternates |

Sauvegardes antérieures conservées, non recréées pendant 2E :


Les sauvegardes Git ne couvrent pas les données ignorées. Le pack WIP complète les bundles : ne pas le remplacer par un simple bundle --all. Les résultats détaillés de restauration 2C restent dans [RAPPORT-PHASE2C.md](RAPPORT-PHASE2C.md).

| Sauvegarde externe sous GeoPlacer-sauvegardes | SHA-256 | Preuve |
|---|---|---|
| 2026-11-16-phase2c-avant-transport / GeoPlacer-avant-phase2c.bundle | `5fb955cf3d1dc1f14ec15495b9b1f2011476206bc1e4b6a84d4949ff5eba14f4` | Restaurée en 2C |
| 2026-11-17-phase2c-final / GeoPlacer-phase2c-final.bundle | `bd8289a9a733cd340a56d5a2d14d12057e26ff9b9545ae1c8a13c4fdc1496b64` | Restauration Git indépendante, quatre WIP, 433 fichiers privés vérifiés en 2C |
| 2026-11-17-avant-phase2d / GeoPlacer-avant-phase2d.bundle | `093f08f73f06a58be4489f7379b5b9d335d5f8ef04a5fef8935553d6cb3ea8fb` | Toutes références identiques après restauration miroir, fsck 0, aucun alternates ; avant modification applicative 2D |


Pack externe `wip-objects/all-objects-before-phase2b.pack` : SHA-256 `5847a9dd2e2c91c44852e100f3cc953b71a5297a81936333e246c27325afb939`. Quatre WIP conservés : `938fe05710b2ed300cb6ef2bd7911c9964fda8cf`, `745de607b7f8dd041f665af2db326b292a32ebce`, `52f32f4b7011631ae809342b4e34219713c5223f`, `1eb4d4ebafac7709cc4cb592d39f12286547cd80`. L'utilitaire de récupération et les manifestes sont externes et privés ; les références de récupération sont créées uniquement dans une destination neuve de restauration.

Conserver les jalons avant réécriture, avant 2A, 2C validée et le dernier état avant nettoyage. Pour les données, conserver trois sauvegardes récentes et trois mensuelles, sans entamer une rotation pendant cette phase. Inclure configuration, modèles, journaux, checkpoints, simulateur et `connector-observations.json` et `connector-regions.json`. Les capacités de canal ne sont pas restaurées. Garder une copie sur un autre support physique et vérifier une restauration avant toute suppression. Aucun GC/prune, nettoyage forcé ou réécriture requis.


## 4. Dossiers : inventaire historique et contrôle 2E


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




### Copies revérifiées en 2E

- Phase0 : **18 fichiers, 531 897 octets** ; manifeste `20b731a9e61cc196cce6d1399c1e8655f422bb0d76a880ecd03d3c3d212cbe60`.
- Phase1a : **32 fichiers, 99 498 octets** ; manifeste `89ad475b700f2d1966f9969c40abd3d5ce073a3a2bdcd3634729aaf599f9c14d`.

Tous les fichiers, y compris cachés, correspondent à leurs originaux et au manifeste original : chemin relatif, taille et SHA-256. Aucune jonction ou lien symbolique dans les arbres contrôlés ; aucun ancien script exécuté. Les originaux et Archives-Projets restent intégralement en place.

### Autre support physique : préalable non satisfait

Partition/disque physique vérifiés : **D: → disque 2**, **C: → disque 1**, **E: → disque 0**. E: est donc un autre disque dans cette machine, mais aucune copie durable GeoPlacer n'a été retrouvée dans les emplacements usuels examinés sur E: ou C:. Ce contrôle ne prétend pas inventorier tout leur contenu. Les restaurations dans %TEMP% sur C: sont sur un autre disque mais restent des tests temporaires, pas une politique de sauvegarde durable.

Avant tout retrait, faire choisir et autoriser une destination durable sur un disque indépendant, idéalement déconnectable. Y copier dans un dossier neuf :

1. Les trois nouveaux bundles ci-dessus, leurs SHA256SUMS et preuves de restauration ; puis le dernier bundle 2E après ses commits.
2. L'ensemble critique `2026-11-17-phase2c-final` : données applicatives privées, pack WIP, références/manifeste et utilitaire de récupération, pas seulement le bundle.
3. Les jalons antérieurs conservés selon la rétention, les archives Phase0/Phase1a et leurs manifestes.
4. Une sauvegarde à froid actualisée des données utiles : configuration locale, modèles, journaux, checkpoints, simulateur, historique et configuration des régions. Une capacité de canal ne doit jamais être sauvegardée pour être réactivée.

Contrôler les disques par `Get-Partition`/`Get-Disk`, les chemins absolus, l'absence de jonction, puis comparer nombres de fichiers, tailles et SHA-256. Restaurer dans une destination neuve sur ce support et vérifier Git (y compris les quatre WIP), modèles et données. Préserver les preuves sur le support. Deux partitions d'un même disque ne suffisent pas. Aucune copie vers E: n'a été effectuée sans accord.

### Retrait futur proposé, pas exécuté

Uniquement après copie indépendante et accord nominatif, les deux seuls originaux candidats sont :

- `D:\Téléchargements\Code\GeoPlacer-phase0`.
- `D:\Téléchargements\Code\GeoPlacer-phase1a`.

Prévisualisation PowerShell, après vérification des manifestes et des chemins résolus :

```powershell
$racineCode = [IO.Path]::GetFullPath('D:\Téléchargements\Code')
$cibleHistorique = (Resolve-Path -LiteralPath (Join-Path $racineCode 'GeoPlacer-phase0')).Path
if ($cibleHistorique -ne (Join-Path $racineCode 'GeoPlacer-phase0')) { throw 'Chemin inattendu' }
if ((Get-Item -LiteralPath $cibleHistorique -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Jonction refusée' }
# Revérifier aussi tous les descendants et leurs SHA-256.
Remove-Item -LiteralPath $cibleHistorique -Recurse -WhatIf
# Répéter séparément pour Phase1a ; ne retirer -WhatIf qu'après autorisation.
```

Le contrôle doit rester PowerShell de bout en bout ; aucune interpolation vers cmd/batch pour supprimer. Ne retirer ni GeoPlacer, ni GeoPlacer-Audit, ni GhostPixelBot-FR, ni GeoPlacer-sauvegardes, ni Archives-Projets.

## 5. Organisation cible et décisions restantes

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

Les deux originaux subsistent en plus de cette cible. Restent soumis à votre accord : destination et copie durable sur autre support, retrait des deux originaux, suppression des 16 branches locales et cinq distantes nommées, changements GitHub de protection/CI, publication 2E et tout tag/release. Main et 2D ont déjà été publiées avec les autorisations de cette phase ; ne pas répéter leur promotion.

Avant/après une future intervention : contrôler refs/SHA/worktrees, fsck, restaurations Git/données, installation, import/export, simulateur et lecteur. Arrêter sur toute divergence et conserver les journaux. Ne jamais déduire une autorisation de nettoyage de la réussite de ces vérifications.
