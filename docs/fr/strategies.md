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

**Objectif de 200 ms pour le premier lot sur 2000 × 2000** :
- **Atteint** par sept stratégies sur huit :
  - moins de 10 ms pour les quatre directionnelles, le centre et les
    contours ;
  - 56 à 97 ms pour l'aléatoire.
- **Non atteint par couleur par couleur sur le bruit** : 531 à 549 ms. Sur
  le pixel art, 146 à 179 ms, juste sous l'objectif.

**Pourquoi couleur par couleur est lent sur le bruit** (mesuré, non
optimisé à ce stade) :
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

Pistes possibles, à valider, sans changer l'ordre produit :
1. Remplacer le `Map` par une petite table de hachage en tableaux typés.
   L'image quantifiée a au plus quelques dizaines de couleurs.
2. Fusionner les deux passes de comptage quand la région est l'image
   entière (cas le plus courant).

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

## 4. Limites connues

- **Couleur par couleur** dépasse l'objectif de 200 ms pour le premier
  lot sur une image bruitée de 2000 × 2000 (voir § 3). Optimisation
  possible, non faite, à valider.
- **Identifiant** `outline-first` : la demande de la Phase 1B.3 écrit
  `outlines-first`. L'identifiant du contrat et des manifestes est
  conservé ; à confirmer.
- **Ordre complet coûteux** pour le centre et l'aléatoire en 4096 × 4096
  (§ 3) : la reprise d'un modèle presque terminé n'est pas encore résolue.
- **Ordre de génération seulement** : aucune comparaison avec la toile
  (`WorkPlanner`), aucun ordonnanceur, aucune file. Prévu dans les phases
  suivantes.
- Le pixel hors toile est **toujours** exclu quand les limites sont
  connues. Il n'existe pas d'option pour l'inclure, puisqu'il ne peut pas
  être peint.
