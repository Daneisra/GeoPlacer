# Stratégies de dessin

État : **Phase 1B.3**. Les huit stratégies sont implémentées dans
`@geoplacer/core` (`src/strategy/`), sans entrée/sortie. Elles ne
connaissent ni la toile, ni l'ordonnanceur, ni les comptes, ni Wplace, ni
GeoPixels : elles ne font qu'ordonner les pixels d'une image de modèle.
Aucun ordonnanceur ni simulateur ne les utilise encore.

## 1. Principe

```ts
import { templateOrderCursor } from '@geoplacer/core';

const { template } = await modeles.load(ref);   // image enregistrée, jamais requantifiée
const curseur = templateOrderCursor(template);  // stratégie + graine du modèle, pixels hors toile exclus
const lot = new Uint32Array(1000);
const n = curseur.next(lot);                    // n index iy * largeur + ix, dans l'ordre de dessin
```

- **Espace de l'image** : l'ordre est défini sur l'image telle que
  l'utilisateur la voit (origine en haut à gauche, y vers le bas). Un
  canevas dont l'axe y monte ne change pas l'ordre : « haut » est toujours
  le haut de l'image affichée.
- **Pixels éligibles** : les pixels non transparents de l'image, dans les
  limites de la toile quand elles sont connues (`eligibleRegion`). Un pixel
  hors toile ne peut jamais être peint, il n'est donc jamais proposé.
  Toile sans limites : toute l'image.
- **Filtre pur** : avec une région, l'ordre est **exactement** l'ordre
  complet filtré. Le centre, les fréquences de couleur et les contours se
  calculent toujours sur toute l'image. Déplacer un modèle ne fait
  qu'ajouter ou retirer des pixels aux bords coupés ; l'ordre relatif des
  autres ne change jamais.
- **Séparation** : la génération de l'ordre ne lit pas la toile. La
  comparaison avec l'état actuel de la toile reviendra au `WorkPlanner`
  (phase suivante).
- **Déterminisme** : même image, même stratégie, même graine → même ordre,
  quelle que soit la taille des lots (`order()` = concaténation des lots de
  `cursor()`).
- **Version** : chaque stratégie porte `version` (1). Tout changement de
  l'ordre pour une même entrée doit l'incrémenter.
- **Mémoire** : aucun objet par pixel. Les ordres sont des index dans des
  `Uint32Array` ; six stratégies sur huit sont paresseuses.

## 2. Conventions

| Stratégie (`id`) | Ordre | Égalités | Calcul |
|---|---|---|---|
| Haut vers bas (`top-to-bottom`) | Lignes de haut en bas, chacune de gauche à droite | — | Parcours paresseux |
| Bas vers haut (`bottom-to-top`) | Lignes de bas en haut, chacune de gauche à droite | — | Parcours paresseux |
| Gauche vers droite (`left-to-right`) | Colonnes de gauche à droite, chacune de haut en bas | — | Parcours paresseux |
| Droite vers gauche (`right-to-left`) | Colonnes de droite à gauche, chacune de haut en bas | — | Parcours paresseux |
| Centre vers l'extérieur (`center-out`) | Distance euclidienne croissante au centre de l'image | Index croissant (`iy * largeur + ix`) | Fusion paresseuse par tas, mémoire O(hauteur) |
| Aléatoire (`random`) | Permutation uniforme, reproductible par graine | — | Fisher-Yates paresseux, PCG32 |
| Couleur par couleur (`color-by-color`) | Couleurs de `colorOrder`, puis les autres de la moins fréquente à la plus fréquente ; chaque couleur de haut en bas | Valeur `0xRRGGBB` croissante | Tri par dénombrement |
| Contours d'abord (`outline-first`) | Contours de haut en bas, puis intérieur de haut en bas | — | Deux passes paresseuses |

### Centre vers l'extérieur

