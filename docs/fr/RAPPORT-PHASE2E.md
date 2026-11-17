# Rapport Phase 2E — observations régionales et stabilisation GitHub

Date : **17 novembre 2026**. GeoPlacer **6.0.0-rc.1** ; lecteur **0.4.0**. Branche locale `feat/phase2e-regional-observation`, issue de la 2D validée `a52ebd2ce9b739fbd1c7e739e0c3be046bfc9af1`.

## 1. Résultat et périmètre

La 2D est publiée ; main représente maintenant la démonstration stable de GeoPlacer. La 2E ajoute les observations régionales, leur rotation, des dates par pixel et un calcul de progression coopératif. **925 tests réussis, un facultatif ignoré**, build vert. Les essais automatisés utilisent uniquement des services et pages factices locaux ; aucune écriture ni achat réel. L'utilisateur confirme les captures automatiques des **deux régions sur le véritable GeoPixels**. Il confirme également la recette finale sur le code `03dfa09` : position relative et orientation, pause/expiration, reprise, arrêt et révocation.

Aucun push 2E, tag, release, retrait historique ou réécriture. GhostPixelBot-FR et GeoPlacer-Audit ne sont pas modifiés. L'archive RC `fe39226` est conservée et son empreinte est inchangée ; son README interne précède la promotion, le guide de main est à jour.

## 2. Publications autorisées

### Phase 2D

