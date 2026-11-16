# Version candidate de démonstration (Phase 1C.0)

Ce document prépare la **première version de démonstration** de GeoPlacer.
Rien n'est publié : ni tag Git, ni fusion dans `main`, ni release GitHub
sans validation explicite.

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

Proposition : **`6.0.0-rc.1`** (tag `v6.0.0-rc.1`), intitulée « GeoPlacer V1
— démonstration (simulation locale) ». « V1 » désigne le périmètre fonctionnel
de GeoPlacer ; le numéro de version continue celui du paquet. Les paquets
internes `@geoplacer/*` restent à `0.0.0` (privés, jamais publiés).

Alternative écartée : `1.0.0-rc.1`, plus parlante pour « GeoPlacer V1 »,
mais incohérente avec la version `5.6.2` déjà déclarée par le même paquet.
Elle supposerait de renommer le paquet (`wplacer` → `geoplacer`), un
changement à décider à part.

À la publication seulement (après validation) : `package.json` passe à
`6.0.0-rc.1` et `docs/CHANGELOG.md` reçoit l'entrée correspondante (§ 9).

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

1. État Git propre ; commit final identifié.
2. `git fetch` ; `origin` pointe vers le fork ; `upstream` sans push.
3. Recherche de secrets et de données personnelles dans les commits publiés.
4. Licence, attributions, `MODIFICATIONS.md` à jour.
5. `npm run check:logged` et `npm run build` verts.
6. Installation sur clone neuf (cache npm vide) ; `start.bat`, `npm start`,
   `npm run demo`.
7. Recettes Edge et Firefox (Playwright) ; recette d'arrêt Windows ; Ctrl+C
   au clavier par l'utilisateur.
8. Version `6.0.0-rc.1` dans `package.json` et entrée du `CHANGELOG`.
9. Push de la branche, revue, fusion dans `main` (validation).
10. Tag annoté `v6.0.0-rc.1` sur le commit fusionné, puis release GitHub
    marquée « pré-version » (validation).

## 9. Notes de release GitHub proposées

Voir [notes-release-6.0.0-rc.1.md](notes-release-6.0.0-rc.1.md).

## 10. Commandes de publication (après validation seulement)

```powershell
# 1. Version
npm version 6.0.0-rc.1 --no-git-tag-version
#    (puis ajouter l'entrée 6.0.0-rc.1 en tête de docs/CHANGELOG.md)
git add package.json package-lock.json docs/CHANGELOG.md
git commit -m "chore(version): 6.0.0-rc.1"

# 2. Contrôles
npm run check:logged
npm run build

# 3. Branche (push à blanc, puis réel)
git push --dry-run -u origin feat/phase1c0-release-candidate
git push -u origin feat/phase1c0-release-candidate

# 4. Fusion dans main par une pull request (revue), puis, sur main à jour :
git switch main
git pull --ff-only origin main
git tag -a v6.0.0-rc.1 -m "GeoPlacer 6.0.0-rc.1 : V1 de démonstration (simulation locale)"
git push origin v6.0.0-rc.1

# 5. Release GitHub (pré-version), avec les notes préparées
gh release create v6.0.0-rc.1 --prerelease --title "GeoPlacer 6.0.0-rc.1 — V1 de démonstration" --notes-file docs/fr/notes-release-6.0.0-rc.1.md
```

Remarque : la branche `main` du fork suit aujourd'hui `upstream/main`
(configuration locale). Avant la fusion, décider si `main` devient la
branche de GeoPlacer.