Le centre est le point ((largeur − 1) / 2, (hauteur − 1) / 2) en
coordonnées de pixels :
- côté **impair** : le pixel du milieu (image 3 × 3 : le pixel (1, 1)
  d'abord) ;
- côté **pair** : le point entre les deux pixels du milieu (image 4 × 1 :
  (1, 0) et (2, 0) à égalité, puis (0, 0) et (3, 0)).

La distance est calculée exactement en coordonnées doublées :
d² = (2 ix − (largeur − 1))² + (2 iy − (hauteur − 1))².

Pas de tri de millions d'éléments : dans une ligne, la distance croît
strictement en s'éloignant de la colonne du centre. Chaque ligne fournit
donc deux flux déjà triés (vers la gauche, vers la droite), fusionnés par
un tas binaire d'au plus 2 × hauteur entrées.

### Aléatoire

- **Générateur** : PCG32 (PCG-XSH-RR, état 64 bits, sortie 32 bits, de
  M. E. O'Neill), identique aux fonctions de référence `pcg32_random_r`,
  `pcg32_srandom_r` et `pcg32_boundedrand_r`. Vérifié sur les vecteurs de
  référence (graine 42, flux 54) et contre une implémentation BigInt
  indépendante.
- **Graine** : entier non signé sur 32 bits (`seed` de la stratégie du
  modèle), **0 par défaut**. Jamais d'heure ni de `Math.random`. Flux
  `RANDOM_STREAM` = `0x47656f50` (« GeoP »).
- **Mélange** : liste des pixels peignables de toute l'image en ordre de
  lecture, puis Fisher-Yates : l'étape i échange l'entrée i avec l'entrée
  i + `bounded(n − i)` et émet l'entrée i. Tirage borné sans biais
  (rejet).
- Changer le générateur, le flux ou le mélange change l'ordre : un test
  fige l'ordre de la version 1 et impose d'incrémenter `version`.

### Couleur par couleur

1. Les couleurs de `colorOrder`, dans cet ordre. Une couleur absente de
   l'image est ignorée ; un doublon est refusé.
2. Puis les autres couleurs, **de la moins fréquente à la plus fréquente**
   (règle de l'ADR 0002), à égalité par valeur `0xRRGGBB` croissante.

Fréquences comptées sur toute l'image. Dans une couleur : de haut en bas,
de gauche à droite.

Tri par dénombrement : une passe de comptage, puis une passe de placement
dans un seul `Uint32Array`. Seules les couleurs distinctes, quelques
dizaines au plus, sont triées.

Depuis la Phase 1B.4, chaque couleur trouve son identifiant dans une petite
table de hachage en tableaux typés (`strategy/color-table.ts`) au lieu
d'un `Map`. Quand la région est l'image entière, il n'y a que deux passes
au lieu de trois. L'ordre produit est identique (version 1).

### Contours d'abord

Un pixel peignable est un **contour** si au moins un de ses quatre voisins
orthogonaux est :
- hors de l'image ;
- transparent ;
- ou d'une autre couleur.

Première passe : les contours ; seconde passe : l'intérieur. Chaque passe
va de haut en bas, de gauche à droite.

Exemples testés :
- carré plein 4 × 4 : les 12 pixels du bord, puis les 4 du centre ;
- carré 5 × 5 percé au centre : le pourtour du trou est un contour ;
- une ligne d'un pixel d'épaisseur : tout est contour.

Le bord de la région éligible (toile) n'est **pas** un contour : seul
compte le bord de l'image.

## 3. Performances (`npm run bench:strategies`)

Mesures sur la machine de développement (Windows 10, Node 22.23.2), deux
exécutions complètes. Chaque cas tourne dans un processus neuf :
- **premier lot** : création du curseur et 1 000 premiers index ;
- **ordre complet** : tout le curseur, vidé par blocs de 65 536 index non
  conservés ;
- **mémoire supplémentaire** : pic du tas JS et des `ArrayBuffer` au-delà
  de l'image elle-même (4 octets par pixel). Si un appelant conserve
  l'ordre complet, il faut ajouter 4 octets par pixel éligible.

Images de 32 couleurs :
- « pixel art » : aplats de 16 × 16, environ 3 % de transparence ;
- « bruit » : couleur aléatoire à chaque pixel, 1 pixel sur 8 transparent.
  C'est le pire cas pour le comptage des couleurs et pour les contours.

**2000 × 2000** : pixel art / bruit ; durées en ms sauf mention ; pire des deux exécutions.

| Stratégie | Premier lot (1 000 pixels) | Ordre complet | Ordre complet, 2e exécution | Mémoire supplémentaire (Mo) |
|---|---|---|---|---|
| Haut vers bas | 2,7 / 2,2 | 48 / 53 | 35 / 38 | 0,2 / 0,3 |
| Bas vers haut | 8,2 / 0,5 | 103 / 42 | 45 / 35 | 0,2 / 0,3 |
| Gauche vers droite | 0,5 / 1,7 | 61 / 83 | 64 / 79 | 0,2 / 0,3 |
| Droite vers gauche | 5,7 / 0,7 | 90 / 89 | 82 / 83 | 0,2 / 0,3 |
| Centre vers l'extérieur | 7,3 / 8,4 | 1,0 s / 1,2 s | 2,5 s / 2,5 s | 1,3 / 1,4 |
| Aléatoire | 97 / 77 | 1,0 s / 946 | 1,1 s / 1,2 s | 19,7 / 18,3 |
| Couleur par couleur | 179 / 548 | 182 / 552 | 123 / 803 | 19,5 / 16,3 |
| Contours d'abord | 2,1 / 1,1 | 147 / 135 | 122 / 101 | 0,2 / 0,8 |

**4096 × 4096** : pixel art / bruit ; durées en ms sauf mention ; pire des deux exécutions.

| Stratégie | Premier lot (1 000 pixels) | Ordre complet | Ordre complet, 2e exécution | Mémoire supplémentaire (Mo) |
|---|---|---|---|---|
| Haut vers bas | 0,8 / 0,7 | 171 / 170 | 158 / 172 | 0,3 / 0,4 |
| Bas vers haut | 0,5 / 1,4 | 162 / 149 | 138 / 168 | 0,3 / 0,4 |
| Gauche vers droite | 0,7 / 0,9 | 1,0 s / 1,0 s | 1,3 s / 1,1 s | 0,2 / 0,3 |
| Droite vers gauche | 1,4 / 0,8 | 1,6 s / 1,0 s | 1,0 s / 962 | 0,2 / 0,3 |
| Centre vers l'extérieur | 21 / 46 | 7,6 s / 7,0 s | 12,8 s / 13,1 s | 1,6 / 1,3 |
| Aléatoire | 301 / 296 | 6,5 s / 5,3 s | 6,5 s / 6,2 s | 69,8 / 65,2 |
| Couleur par couleur | 631 / 3,1 s | 646 / 3,2 s | 585 / 2,9 s | 67,0 / 63,0 |
| Contours d'abord | 0,9 / 1,2 | 610 / 542 | 553 / 482 | 0,3 / 0,8 |

Les lignes « Couleur par couleur » ci-dessus sont celles de la Phase 1B.3,
avant l'optimisation (voir plus bas).

**Objectif de 200 ms pour le premier lot sur 2000 × 2000** :
- **Atteint** par sept stratégies sur huit en Phase 1B.3 :
  - moins de 10 ms pour les quatre directionnelles, le centre et les
    contours ;
  - 56 à 97 ms pour l'aléatoire.
- Couleur par couleur sur le bruit : 531 à 549 ms en Phase 1B.3. Après
  l'optimisation de la Phase 1B.4, deux fois plus rapide, mais la durée
  absolue dépend fortement de la charge de la machine (voir ci-dessous).

**Pourquoi couleur par couleur était lent sur le bruit** (mesuré en
Phase 1B.3) :
- **Ordre complet requis avant le premier lot** :
  - le rang des couleurs dépend des fréquences sur **toute** l'image ;
  - les pixels de la première couleur sont dispersés partout.
- **Trois passes sur l'image** :
  - comptage des fréquences ;
  - comptage dans la région ;
  - placement.
- **Une recherche dans un `Map` par pixel et par passe** : sur le bruit,
  deux pixels voisins n'ont presque jamais la même couleur, et le cache de
  la dernière couleur ne sert à rien.
- Mesure isolée sur 2000 × 2000 bruit : le comptage seul prend 180 à
  250 ms, une passe de recherche dans le `Map` 117 à 140 ms.

**Optimisation de la Phase 1B.4** (`npm run bench:color-by-color`) :
- **Méthode** : l'ancienne implémentation est conservée dans le benchmark
  comme référence. Avant toute mesure, l'ordre des deux versions est
  comparé sur les images complètes, avec une région et avec un
  `colorOrder` : il est identique dans tous les cas. Les deux versions
  s'exécutent ensuite en alternance dans le même processus (médiane de 7),
  de sorte que la charge de la machine les touche également.
- **Résultat**, premier lot (curseur créé et 1 000 premiers index), sur
  deux sessions comparant l'ancienne version à la version retenue :

| Image | Avant / après (2000²) | Gain | Avant / après (4096²) | Gain |
|---|---|---|---|---|
| Uniforme | 60–108 / 64–116 ms | ×0,93 (neutre) | 257–493 / 238–473 ms | ×1,04 à ×1,08 |
| Pixel art | 83–156 / 80–137 ms | ×1,04 à ×1,14 | 337–608 / 268–524 ms | ×1,16 à ×1,26 |
| Bruit | 303–532 / 149–257 ms | **×2,03 à ×2,07** | 1,3–3,3 / 0,58–1,64 s | **×2,02 à ×2,31** |

- **Mémoire supplémentaire** : quelques Ko pour la table. Les écarts
  mesurés (jusqu'à 4 Mo) varient d'une exécution à l'autre sans dépendre
  de la taille de l'image : c'est l'activité du tas JS.
- **Les durées absolues varient presque du simple au double** selon la
  charge de la machine. Le bruit en 2000 × 2000 passe de 303 à **149 ms**
  dans la session la moins chargée, sous l'objectif de 200 ms, et de 532 à
  257 ms dans l'autre. Le rapport de gain, lui, reste stable.
- **Variante écartée** : mémoriser l'identifiant de couleur de chaque
  pixel (1 octet par pixel) pour éviter la seconde recherche. Comparée
  directement, elle n'apportait rien sur le bruit (352 contre 363 ms) et
  ralentissait l'uniforme (168 contre 112 ms) et le pixel art (244 contre
  121 ms).

**Autres constats** :
- **Centre vers l'extérieur** : premier lot immédiat, mais l'ordre complet
  prend de 7 à 13 s en 4096 × 4096.
  - Cause : la fusion par tas coûte environ log₂(2 × hauteur) comparaisons
    par pixel, transparents compris.
  - La seconde exécution est plus lente que la première ; la cause n'est
    pas identifiée.
  - **Problème ouvert** : le curseur ne fait qu'avancer. L'ADR 0002 prévoit
    un ordre « calculé une fois, puis mis en cache ». Un planificateur qui
    reprend un modèle presque terminé devra donc parcourir presque tout
    l'ordre : 7 à 13 s pour le centre et 5 à 6,5 s pour l'aléatoire en
    4096 × 4096. À trancher avant le `WorkPlanner` (Phase 1B.6, objectif
    `nextBatch` < 200 ms sur 2000 × 2000 fait à 99 %).
- **Gauche/droite** : en 4096 × 4096, environ 1 s contre 0,15 s pour
  haut/bas. Le parcours par colonnes saute d'une ligne à l'autre, ce qui
  défavorise le cache du processeur.
- **Aléatoire** : 4 octets par pixel peignable (liste mélangée) ; environ
  0,3 s avant le premier lot en 4096 × 4096 (liste des pixels).
- **Couleur par couleur** : 4 octets par pixel éligible.
- **Stratégies paresseuses** (directionnelles, centre, contours) : moins
  de 2 Mo, quelle que soit la taille.
- Le déterminisme n'a été dégradé nulle part pour gagner du temps.

## 4. Reprise d'un ordre : analyse et décision

**Le problème** : un curseur ne fait qu'avancer. Pour reprendre un modèle
presque terminé, ou repeindre des pixels abîmés en début d'ordre, il faut
savoir où se situe chaque pixel restant dans l'ordre. L'objectif de
l'ADR 0002 pour le `WorkPlanner` est un `nextBatch` sous 200 ms sur
2000 × 2000 fait à 99 %. Or l'ordre complet coûte en 4096 × 4096 :
7 à 13 s pour le centre, 5 à 6,5 s pour l'aléatoire.

**Constat qui simplifie tout** : `nextBatch` n'a pas besoin de l'ordre
complet. Il doit choisir, parmi les pixels restant à peindre (connus par
une comparaison avec la toile, comme la progression : 0,1 à 0,2 s en
2000²), les k premiers selon l'ordre. Il suffit donc d'une **clé de
comparaison par pixel**, pas de la position de chaque pixel dans l'ordre.

| Stratégie | Clé calculable en O(1), sans mémoire |
|---|---|
| Directionnelles | (ligne, colonne) ou (colonne, ligne), selon le sens |
| Centre | (d², index) |
| Couleur par couleur | (rang de la couleur, index) ; rangs calculés une fois par révision |
| Contours | (contour ? 0 : 1, index) ; test du contour sur 4 voisins |
| Aléatoire (Fisher-Yates, version 1) | **aucune** : la position d'un pixel dépend de tout le mélange |

| Solution | Mémoire | Temps de reprise | Déterminisme | Remarques |
|---|---|---|---|---|
| **1. Ordre mis en cache** (calculé une fois par révision, stratégie et graine) | 4 o par pixel éligible (64 Mo en 4096²), plus le même volume sur disque s'il est persistant | O(1) pour retrouver une position, mais le premier calcul reste à payer (jusqu'à 13 s) | Oui, avec une clé de cache (révision, stratégie, version, graine) | Le plus simple ; mémoire importante pour plusieurs modèles |
| **2. Curseur persistant** (état du curseur enregistré) | Directionnelles et contours : quelques octets. Centre : 2 entiers par ligne (32 Ko en 4096²). Aléatoire : toute la liste mélangée (64 Mo) | Immédiat | Oui | Ne voit pas les pixels **déjà dépassés** qui ont été abîmés depuis : il faut quand même repasser sur tout l'ordre |
| **3. Génération recalculable par morceaux** (clé de tri par pixel) | Aucune, sauf la sélection des k meilleurs (O(k)) | Une comparaison avec la toile, O(n) linéaire ; chaque pixel restant est classé par sa clé | Oui | Exige une clé en O(1) : impossible pour l'aléatoire de la version 1, possible avec un aléatoire « version 2 » qui trie par clé pseudo-aléatoire (hachage de la graine et de l'index, ou permutation de Feistel). Cette version 2 changerait l'ordre produit |
| **4. Index ou points de reprise** (état du curseur tous les N pixels) | Centre : un état (32 Ko) par point de reprise. Aléatoire : impossible sans la liste complète | Avancer au plus N pixels depuis le point le plus proche | Oui | Complexe ; résout l'avance rapide, pas les pixels abîmés en amont |

**Recommandation à valider** :
- solution 3 pour sept stratégies : aucune mémoire, aucune génération
  complète, et elle traite naturellement les pixels abîmés n'importe où
  dans l'ordre ;
- pour l'aléatoire, deux voies :
  - une **version 2** à clé de hachage, qui change l'ordre des modèles
    existants ;
  - ou garder la version 1 avec la solution 1 (cache de 4 octets par
    pixel), limitée à l'aléatoire.
- Le choix entre les deux est à faire avant la Phase 1B.6.

**Réserves** :
- **Marge non démontrée** : la solution 3 suppose une comparaison
  complète avec la toile à chaque lot. Mesurée par la progression, elle
  prend 92 à 182 ms en 2000 × 2000 (voir [progression.md](progression.md)),
  ce qui laisse très peu de marge sous l'objectif de 200 ms. Une
  comparaison incrémentale (zones modifiées seulement) sera probablement
  nécessaire, et un prototype de `nextBatch` doit le mesurer avant de
  décider.
- **Ordre aléatoire déjà validé** : un aléatoire « version 2 » remplacerait
  l'ordre Fisher-Yates validé en Phase 1B.3 ; les modèles existants
  changeraient d'ordre.

### Étude du cache d'ordre (Phase 1B.5, `npm run bench:order-cache`)

L'aléatoire PCG32 version 1 est **conservé** (décision du 14/11/2026) : sa
position d'un pixel ne se calcule pas sans l'ordre complet. Étude d'un
cache facultatif, sur disque réel (pixel art, une exécution) :

| Taille | Stratégie | Ordre | Construction | Écriture (fsync) | Relecture + vérification | Reprise à 99 % |
|---|---|---|---|---|---|---|
| 2000² | centre | 14,8 Mio | 618 ms | 149 ms | 154 ms | < 0,1 ms |
| 2000² | aléatoire | 14,8 Mio | 586 ms | 92 ms | 289 ms | < 0,1 ms |
| 4096² | centre | 62,1 Mio | 2,99 s | 819 ms | 728 ms | < 0,1 ms |
| 4096² | aléatoire | 62,1 Mio | 2,78 s | 370 ms | 1,25 s | < 0,1 ms |

- **Clé** : empreinte SHA-256 des pixels quantifiés de la révision
  (`quantizedImageHash`), identifiant et version de la stratégie, graine,
  `colorOrder`. Le placement n'en fait **pas** partie : l'ordre de toute
  l'image ne dépend pas du placement (propriété de filtrage de la 1B.3).
  Changer de révision, de stratégie, de version ou de graine change la
  clé : le cache est refusé avant usage (vérifié).
- **Vérification avant usage** : clé, SHA-256 du contenu, puis
  permutation (chaque index dans l'image, peignable, une seule fois, tous
  présents). La permutation domine le coût de relecture.
- **Position du curseur** : un simple décalage dans l'ordre ; reprise
  immédiate.
- **Mémoire** : 4 octets par pixel peignable, 62 Mio en 4096². Acceptable
  pour la V1 (un agent actif, quelques modèles), à limiter s'il y a
  beaucoup de modèles actifs.

**Conclusions** :
1. Le cache évite la reconstruction (2,8 à 3 s en 4096², et jusqu'à 13 s
   mesurés en 1B.3 sur machine chargée) contre 0,4 à 1,25 s de relecture
   vérifiée.
2. Une position de curseur ne suffit pas : un pixel déjà dépassé peut
   être abîmé ensuite. Le `WorkPlanner` devra quand même retrouver ces
   pixels.
3. Proposition pour la 1B.6 : clé de tri par pixel pour sept stratégies
   (aucune mémoire) ; pour l'aléatoire, la **table des rangs** (inverse de
   l'ordre mis en cache, 4 octets par pixel de plus) donne cette clé en
   O(1). `nextBatch` = comparaison avec la toile, puis les k plus petites
   clés. À mesurer par un prototype avant décision.

### Mise en œuvre (Phase 1B.6)

Décision appliquée : **clé de classement** pour sept stratégies, et
**table des rangs** de l'ordre PCG32 V1, inchangé, pour l'aléatoire.
`prepareOrderKeys(image, config)` renvoie `key(i)` pour chaque index
d'image `i`. Notations : `N` est le nombre de pixels de l'image, `(ix, iy)`
la position du pixel et `W × H` la taille de l'image.

| Stratégie | Clé | Mémoire |
|---|---|---|
| Haut vers le bas | `i` | aucune |
| Bas vers le haut | `(H − 1 − iy) · W + ix` | aucune |
| Gauche vers la droite | `ix · H + iy` | aucune |
| Droite vers la gauche | `(W − 1 − ix) · H + iy` | aucune |
| Centre vers l'extérieur | `d² · N + i` | aucune |
| Couleur par couleur | `rang de la couleur · N + i` | table des rangs de couleur (quelques Ko) |
| Contours d'abord | `(contour ? 0 : N) + i` | aucune (contour testé sur 4 voisins) |
| Aléatoire | rang du pixel dans l'ordre PCG32 V1 | 4 octets par pixel (64 Mio en 4096²) |

**Phase 1B.7** : pour « couleur par couleur », le rang de couleur est lu
dans une table typée ; pour « contours d'abord », une carte des contours
d'un bit par pixel est calculée une fois par révision. Les clés sont
identiques et les mesures sont dans [planification.md](planification.md)
§ 8.

**Équivalence** : pour chaque stratégie, trier les pixels peignables par
leur clé redonne **exactement** l'ordre validé en 1B.3. C'est testé sur
toutes les stratégies, avec des images, des régions, des graines et des
`colorOrder` variés. L'ordre des modèles existants ne change pas.

**Cache de l'ordre aléatoire** (`loadRandomOrder`, adaptateur
`FileOrderCacheStore`) :

