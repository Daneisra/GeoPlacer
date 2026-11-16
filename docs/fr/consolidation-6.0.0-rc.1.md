# Consolidation GeoPlacer 6.0.0-rc.1 — 16 novembre 2026

## Branches et intégration

Départ propre : feat/geopixels-ghost-export à b8fd851 ; release/6.0.0-rc.1
à 4a62e5d ; phase candidate à c57e478. Les huit commits et leurs ancêtres
ont été contrôlés. La branche **integrate/6.0.0-rc.1-geopixels** est créée
sur release, puis fusionne l’export : commit de fusion **7b6663e**, parents
4a62e5d et b8fd851. Aucun conflit, cherry-pick ou doublon. Main, backup/* et
toutes les branches existantes gardent leurs SHA initiaux.

Commits release conservés : 0bd64f6, d97741b, 68e4e0d, 4a62e5d.
Commits export conservés : bd2e7f2, 6283dbb, 8ee2066, b8fd851.

Commits de consolidation (avant le présent rapport et le dernier ajustement
portable du manifeste ; la référence exacte finale figure dans l’archive) :

```text
7b6663e merge: consolidate release 6.0.0-rc.1 with GeoPixels PNG export
db67b61 feat(palettes): add separate GeoPixels presets and saved custom choice
60482b0 feat(geopixels): validate palette selection and distinguish PNG pixel counts
ceb3c34 chore(identity): present GeoPlacer while retaining Wplacer credits
1fd310c docs(rc): consolidate PNG workflow and user-validated Windows recipes
972ae3a build(rc): verify attribution and retain complete archive installation logs
2ccec26 test(windows): handle accented recipe paths and keep auxiliary consoles hidden
```

## Palettes et provenance

- **28 couleurs fournies par l’utilisateur**, ordre inchangé, blanc #ffffff.
- **30 communautaires**, Manako/Lospec, consultées le 16 novembre 2026 :
  [source](https://lospec.com/palette-list/geopixels-free-colors), alors en
  attente de modération. Ensemble distinct ajoutant #ff9f1c et #ffff00,
  sans fusion silencieuse, sans qualification officielle.
- Palette personnalisée conservée séparément ; couleurs originales de
  l’image si au plus 256 couleurs retenues au seuil alpha.

La page native distingue Base, Active et Full et propose de débloquer des
couleurs supplémentaires. Aucune liste exhaustive initiale officielle ni
palette de compte n’a été certifiée. Aucun accès au compte n’est nécessaire.

## Validation et interface

Codes RGB à six chiffres, casse normalisée, séparateurs espaces/virgules/
points-virgules/lignes, doublons signalés puis dédupliqués en ordre stable.
#fffff et les codes alpha sont refusés explicitement ; palette vide ou plus
de 256 couleurs : préparation bloquée. Noir et blanc sont des couleurs
opaques ordinaires, distinctes du marqueur de transparence du moteur.

Sélecteur, pastilles, liste des codes et copie. Le mode et le texte personnalisé
sont conservés dans le navigateur ; stockage refusé : la session reste utilisable.
Le choix alimente réellement la prochaine quantification. Un modèle déjà
créé garde sa palette effective et son PNG ; aucune migration de stockage.
Les couleurs utilisées et inutilisées portent sur le modèle enregistré.

La quantification OKLab, le TemplateManager, le redimensionnement, le codec
PNG et l’aperçu existants sont réutilisés. Aucun autre moteur de couleurs.
Surface totale, opaques retenus après filtre et transparents sont distingués ;
aucune progression sur la carte réelle n’est inventée.

Identité principale GeoPlacer, monogramme typographique provisoire GP en
SVG local, titre de page et nom npm geoplacer. Aucun logo téléchargé.
Auteurs Wplacer et AGPL-3.0-only conservés. Bannière/Swagger lisent la version
du package : **6.0.0-rc.1**, identique aux deux champs du lockfile racine.

## Tests exécutés

| Contrôle | Résultat |
|---|---|
| npm run check:logged | **735 tests réussis**, 1 optionnel ignoré, code 0 |
| Jest | **170**, 18 suites |
| Vitest | **565** : core 375, adapters 66, engine-service 73, simulator 51 |
| Lint | 0 erreur ; 47 avertissements hérités backend ; paquets/front sans avertissement |
| npm run build | Réussi, code 0 |
| Palettes | 14 tests : ordre 28, distinction 30, invalides/doublons, seuil 256, sélection et persistance |
| PNG | 11 tests de service, dont 595 × 894 et 4096 × 4096, export comparé aux pixels du moteur |
| Transparence | Totale, partielle/seuil, noir/blanc, compteurs séparés |
| Plus de 256 couleurs source | Réduites par le quantificateur existant ; le mode original exige une palette au plus 256 |
| Compatibilité | Importeur exact b8fd851 exécuté sur fixture locale ; modèle rouvert avec palette et PNG identiques |
| Sauvegarde des fantômes | Réouverture et restauration dans un autre dossier, export identique |
| Edge palettes/PNG | 0 échec ; quatre modes, changement réel de quantification, PNG = aperçu = API |
| Firefox Playwright palettes/PNG | Même parcours, 0 échec |
| Edge simulation | Parcours complet jusqu’à 100 %, pause/reprise, modèle 2000², backup/restore, rien repeint |
| Firefox Playwright simulation | Mode rapide : pause/reprise/arrêt, 2000², backup/restore, 0 échec ; fin complète couverte par Edge et tests moteur |
| Requêtes des recettes navigateur | Locales uniquement ; aucun accès automatisé à GeoPixels |

La campagne complète et le build portent sur le code produit du commit
972ae3a. Les commits suivants ajustent uniquement une recette Windows,
la documentation API et le manifeste/rapport : aucun comportement applicatif
n’est changé après cette campagne. L’archive porte sa propre référence finale.

Journaux complets locaux (non inclus dans le ZIP) :
`test-logs/2026-11-16T17-34-33-915Z-check.log`,
`test-logs/2026-11-16T17-41-41-978Z-build.log`, et
`test-logs/consolidation/` (recettes, captures, installation, compatibilité).

## Clone neuf et Windows

Installation en **une commande** avec cache npm séparé, sans dépendances du
développement : réussie, binaire canvas officiel vérifié par SHA-256,
compilation et démarrage de contrôle réussis, --check = 0.
Recette palettes/PNG exécutée dans le clone lui-même : 0 échec.
Start.bat --demo, bannière 6.0.0-rc.1, Swagger et dashboard vérifiés ;
événement console Windows reçu comme SIGINT, arrêt gracieux et port libéré,
progression retrouvée, démonstration terminée, backup vérifié/restauré,
puis redémarrage à completed : réussi.

Le premier essai du lanceur de recette ne produisait pas de journal dans
le chemin accentué Téléchargements : le .cmd auxiliaire UTF-8 n’avait pas
sa page de codes. Correction locale chcp 65001 (aucun réglage Windows global),
console auxiliaire cachée et garde du chemin de monde de test ; recette
complète relancée avec succès. Le journal de l’échec initial est conservé.

L’événement console automatisé **n’est pas une frappe physique**.
L’utilisateur confirme séparément le Ctrl+C réel au clavier Windows du
16 novembre 2026. Les tests automatiques de reprise restent en place.

## Validation réelle GeoPixels fournie par l’utilisateur

PNG 595 × 894 avec 28 couleurs : export, acceptation par l’outil natif,
affichage et positionnement réussis, sans inversion évidente. Validation
utilisateur du 16 novembre 2026, pas un essai de Codex sur le service.
531 930 pixels de surface ; 294 647 opaques retenus ; 237 283 transparents.
Le compteur GeoPixels utilise 531 930 : définitions potentiellement
différentes, aucune conclusion automatique de bug. La fixture locale de
mêmes compteurs est synthétique, pas l’image originale de l’utilisateur.

## Archive candidate et documentation

Générateur réutilisé : scripts/build-release-archive.mjs. Le ZIP est issu
du **commit final identifié**, construit deux fois à l’identique. Fichiers
requis, .bat CRLF, AGPL/attributions, exclusions et recherche de secrets
manifestes sont contrôlés. Aucun node_modules, dist, .env, donnée, sauvegarde
ou journal personnel dans le ZIP ; aucune réécriture de l’histoire.

Chemin déterministe : `release/geoplacer-6.0.0-rc.1-windows-<SHA court>.zip`.
L’empreinte exacte est dans le fichier adjacent **.sha256**, la provenance,
les contrôles et l’installation depuis le ZIP extrait dans **.manifest.json**
(champ installation.ok). Le journal complet **.install.log** reste local.
Ces fichiers et le compte rendu livré donnent le SHA final, évitant un
numéro autoréférent dans le présent document. L’ancienne archive **4a62e5d**
ne représente plus cette candidate. Ne publier aucun ancien ZIP par erreur.

README, CHANGELOG, installation Windows, guide GeoPixels, API,
sauvegarde/restauration, recette navigateur, notes de release et état de
candidate ont été harmonisés. MODIFICATIONS.md conserve l’attribution
et la trace des modifications sous AGPL. Les archives restent ignorées par Git.

## Limites et décisions avant publication

- Rien poussé, fusionné dans main, tagué ou publié. Aucun projet indépendant modifié.
- Préparation et simulation locales ; mono-agent simulé. Pas de comptes,
  cookies/tokens, proxies ou automatisation de placement sur le site.
- Le test réel fourni ne certifie pas toutes les tailles/palettes/formats ;
  aucune observation automatique du compte ou de la carte.
- Windows 11, Firefox officiel installé, Linux/macOS et coupure de courant non certifiés.
- 47 avertissements hérités ; le build du dossier de développement signale
  aussi NODE_ENV=production dans un .env local (Vite), sans échec. Aucun
  fichier .env de l’utilisateur modifié.
- Les journaux bruts de tests/installation peuvent contenir des chemins locaux :
  ils restent locaux et doivent être relus avant tout partage.
- Valider le commit et l’archive, choisir les testeurs et autoriser séparément
  push, éventuelle avance de main, tag et pré-release. Ne pas utiliser main
  historique pour installer cette candidate. Ne pas annoncer de dessin
  automatique ou une palette officielle.