Branche publiée : [feat/phase2d-live-observation](https://github.com/Daneisra/GeoPlacer/tree/feat/phase2d-live-observation). SHA local et distant : **`a52ebd2ce9b739fbd1c7e739e0c3be046bfc9af1`**.

Les huit commits au-dessus de 2C ont été contrôlés : `7ac914f`, `6f778bc`, `98d1e83`, `506d4a8`, `95cba4b`, `66c1b6b`, `2758d27`, `a52ebd2`. Arbre initial propre, remotes conformes, fetch sans prune, 46 blobs supplémentaires examinés, aucun secret à forte confiance ni clé privée de recette détecté. AGPL-3.0-only et attributions conservées. Le contrôle préalable a réussi ses **892 tests**, un facultatif ignoré, puis le build. Bundle externe vérifié et restauré, push à blanc puis push normal vers origin seulement ; égalité du SHA confirmée.

Journaux locaux : `test-logs/2026-11-17T18-00-04-056Z-check.log`, `2026-11-17T18-05-52-397Z-build.log` et `test-logs/phase2e/prepublication-2d.json`.

### Main stable

Main/origin/main : **`cb6521dd1890839ce50f3c0a6cae127451fc71da`**. Ancêtre applicatif exact : **`fe392266a0605349f227e005a5e62904903b531f`**.

Le SHA initial demandé ne pouvait pas satisfaire simultanément le README et l'installation : ils présentaient encore main comme l'ancien Wplacer. Après préparation d'un correctif de deux fichiers et présentation du SHA, **l'utilisateur a explicitement approuvé cb6521dd**. Ce descendant direct ajoute uniquement README.md et docs/fr/installation-windows.md ; aucun code expérimental n'entre dans main.

La RC a été installée depuis un clone autonome : setup Windows, démarrage/arrêt de contrôle, **735 tests** et un facultatif ignoré, build verts. La promotion s'est déroulée dans un worktree main propre, serveur arrêté, pour préserver le développement 2E séparé. Main distante était toujours `46877e120f9e7bc721084fdf88a9ae8f006cb117` ; l'ancestralité a été vérifiée. Bundle documentaire restauré, avance rapide, suivi **main → origin/main**, push à blanc puis normal, SHA distant égal. Le worktree temporaire a ensuite été détaché au même SHA pour libérer main, sans supprimer ses fichiers. Les métadonnées GitHub indiquaient une branche non protégée et une liste de rulesets vide ; aucune protection n'a été contournée ni modifiée.

L'historique supplémentaire a été examiné : **163 commits, 1 140 blobs**. L'ancien `.env`, déjà présent dans main historique et retiré avant la RC, ne contenait que paramètres publics HOST/NODE_ENV/ports et commentaires. Aucun identifiant trouvé par les contrôles réalisés ; cela ne constitue pas une garantie universelle sur tout secret possible. Les crédits et la relation de fork restent préservés.

Preuves locales : `main-prepublication.json`, `main-promotion.json`, `github-main-rules.json`, `rc-setup.log`, `rc-check.log` dans `test-logs/phase2e/`. Les remotes origin/upstream n'ont pas changé ; aucun push upstream, aucun `pull` sur main.

## 3. Architecture des régions

[regions.ts](../../packages/engine-service/src/geopixels/regions.ts) définit `ImageRegion`, `CaptureRegion`, `parseRegions` et `chooseRegion`. Jusqu'à **16 rectangles**, relatifs à l'image : X droite, Y bas, origine au coin supérieur gauche. Identifiants uniques, noms bornés, entiers et limites de l'image contrôlés ; champs inconnus refusés. La somme des surfaces est limitée à 4096², chevauchements compris dans le budget de travail.

Une région demeure une vue du **même modèle, de la même révision et de la même position**. Aucune image copiée comme nouveau modèle. Sans configuration personnalisée, capture du modèle entier ; toutes régions suspendues entraîne un refus de démarrage, sans balayage complet implicite.

[ObservationMonitor](../../packages/engine-service/src/geopixels/monitor.ts) conserve l'unique service de surveillance : cadence 5–60 s, pause/reprise/arrêt, capture unique, historique limité à 120 points. Rotation équitable par captures terminées : poids principale 3 / secondaire 1. Les régions désactivées sont suspendues, les autres attendent leur tour ; une capture interrompue n'avance pas la rotation. **Aucun second scheduler de peinture**.

[GeoPixelsProvider](../../packages/engine-service/src/geopixels/provider.ts) garde couleurs, date de validité et date de capture par pixel. Les observations conservent l'identité native, le numéro de séquence et le sens Y natif ; les régions ne modifient pas les coordonnées du projet. Une nouvelle identité réelle de projet/position/palette/session ferme le canal et requiert un nouveau couplage, plutôt que réutiliser l'ancienne liaison.

[RegionalProgressCache](../../packages/engine-service/src/geopixels/region-progress.ts) découpe le calcul en **cellules disjointes 256²** et réutilise le [calculateur du core](../../packages/core/src/progress/progress.ts) : `computeProgressWithinBounds`, même classification que `computeProgress`, puis `assembleProgress`. Les fenêtres identiques sont réutilisées pour le global et les régions. Les chevauchements ne sont jamais additionnés au global ; les limites originales du modèle sont conservées. Cellules modifiées/expirées recalculées, cache borné aux fenêtres nécessaires. Le calcul rend la main entre cellules et pendant le comptage initial de transparence ; aucun travail de placement n'est créé.

## 4. Protocole, cohérence et fraîcheur

Le protocole d'enveloppe reste **1**. Le lecteur annonce `readerVersion: 4`, le serveur `regionalProtocol: 1`. Le serveur garde la compatibilité du lecteur 3 pour les captures complètes. `capture.region` ajoute id, X/Y, dimensions et révision de configuration ; les bandes consécutives couvrent la largeur du rectangle choisi, pas obligatoirement le modèle entier. Toute région inconnue/modifiée/suspendue, bande désordonnée, champ inattendu ou dépassement est refusé avant mutation des pixels.

Bandes limitées à **65 536 pixels** et lots HTTP à 768 Kio. Les séquences et accusés existants sont conservés ; une réponse perdue ne confirme rien, un renvoi identique est dédupliqué par séquence et empreinte. La lecture se fait exclusivement dans le cache déjà chargé : aucun chargement de tuile ou appel au service ajouté.

Les contrôles HTTP continuent pendant une capture. Pause/arrêt interrompt le lecteur entre deux bandes acquittées ; `abortedCapture` authentifié invalide seulement l'assemblage incomplet. Les pixels déjà reçus gardent leurs dates, aucun point d'historique complet n'est créé. Une dernière bande déjà reçue peut terminer avant l'arrêt. Une reconnexion n'active jamais automatiquement la surveillance.

Quatre notions restent distinctes :

1. **Réception** : arrivée au serveur local.
2. **Capture** : moment de lecture par le navigateur, propre à chaque bande/pixel.
3. **Source** : date du contenu GeoPixels si réellement disponible ; sinon non datée.
4. **Couverture** : valeurs connues, inconnues et cibles effectivement éligibles.

L'expiration reste **30 secondes par pixel**, sans prolongation par une autre région ou un heartbeat. Une première bande peut expirer avant la fin d'une grande capture. Une reconstruction coopérative qui franchit l'expiration revisite les cellules concernées ; si une lecture cohérente ne peut pas être fournie, la progression reste indisponible et l'interface attend le prochain calcul. Une capture partielle n'est jamais une capture complète. Le global est un assemblage de lectures datées, **pas un instantané atomique** ; les fenêtres de dates de chaque région sont exposées.

Une nouvelle lecture peut confirmer le contenu actuel du cache navigateur tout en laissant son ancienneté côté service inconnue. Relire la même tuile n'est jamais présenté comme une synchronisation du serveur GeoPixels. Transparent observé ≠ tuile absente : le premier est connu, la seconde reste inconnue. Les transparents du modèle sont exclus des cibles ; 40 valeurs lues pour la fixture 8×5 correspondent à 38 cibles.

## 5. Optimisation du décodage et sécurité

[geopixels-capture.js](../../browser/geopixels-capture.js) parcourt les intersections de tuiles au lieu d'une recherche Map par pixel. Cache décodé LRU **32 Mio**, limité aux **ImageBitmap natifs** : leur API ne modifie pas les pixels ; remplacement d'objet, fermeture/transfert (dimensions nulles), disparition, nouvelle couche/projet/position/session invalident les données. Les canvas mutables sont redécodés à chaque bande. Contrat de référence : [standard HTML, ImageBitmap](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#imagebitmap). Cette hypothèse ne transforme pas une date source absente en preuve de fraîcheur, et ne prouve pas la bonne foi de la page.

Le fournisseur autorise 4096² : **20 octets par position**, soit 320 Mio à cette dimension, dans un budget d'allocation de 384 Mio. Les bitmaps natifs, modèles, images, snapshots temporaires et heap du processus s'ajoutent : ce n'est pas une limite globale de RSS. Le benchmark applique séparément un seuil de **768 Mio**, vérifié entre bandes, avec abandon coopératif. Ce contrôle échantillonné n'est pas une limite mémoire imposée par Windows.

[Transport HTTP](../../browser/geopixels-http-transport.js) et [entrée privilégiée](../../src/api/v1/connector-http.ts) : même code temporaire 60 s, clé privée d'approbation dans le dashboard, confirmation volontaire, capacité éphémère, inactivité 30 s, durée absolue **10 min**, révocation, Host/adresse boucle locale, contrôle des origines et schémas stricts. Pas de proxy arbitraire, permission réseau globale, token/cookie/identifiant Google ou secret de session transmis au serveur. L'origine déclarée n'est pas une preuve cryptographique de la page. Cette capacité n'isole pas un processus compromis exécuté sous le même compte Windows ayant accès à la mémoire ou aux fichiers privés de l'utilisateur. `commands.realPlacement` et `purchase` restent faux ; aucun simple réglage ne les active.

## 6. Dashboard et persistance

[RegionalObservations.tsx](../../frontend/src/components/geopixels/RegionalObservations.tsx) fournit le formulaire de rectangles, priorités, suspension, enregistrement, restauration explicite et capture unique. Affiche état, couverture des cibles, corrects/incorrects/inconnus, capture propre, fenêtres des dates encore valides, source datée ou indéterminée, durée moyenne de réception des bandes et état expiré. Cette durée **exclut le décodage avant la première bande et l'ACK final** ; le benchmark mesure séparément le cycle complet du lecteur.

La supervision globale garde les événements, erreurs, changements, historique et octets/bandes uniques acceptés (hors renvois identiques et en-têtes HTTP). La courbe ne mélange pas projets, modèles, régions ou révisions de rectangle différents. Pas de pourcentage global lorsque des cibles restent inconnues. Le mode simulation et ses commandes restent disponibles.

`connector-regions.json` sauvegarde des rectangles liés à l'identité exacte du modèle local/révision, du fantôme filtré et de la position ; aucune session du site ou capacité n'y est stockée. Après redémarrage, il faut coupler, observer, lier puis restaurer volontairement une configuration concordante. Une configuration d'une autre position est refusée. `connector-observations.json` accepte l'historique ancien et le schéma 2 avec région ; les sauvegardes applicatives incluent ces fichiers. Aucun pixel brut n'est persisté dans cet historique.

## 7. Validation sur le véritable navigateur

**Retour utilisateur reçu : les deux régions reçoivent des captures automatiques.** La recette 0.4.0 a été réalisée sur GeoPixels ; le serveur local a reçu 40 captures : une du modèle entier, 30 d'une région principale et 9 d'une secondaire. Les derniers agrégats reçus sont 0 correct / 18 incorrects / 0 inconnu à gauche, 0 / 20 / 0 à droite ; source non datée. Ces 40 premières captures ont été suivies d'une seconde recette après redémarrage du serveur sur le code final `03dfa09`. L'utilisateur a confirmé tous les points demandés ; 72 captures sont conservées au total (deux complètes, 54 à gauche, 16 à droite), source non datée. Les en-têtes HTTP ne certifient pas l'origine de la page.

Un premier accès au dashboard depuis un lien externe a reçu `Forbidden / cross-site`. Reproduction locale : navigation `Sec-Fetch-Site: none` → HTML 200, `cross-site` → refus 403. L'utilisateur a confirmé l'accès après saisie directe dans un nouvel onglet. **Aucune protection n'a été réduite.**

La surveillance réelle 2D et le lecteur 0.3.1 restent des validations historiques acquises ; ils ne prouvent pas à eux seuls la validation des nouveaux rectangles. Validation 2E confirmée par l'utilisateur : captures automatiques des deux régions ; position Gauche/Droite sans inversion ; pause avec captures stables et 38 cibles inconnues après au moins 35 s ; reprise vers 0 correct / 38 incorrects / 0 inconnu sur la même zone vide ; fraîcheur source non vérifiée ; arrêt stable ; révocation et état déconnecté. La configuration a été restaurée volontairement après le redémarrage. Le récepteur a ensuite été arrêté proprement (exit 0), sans restaurer d'autorisation active. Cette recette réelle porte sur une seule fixture 8×5 et une zone vide ; elle ne confirme pas une modification extérieure de pixels sur le service ni les grandes dimensions, qui restent testées localement. Aucun placement ou achat réel effectué.

## 8. Tests et installation

| Contrôle | Résultat |
|---|---|
| `npm run check:logged` final | **925 réussis + 1 facultatif ignoré**, exit 0 |
| Jest | 171 réussis |
| Vitest adapters / core / engine-service / simulator | 66 / 388 (+1 ignoré) / 249 / 51 |
| Build | Exit 0, version 6.0.0-rc.1, lecteur généré 0.4.0 |
| Sécurité HTTP privilégiée | 10 scénarios réels sur boucle locale, réussis |
| Sécurité HTTP/WebSocket | 8 scénarios locaux réussis |
| Edge + Firefox | Simulation/factice, HTTP/CSP/GM simulé, régions et révocation réussis ; aucune requête externe |
| ImageBitmap natif Edge + Firefox | Réutilisation, source canvas modifiée sans mutation du bitmap, remplacement, fermeture, libération vérifiés |
| Clone neuf autonome | Setup Windows réussi ; start.bat installation/contrôle réussi ; recettes Edge factice et HTTP/régions réussies |

Les 41 tests ciblés de progression régionale et de service ont également été réexécutés avec succès sur le code final après les derniers ajustements.

Journaux finaux : `test-logs/2026-11-17T19-32-13-145Z-check.log`, `2026-11-17T19-35-20-577Z-build.log`. Les 47 avertissements lint backend hérités et l'avertissement Vite NODE_ENV existent encore ; zéro erreur. Aucun timeout augmenté pour masquer un échec.

Tests couvrant notamment : une/plusieurs régions, chevauchements, absence de couverture, inconnus/transparent, sources non datées ou anciennes, dates différentes, expiration pendant capture/calcul, limites originales, changement d'identité, déconnexion/reconnexion/révocation, messages manquants/rejoués/désordonnés, arrêt entre bandes, restauration sans autorité, équité, contrôle I/O pendant le calcul et non-régression des huit stratégies en simulation/factice.

Des premiers essais ont échoué pendant le développement : assertions et fixtures anciennes attendaient l'acceptation d'une nouvelle identité sur le même canal ; elles ont été corrigées pour exiger le nouveau couplage. Le script de débit séparé couplait aussi plusieurs dimensions sur une seule capacité : il crée maintenant une association indépendante par modèle. Un premier essai du benchmark 2000² a reçu un refus générique avant instrumentation ; sa cause exacte n'a pas été établie. Son journal est conservé ; les trois passages instrumentés suivants et les contrôles de sécurité finaux réussissent. Aucune garantie de fiabilité absolue ne découle de ces seuls passages.

Les journaux et captures se trouvent sous `test-logs/phase2e/` (ignorés par Git, preuves locales privées) : `edge`, `firefox`, `edge-native`, `firefox-native`, `clone-edge`, `benchmark`, `progress-benchmark` , `progress-benchmark-final` et `progress-benchmark-clock`. Les images des recettes sont clairement **des pages factices locales**, pas des captures du service réel. Aucun test physique Ctrl+C au clavier n'est revendiqué pour 2E ; les garanties automatiques d'arrêt/reprise restent testées.

## 9. Performances mesurées

### Capture → calcul des pixels → HTTP → fournisseur

Trois passages par cas, processus neuf par cas ; CPU et RSS concernent **un processus Node** réunissant canvas, shim GM, HTTP et fournisseur, pas un véritable navigateur GeoPixels. Baseline : code lecteur/fournisseur/HTTP 2D épinglé à `a52ebd2`, core conservant sa sémantique historique ; le point d'entrée HTTP de validation est commun. Canvas mutables : ce tableau ne mesure pas le bénéfice du cache ImageBitmap immuable. Pixels opaques noirs synthétiques (petits entiers JSON) : les images multicolores peuvent produire plus d’octets et coûter davantage. Régionale = **64×64** dans le même modèle ; identité de l'image entière encore hachée.

| Modèle | Mode | Médiane ms | Min–max ms | CPU médian ms | Octets médians | RSS max échant. Mio |
|---|---|---:|---:|---:|---:|---:|
| 64×64 | 2D complète | 86.5 | 82.8–100.5 | 140 | 8,732 | 157.1 |
| 64×64 | 2E complète | 77.1 | 72.7–78.3 | 32 | 8,732 | 181.8 |
| 64×64 | 2E région 64² | 75.6 | 73.6–80.8 | 94 | 8,803 | 146.5 |
| 595×894 | 2D complète | 2558.7 | 2547.6–2581.9 | 906 | 1,082,413 | 167.3 |
| 595×894 | 2E complète | 623.9 | 613.9–655.7 | 703 | 1,068,764 | 174.6 |
| 595×894 | 2E région 64² | 80.1 | 79.9–83.6 | 126 | 8,805 | 175.7 |
| 2000×2000 | 2D complète | 18861.2 | 18790.1–18895.5 | 6359 | 8,137,738 | 276.5 |
| 2000×2000 | 2E complète | 4500.9 | 4458.4–4501.8 | 3953 | 8,034,630 | 317.0 |
| 2000×2000 | 2E région 64² | 126.3 | 122.6–138.9 | 172 | 8,807 | 200.7 |
| 4096×4096 | 2D complète | Non disponible : limite du lecteur 2000 | — | — | — | — |
| 4096×4096 | 2E complète | 21895.5 | 21538.7–21948.0 | 18907 | 33,695,946 | 756.5 |
| 4096×4096 | 2E région 64² | 315.0 | 296.3–315.5 | 297 | 8,807 | 413.7 |

Le 4096² complet termine ses trois passages sous 768 Mio mais avec une faible marge ; recommander des régions et éviter de multiplier les grandes fenêtres sur une machine contrainte. Abandon après une bande acquittée vérifié. La limite d'expiration reste 30 s ; aucune conclusion d'atomicité de ces captures longues.

### Calcul du statut et réactivité

HTTP de boucle locale autour du même cache de progression, couverture synthétique complète : un passage froid puis deux mises à jour d'une région 64². Le tableau mesure le backend, **pas le rendu React d'un grand modèle**. Le premier calcul reste proportionnel à la surface ; les suivants ne reclassent que les cellules changées.

| Modèle | Statut froid ms | Mises à jour ms (min–max) | Plus long intervalle de boucle ms | RSS max échant. Mio |
|---|---:|---:|---:|---:|
| 64×64 | 78.4 | 7.9–8.7 | 55.7 | 63.2 |
| 595×894 | 147.4 | 26.6–38.9 | 65.1 | 82.8 |
| 2000×2000 | 305.6 | 26.3–42.0 | 65.8 | 175.1 |
| 4096×4096 | 848.2 | 28.3–42.8 | 66.9 | 458.4 |

Avant le découpage coopératif, le trou de boucle sur 4096² atteignait 2 418 ms ; après, 67 ms dans cette mesure. Après retrait des lectures répétées de l’horloge à chaque pixel (copie synchrone avec une date unique par fenêtre), le temps total descend à environ 0,85 s : le découpage rend le serveur disponible pendant ce calcul, sans fabriquer une progression instantanée. Les valeurs incluent GC/runtime et ne constituent pas un plafond garanti.

La recette Edge 8×5 mesure environ 354 ms du clic à la mise à jour du dashboard, et des accusés HTTP autour de 53–56 ms dans l'environnement local. Le profil CDP mesure temps de tâches de la page et heap JS seulement ; Firefox ne fournit pas ici ces compteurs. Les captures restent espacées de leur durée + pause configurée, avec granularité du contrôle HTTP ; aucune rafale de rattrapage.

Commandes reproductibles :

```powershell
node --expose-gc --import tsx scripts/bench-regional-observation.mjs test-logs/phase2e/benchmark-nouveau
node --expose-gc scripts/bench-regional-progress.mjs test-logs/phase2e/progress-nouveau
node scripts/recette-connecteur.mjs test-logs/phase2e/edge-nouveau
```

Configurer Playwright/Firefox comme dans le [guide du lecteur](phase2c-lecteur-http.md). Ne pas réutiliser les dossiers de mesures si l'on veut conserver les essais précédents.

## 10. Sauvegardes, état Git et nettoyage

État après les publications :

| Référence | Avant 2E | Après |
|---|---|---|
| main / origin/main | `46877e1` | `cb6521dd1890839ce50f3c0a6cae127451fc71da` |
| 2D locale / origin/2D | `a52ebd2` / absente | `a52ebd2ce9b739fbd1c7e739e0c3be046bfc9af1` des deux côtés |
| RC consolidée | `fe392266` | Inchangée |
| 2E locale | Absente | Code validé `03dfa0919662b39552892499ed51b67402812b86`, puis commit documentaire final |
| 2E sur GitHub | Absente | Absente ; aucun push |

Les autres branches historiques et les remotes sont conservés. Aucun tag n'existait au relevé et aucun n'est créé. Les références finales, le SHA du commit documentaire, l'état propre et le bundle final sont consignés dans `test-logs/phase2e/VALIDATION-FINALE.json`.

Bundles externes créés pendant la phase, vérifiés par empreinte, `git bundle verify`, restauration miroir indépendante et `git fsck --full`, sans alternates :

| Sous-dossier de GeoPlacer-sauvegardes | Bundle | SHA-256 |
|---|---|---|
| `2026-11-17-phase2d-publication` | `GeoPlacer-phase2d-publication.bundle` | `fb0b819a6c4878f03d50c9650866cf31d72f814069dd6ef99ced3a862ef8b68a` |
| `2026-11-17-avant-phase2e` | `GeoPlacer-avant-phase2e.bundle` | `8379ebff4e21709f1a0dc3f7b88b8b599d47da68d8cf35eef579f0b1b1e4c524` |
| `2026-11-17-main-rc-documentation` | `GeoPlacer-main-rc-documentation.bundle` | `f56a0831b6d502150acf0b872cbfde638a34416432bacb07d597a270812aa0e4` |

Le bundle avant 2E précède toute modification applicative. Un bundle local final incluant les commits et ce rapport est également vérifié dans `2026-11-17-phase2e-local-final` ; son empreinte figure dans le manifeste local final et le compte rendu, afin de ne pas créer une référence circulaire entre le commit du rapport et l'archive qui le contient. Les données applicatives et les quatre WIP restent dans les sauvegardes privées antérieures ; un bundle `--all` ne les remplace pas. Les capacités de session ne sont pas réactivées par restauration.

Les copies Phase0 et Phase1a sont de nouveau identiques aux originaux **et aux manifestes** : 18 fichiers / 531 897 octets et 32 fichiers / 99 498 octets. Aucun lien/jonction détecté, aucun script ancien exécuté. Rien n'est retiré.

Le [plan de nettoyage actualisé](PLAN-NETTOYAGE-GIT-DOSSIERS.md) nomme **16 branches locales et cinq distantes candidates**, leurs SHA attendus et leurs preuves d'accessibilité depuis main et 2D publiées. PR ouvertes/fermées vérifiées dans le fork et l'amont, collections vides ; liens externes non exhaustivement inventoriables. La RC exacte, main, 2A–2D, la branche active et les références de récupération sont conservées. Main suit maintenant origin/main ; ne pas répéter l'ancienne procédure de promotion.

Les sauvegardes durables connues et les archives sont sur D: (disque 2). C: (disque 1 SATA) et E: (disque 0 NVMe) sont des disques différents, mais aucune copie durable GeoPlacer n'a été vérifiée dans les emplacements contrôlés. Les restaurations de test dans Temp sur C: ne constituent pas une sauvegarde indépendante durable. Avant retrait, choisir et autoriser une destination sur autre support, copier bundles/WIP/données privées/archives avec manifestes, comparer SHA-256 et restaurer. Aucune copie vers E: effectuée sans accord.

## 11. Matrice des fonctions et ordre de développement

| Fonction | État | Réutilisation / dépendance suivante |
|---|---|---|
| Modèles PNG, palettes, export manuel | Disponible | TemplateManager, quantification et export existants ; main stable |
| Plusieurs modèles enregistrés | Disponible | TemplateManager ; un seul modèle observé actif en 2E |
| Progression correct/incorrect/inconnu | Lecture réelle validée en 2C/2D ; captures régionales et interruptions 2E confirmées par l’utilisateur | GeoPixelsProvider + ProgressCalculator, mêmes règles |
| Surveillance, historique, interruptions | Lecture réelle validée en 2D/2E, sur la fixture utilisateur | ObservationMonitor, dates par pixel, historique borné |
| Priorité des observations par zone | Implémentée et testée localement en 2E | Rotation 3/1, rectangles ; captures automatiques réelles et interruptions confirmées ; équité 3/1 vérifiée par tests et réceptions |
| Priorités de couleur pour dessiner | Simulation/factice uniquement | StrategyConfig `colorOrder`, WorkPlanner ; future UI et ressources réelles vérifiées |
| Zones de travail pour dessiner | Moteur géométrique réutilisable ; parcours réel non implémenté | Distinguer scope de dessin et rectangle d'observation ; aucune écriture activée |
| File de projets, plusieurs dessins actifs | Non implémentée dans le connecteur | TemplateManager + TaskScheduler existant ; autorité/liaison et changements de projet explicites |
| ETA | Simulation uniquement | EtaEstimator ; pas d'ETA réel fiable sans vitesse/coût/ressources vérifiés |
| Ressources | Lecture réelle possible, ancienneté parfois indéterminée | ResourceManager ; date source et contrat de ressource à vérifier |
| Propositions d'améliorations | Simulation/factice uniquement | evaluateUpgradePolicy ; coûts/budgets fiables et confirmation de dépense future |
| Tentatives, journal et réconciliation | Simulation/factice uniquement | AttemptManager, AttemptJournal ; jamais de renvoi aveugle d'une opération incertaine |
| Placement / achat réels | Désactivés, exécuteur absent | Hors 2E ; validation interactive et autorisation de service distinctes |

Ordre recommandé : (1) approfondir les contrôles de fraîcheur source et les changements extérieurs, après la recette régionale réelle validée ; (2) améliorer la comparaison image/filtres lors de la liaison et les diagnostics de couverture ; (3) raccorder priorités couleur et zones au planner unique en lecture/factice ; (4) file de projets avec transitions explicites et reprise ; (5) ETA/ressources sur contrats vérifiés ; (6) seulement dans une phase séparée, examiner faisabilité et autorisations d'écriture, réconciliation et confirmation des dépenses. Ne pas créer un second moteur ni activer des écritures par configuration.

## 12. Commits locaux, limites et décisions

Commits 2E applicatifs/tests :

| SHA | Sujet |
|---|---|
| `8a35fe4059fc154798034c64f450ee9de3ebf800` | feat(core): reuse progress classification within calculation bounds |
| `87e510546d3e862a82fcfed629780fbf2a60fd68` | feat(connector): track regional coverage and independent observation expiry |
| `867616f98b1671ed8009064e2be3652af9fd7ac8` | feat(reader): capture selected regions with bounded bitmap reuse and cancellation |
| `6fcfdff70c2783a285fce84d7ebf083719712d61` | feat(dashboard): supervise regional captures and their uncertainty |
| `8930786358933eaa9c1bd52133e4aaba823c0431` | perf(connector): yield regional progress computation to control I/O |
| `7b4c019afb2789fb421b40a6983f7cdfaabb0108` | test(connector): pair throughput fixtures independently for each project |
| `03dfa0919662b39552892499ed51b67402812b86` | fix(connector): keep future readings unknown and bound window clock costs |

Le commit documentaire contenant ce rapport complète cette liste ; son SHA est fourni dans le compte rendu final et dans le manifeste local `test-logs/phase2e/VALIDATION-FINALE.json`. Vérification : `git log --oneline a52ebd2..HEAD`. Aucun de ces commits 2E n'est poussé.

Limites restantes : date source du cache réellement inconnue, contrat frontend susceptible d'évolution, un modèle actif, pas de chargement automatique de tuiles, premier calcul global encore proportionnel à la surface, hachage complet d'identité même pour une région, mémoire élevée à 4096², réactivité mesurée sur fixtures et un matériel donné. La priorité est une équité en nombre de captures, pas un budget de temps garantissant la fraîcheur de chaque zone ; des régions peuvent expirer si leur cycle dépasse 30 s. La durée moyenne du panneau ne mesure pas tout le cycle navigateur. Les améliorations et écritures réelles restent hors périmètre.

Décisions requises après lecture : approbation du bilan 2E, publication éventuelle de 2E, destination de sauvegarde indépendante, puis autorisations nominatives de nettoyage et réglages de protection GitHub. Aucun tag ni release n'est préparé automatiquement. La prochaine étape technique prioritaire est la validation des changements extérieurs et du contrat de fraîcheur source avant les fonctionnalités avancées.