- **Clé complète** : projet, modèle, révision, stratégie et sa version,
  graine, empreinte de l'image quantifiée, format (`1`).
- **Fichier** : `GPORDER1`, puis un en-tête JSON (clé, longueur, SHA-256
  du contenu, boutisme), puis les index en Uint32 petit-boutiste. Il est
  écrit de façon atomique sous le répertoire de données verrouillé, dans
  `cache/orders/<projet>/<modèle>/random-r<rév>-v<ver>-s<graine>.order`.
- **Vérifié avant usage** : clé, longueur, SHA-256, puis permutation des
  pixels peignables.
- **Jamais la source de vérité** : en cas d'absence ou de défaut, l'ordre
  est régénéré, le cache réécrit au mieux et le problème signalé
  (`keyProblem`). Un cache corrompu ne rend jamais le modèle inutilisable,
  et supprimer `cache/` est toujours sans risque (testé).

Les mesures du `WorkPlanner` qui s'appuient sur ces clés sont dans
[planification.md](planification.md) § 8.

## 5. Limites connues

- **Couleur par couleur** sur une image bruitée de 2000 × 2000 : 149 ms
  sur une machine peu chargée après l'optimisation de la 1B.4, mais 257 ms
  quand elle est chargée ; l'objectif de 200 ms n'est donc pas garanti.
- **Identifiant** `outline-first` : conservé (décision du 14/11/2026).
- **Ordre complet coûteux** pour le centre et l'aléatoire en 4096 × 4096
  (§ 3). Depuis la 1B.6, le `WorkPlanner` n'en a plus besoin, sauf pour
  l'aléatoire : il lui faut la table des rangs, construite une fois par
  révision (environ 3 s en 4096², 1,5 s depuis le cache vérifié).
- **Aucun ordonnanceur** : le choix du modèle et de l'agent est prévu dans
  une phase suivante.
- Le pixel hors toile est **toujours** exclu quand les limites sont
  connues. Il n'existe pas d'option pour l'inclure, puisqu'il ne peut pas
  être peint.
