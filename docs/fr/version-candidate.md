# Version candidate de démonstration (Phase 1C.0)

Ce document prépare la **première version de démonstration** de GeoPlacer.
Rien n'est publié : ni tag Git, ni fusion dans `main`, ni release GitHub
sans validation explicite.

**État (branche locale `release/6.0.0-rc.1`, créée depuis `c57e478`)** :
- version **validée** : `6.0.0-rc.1` ;
- `package.json` et `package-lock.json` passés à `6.0.0-rc.1` (commit
  `0bd64f6`, `npm version --no-git-tag-version`) ; la bannière, le journal et
  la documentation Swagger du serveur lisent la version dans `package.json` ;
  `docs/CHANGELOG.md` a son entrée (« non publiée ») ;
- inchangés volontairement : l'extension héritée `LOAD_UNPACKED` (désactivée)
  et la documentation anglaise d'origine (`docs/api.md`, `architecture.md`,
  `development.md`, `CONTRIBUTING.md`), qui décrivent wplacer 5.6.2 ; les
  paquets internes privés restent à `0.0.0` ;
- artefact de distribution reproductible : § 8 bis.

## 1. Proposition de version : `6.0.0-rc.1`

Versions déclarées dans le dépôt (examinées) :

| Où | Version |
|---|---|
| `package.json` (racine, nom `wplacer`) | `5.6.2` |
| `LOAD_UNPACKED/manifest.json` (extension héritée, désactivée) | `5.6.2` |
| `docs/CHANGELOG.md` (projet d'origine, SemVer et « Keep a Changelog ») | dernière entrée `5.6.2` |
| `src/server.ts` (documentation Swagger héritée) | `5.6.2` |
| Paquets `@geoplacer/*` (privés, non publiés) et `frontend` | `0.0.0` |
| Tags Git | aucun |

Raisonnement :
- le dépôt suit **SemVer** depuis le projet d'origine (`5.6.2`) ; repartir à
  `1.0.0` ferait reculer le numéro du même paquet, ce que SemVer ne permet
  pas de comparer ;
- les changements de GeoPlacer **rompent la compatibilité** avec wplacer
  (comptes, extension, ancien moteur, proxys désactivés ; nouvelle API
  `/api/v1`) : selon SemVer, c'est une **version majeure** ;
- c'est une **version candidate** destinée à des testeurs : suffixe de
  pré-version `-rc.1`.

Proposition **validée** : **`6.0.0-rc.1`** (tag `v6.0.0-rc.1`), intitulée « GeoPlacer V1
— démonstration (simulation locale) ». « V1 » désigne le périmètre fonctionnel
de GeoPlacer ; le numéro de version continue celui du paquet. Les paquets
internes `@geoplacer/*` restent à `0.0.0` (privés, jamais publiés).

Alternative écartée : `1.0.0-rc.1`, plus parlante pour « GeoPlacer V1 »,
mais incohérente avec la version `5.6.2` déjà déclarée par le même paquet.
Elle supposerait de renommer le paquet (`wplacer` → `geoplacer`), un
changement à décider à part.

Fait sur la branche `release/6.0.0-rc.1` (non publiée) : voir l'état en tête.

## 2. Fonctionnalités réellement opérationnelles

Vérifiées par des tests automatisés et des recettes réellement exécutées :

- **Installation Windows en une commande** (`npm run setup:windows`,
  `setup.bat`, `start.bat`), sur clone neuf et cache npm vide ; reprise d'une
  installation interrompue ; recompilation seule après une mise à jour du
  code ; empreinte du binaire `canvas` vérifiée.
- **Tableau de bord** : simulation pilotée dans le navigateur, état en
  direct (WebSocket), progression, toile, tentatives, ressources.
- **Modèles** : import PNG (8 Mio, jusqu'à 4096 × 4096), position,
  8 stratégies, déplacement pendant la simulation (nouvelle révision).
- **Moteur mono-agent** sur toile simulée : énergie, régénération,
  couleurs, améliorations simulées sur confirmation, pause, reprise, arrêt,
  modifications extérieures détectées et repeintes.
- **Reprise** après arrêt (Ctrl+C) ou arrêt brutal du processus, sans
  dépense double ni pixel peint deux fois.
- **Démonstration** intégrée (modèle original, dossier séparé).
- **Sauvegarde et restauration** vérifiées (empreintes, reprise d'une
  restauration interrompue, démonstration et projet jamais mélangés par
  accident).
- **Grands modèles** affichés en entier jusqu'à 4096², zoom et déplacement ;
  serveur **réactif** pendant le calcul (Phase 1C.0).
- **Interface en français**.
- **Isolation** : aucune fonction héritée de connexion à un service réel
  n'est utilisable ; écoute locale ; contrôles Host, Origin et CORS.

## 3. Changelog synthétique (depuis wplacer 5.6.2)

- Phase 1A : fondation et sécurité du serveur local (écoute locale, Host,
  Origin, limiteur, validation, écritures atomiques).
- Phases 1B.0 à 1B.8 : nouveau moteur (géométrie et couleurs, modèles et
  révisions, stratégies, progression et ETA, ressources, planification,
  journal des tentatives, simulateur, ordonnanceur mono-agent).
- Phase 1B.9 : serveur `/api/v1`, WebSocket, toile simulée durable,
  tableau de bord.
- Phase 1B.10 : isolation du code hérité, installation en une commande,
  sauvegarde et restauration, interface en français, démonstration, grands
  modèles, progression incrémentale.
- Phase 1C.0 : ordonnanceur coopératif (le serveur reste réactif sur les
  grands modèles), installation fiabilisée (Node.js dans un chemin avec
  espaces, installation interrompue, intégrité de `canvas`), scénarios de
  sauvegarde réalistes, sécurité de la démonstration, documentation.

Détail : [MODIFICATIONS.md](../../MODIFICATIONS.md).

## 4. Procédure d'installation

Voir [installation-windows.md](installation-windows.md) ; en bref :
Node.js 22 LTS, puis `npm run setup:windows` (ou `setup.bat`), puis
`start.bat`.

## 5. Plateformes vérifiées

| Élément | Vérifié | Non vérifié |
|---|---|---|
| Système | Windows 10 Pro 64 bits (19045) | Windows 11, Linux, macOS |
| Node.js | 22.23.2 (npm 10.9.8) | autres versions 22.x ; 23 et plus |
| Navigateurs | Edge (Chromium) ; Firefox 132 fourni par Playwright | Firefox officiel installé, Chrome, Safari |
| Arrêt | événement Ctrl+C de Windows envoyé à la console | frappe physique de Ctrl+C (à faire, voir [recette-navigateur.md](recette-navigateur.md)) |

## 6. Limites connues

Voir [problemes-connus.md](problemes-connus.md). Principales : simulation
locale uniquement, un seul agent, Windows seulement vérifié, coupure de
courant non garantie, compatibilité des navigateurs limitée aux recettes
exécutées.

## 7. Risques résiduels

- **Tenue après une coupure de courant** : écritures synchronisées (fsync)
  mais jamais testée.
- **Coût CPU du planificateur** : il reclasse tout le modèle à chaque cycle ;
  sur 4096², environ 2 000 pixels par seconde au calme. Le serveur reste
  réactif (calcul découpé), mais le débit ne s'améliorera qu'avec un
  planificateur à état (proposé pour une phase ultérieure).
- **Délais intermittents** de certains tests sous forte charge : causes
  démontrées et supposées dans [qualite.md](qualite.md).
- **Code hérité** présent dans le dépôt (neutralisé) : surface de code à
  retirer plus tard.
- **Dépendances** : vulnérabilités npm modérées de l'outillage de
  développement (voir [securite.md](securite.md)).

## 8. Checklist de publication

Fait (branche `release/6.0.0-rc.1`, locale) :
- [x] Version `6.0.0-rc.1` dans `package.json`, `package-lock.json`,
      `CHANGELOG` ; le serveur affiche cette version.
- [x] Archive de distribution reproductible, empreinte, manifeste, installation
      vérifiée depuis l'archive (§ 8 bis).
- [x] Notes de release en français (§ 9).
- [x] Contrôles complets et clone neuf (voir le rapport de la phase).

Reste à faire, **avec validation** :
1. Ctrl+C au clavier par l'utilisateur ([recette-navigateur.md](recette-navigateur.md)) :
   condition de validation avant la publication officielle.
2. Décider la branche de publication (§ 11) ; recommandé : avancer `main`.
3. Pousser `release/6.0.0-rc.1` (push à blanc, puis réel ; SHA vérifié).
4. Refaire l'archive **au commit publié** avec le script (§ 8 bis) et
   comparer son empreinte à celle annoncée.
5. Fusion (avance rapide) dans `main`, tag annoté `v6.0.0-rc.1` sur ce même
   commit, release GitHub marquée **pré-version**, avec l'archive, son
   `.sha256` et les notes.
6. Après publication : télécharger l'archive depuis GitHub, vérifier son
   empreinte et l'installer sur une machine propre.

## 8 bis. Artefacts : génération reproductible

```powershell
node scripts/build-release-archive.mjs <commit> --verify-install
```

- `git archive` du commit indiqué : seulement les fichiers suivis, fins de
  ligne de `.gitattributes` (`.bat` en CRLF), dates du commit ; construite
  deux fois pour vérifier que le même commit redonne les mêmes octets ;
- contrôle du contenu : fichiers requis (`LICENSE`, `README.md`,
  `MODIFICATIONS.md`, lockfiles, `setup.bat`, `start.bat`, script
  d'installation), chemins interdits absents (`node_modules`, `dist`,
  `data`, `sauvegardes`, `test-logs`, `.env`), `.bat` en CRLF ;
- écrit dans `release\` (ignoré par Git) :
  `geoplacer-<version>-windows-<commit>.zip`, son `.sha256` et un manifeste
  de provenance (commit complet, date, versions de Git et de Node.js,
  taille, nombre de fichiers, contrôles, résultat de l'installation) ;
- `--verify-install` : extraction dans un dossier temporaire neuf (sans Git),
  `start.bat` (installation complète, démarrage de contrôle compris), puis
  `--check` attendu à 0.

C'est une **archive des sources** : l'installation télécharge les dépendances
exactes des lockfiles et le binaire officiel de `canvas`, dont l'empreinte est
vérifiée. Une archive avec `node_modules` serait propre à une plateforme,
plus lourde (plusieurs centaines de Mio) et contiendrait des binaires tiers
non vérifiables par l'utilisateur.

L'archive de la Phase 1C.0 (dossier temporaire, commit `c3fdd7f`) n'est
**pas** une archive officielle ; l'archive de publication sera produite par
ce script au commit publié.

## 9. Notes de release GitHub proposées

Voir [notes-release-6.0.0-rc.1.md](notes-release-6.0.0-rc.1.md).

## 10. Commandes de publication (après validation seulement)

```powershell
# 0. Sur la branche de la version candidate, état propre
git switch release/6.0.0-rc.1
git status
npm run check:logged
npm run build

# 1. Publier la branche (à blanc, puis réel) et vérifier le SHA distant
git push --dry-run -u origin release/6.0.0-rc.1
git push -u origin release/6.0.0-rc.1
git ls-remote --heads origin release/6.0.0-rc.1

# 2. main de GeoPlacer : avance rapide (aucune réécriture ; main = 46877e1 est un ancêtre)
git switch main
git merge --ff-only release/6.0.0-rc.1
git push --dry-run origin main
git push origin main
#    (main suit aujourd'hui upstream/main en local : git branch -u origin/main main)

# 3. Archive au commit publié, et son empreinte
node scripts/build-release-archive.mjs main --verify-install

# 4. Tag annoté sur ce commit, puis release pré-version avec l'archive
git tag -a v6.0.0-rc.1 -m "GeoPlacer 6.0.0-rc.1 : V1 de démonstration (simulation locale)"
git push origin v6.0.0-rc.1
gh release create v6.0.0-rc.1 --prerelease --title "GeoPlacer 6.0.0-rc.1 — V1 de démonstration" --notes-file docs/fr/notes-release-6.0.0-rc.1.md release/geoplacer-6.0.0-rc.1-windows-<commit>.zip release/geoplacer-6.0.0-rc.1-windows-<commit>.zip.sha256
```

## 11. Publier depuis une branche autre que `main` : conséquences

Situation : sur GitHub, la branche par défaut du fork est `main`, qui pointe
sur `46877e1` (le code de wplacer, avant GeoPlacer) ; toute l'histoire de
GeoPlacer (148 commits) est sur des branches `feat/*`.

Si la release `v6.0.0-rc.1` est créée sur un commit qui n'est pas dans
`main` :
- **la page du dépôt** (branche par défaut) continue d'afficher le README et
  le code de wplacer : un visiteur ou un testeur qui clone sans préciser de
  branche obtient l'ancien wplacer, avec ses instructions de comptes,
  d'extension et de proxys ;
- **la release elle-même fonctionne** : un tag désigne un commit, l'archive
  et le code source joints sont ceux de ce commit ; le tag le garde
  accessible même si la branche est supprimée plus tard ;
- **les liens relatifs** de la page de release et les comparaisons
  (« N commits to main since this release ») se lisent par rapport à `main`
  et sont trompeurs ;
- **les outils GitHub** (alertes de sécurité des dépendances, recherche de
  code, graphe) portent sur la branche par défaut, donc sur l'ancien code ;
- **les instructions du README** (`git clone`, puis `git checkout` d'une
  branche) restent nécessaires et fragiles.

Options, de la plus recommandée à la moins :
1. **Avancer `main` jusqu'à la version candidate** (`git merge --ff-only`) :
   possible sans réécriture d'historique, puisque `46877e1` est un ancêtre ;
   `main` devient la branche de GeoPlacer ; la release et le README sont
   cohérents. À noter : la branche locale `main` suit `upstream/main`, à
   rediriger vers `origin/main`.
2. **Changer la branche par défaut** sur GitHub vers une branche de
   GeoPlacer (réglage du dépôt, sans toucher à `main`) : moins durable.
3. **Publier depuis la branche** sans rien changer : possible, avec tous les
   inconvénients ci-dessus.

