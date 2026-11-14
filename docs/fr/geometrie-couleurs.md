# Géométrie et couleurs (Phase 1B.1)

Conventions du cœur `@geoplacer/core` (`src/geometry`, `src/color`,
`src/palette`). Toutes les fonctions sont pures, sans entrée/sortie.

## 1. Repères

| Repère | Origine | Axe X | Axe Y | Valeurs |
|---|---|---|---|---|
| Image source = modèle | pixel en haut à gauche | vers la droite | **vers le bas** | `ix`, `iy` entiers, `0 ≤ ix < largeur`, `0 ≤ iy < hauteur` |
| Toile | définie par le fournisseur | vers la droite | `yAxis: 'down'` (vers le bas) ou `'up'` (vers le haut) | entiers sûrs, négatifs admis ; limites facultatives (`bounds`) |
| Placement | — | — | — | `topLeft` = position sur la toile du pixel image (0, 0), le coin haut-gauche tel qu'il apparaît à l'écran |

**À confirmer :** en V1, l'espace du modèle est celui de l'image source,
puisqu'il n'y a ni recadrage, ni redimensionnement, ni rotation. Le
« modèle positionné » est cette image associée à son placement.

### Projection image → toile

```
x = topLeft.x + ix
y = topLeft.y + iy    si yAxis = 'down'
y = topLeft.y - iy    si yAxis = 'up'
```

L'axe X ne s'inverse jamais. `canvasToImage` (le sens inverse) peut
renvoyer un point hors de l'image ; `locateInImage` renvoie alors `null`.

Rectangle couvert par un modèle de `w × h` (`templateBounds`) :
- `minX = topLeft.x` ;
- `minY = topLeft.y` (down) ou `topLeft.y - (h - 1)` (up) ;
- largeur `w`, hauteur `h`.

Les rectangles ont des bords **inclus** :
`[minX, minX + width - 1] × [minY, minY + height - 1]`.

### Placement par rapport aux limites de la toile

`checkPlacement` renvoie l'un de ces statuts :
- `unbounded` : la toile n'a pas de limites ;
- `inside` ;
- `partially-outside` : avec la zone visible et le nombre de pixels hors
  limites, pixels transparents compris ;
- `outside`.

`assertPlacement(…, { allowPartial })` refuse un modèle `outside`
(`PLACEMENT_OUTSIDE_BOUNDS`) et, si `allowPartial` est faux, un modèle
`partially-outside` (`PLACEMENT_PARTIALLY_OUTSIDE`).

### Deux repères pour une même toile

Le repère du `CanvasReader` fait foi. `Template.coordinateSystem` est le
repère dans lequel le placement a été exprimé. S'il diffère, il est
converti **explicitement** (`convertPlacement`, `canvasSystemTransform`).
La ligne comptée depuis le haut de l'écran est toujours conservée.

| Limites | Même sens de Y | Sens opposés |
|---|---|---|
| Des deux côtés, mêmes `minX`, largeur et hauteur | translation `y' = y + (minY cible − minY source)` (identité si égalité) | réflexion `y' = ySum − y` |
| Des deux côtés, taille ou `minX` différents | `AMBIGUOUS_TRANSFORM` | `AMBIGUOUS_TRANSFORM` |
| Absentes d'au moins un côté | identité (hypothèse documentée : même origine) | réflexion si l'axe est **fourni** (`reflectionYSum`), sinon `AMBIGUOUS_TRANSFORM` |

Valeur de `ySum` :
- de `down` vers `up` : `ySum = maxY(cible) + minY(source)` ;
- de `up` vers `down` : `ySum = minY(cible) + maxY(source)`.

Un `reflectionYSum` explicite doit concorder avec les limites quand elles
sont connues. Un placement converti peint exactement les mêmes pixels
physiques (vérifié par test).

### Validation

- **Coordonnées** : entiers sûrs (`Number.isSafeInteger`). `NaN`,
  `Infinity`, les fractions et les valeurs au-delà de 2⁵³ sont refusés
  (`NOT_AN_INTEGER`).
- **Tailles** : au moins 1×1 (`INVALID_SIZE`).
- **Débordement** : tout résultat qui sortirait des entiers sûrs est
  refusé (`OUT_OF_RANGE`).
- **Repère inconnu** : un `yAxis` inconnu (par exemple lu dans un JSON)
  donne `UNKNOWN_COORDINATE_SYSTEM`.
- **Forme canonique** : `-0` en entrée (`JSON.parse('-0')`) est normalisé ;
  les résultats ne contiennent jamais `-0` (testé avec des entrées `-0`).
- Aucune correction silencieuse.

### Parcours de grandes images

`placementTransform` précalcule `{ originX, originY, yStep }`. Les
fonctions `canvasXOf`, `canvasYOf`, `imageXOf` et `imageYOf` sont purement
numériques (aucun objet par pixel) et **non vérifiées**, car elles sont
destinées aux boucles critiques.

## 2. Couleurs

- `Rgb` : entier sur 24 bits `0xRRGGBB`, validé (`isRgb`, `asRgb`,
  `rgb(r, g, b)`). Hexadécimal canonique : `#rrggbb` en minuscules (`#RGB`
  accepté en entrée ; les formes avec alpha sont refusées).
- **Noir ≠ transparent.** `0x000000` est une couleur. La transparence vaut
  `TRANSPARENT = -1` dans l'API et `TRANSPARENT_U32 = 0xFFFFFFFF` (hors de la
  plage 24 bits) dans les tableaux compacts. Les points d'entrée vérifiés
  refusent ces valeurs (`INVALID_RGB`) :
  - `rgbToOklab` ;
  - les fonctions `distance()` ;
  - `PaletteMatcher.nearest` et `nearestIndex`.

  La transparence n'est donc jamais rapprochée d'une couleur.
- **Règle alpha** : `alpha < seuil` → transparent ; sinon le RVB est utilisé
  **tel quel**, sans mélange avec un fond ni prémultiplication. **À
  confirmer :** un pixel semi-transparent au-dessus du seuil garde donc sa
  couleur pleine. Le seuil est un entier dans `[0, 256]` : 0 ne rend rien
  transparent, 256 rend tout transparent.

### OKLab

Source : Björn Ottosson, « A perceptual color space for image processing »,
publié le 23/12/2020, matrices sRGB mises à jour le 25/01/2021,
<https://bottosson.github.io/posts/oklab/>. Le code de référence est dans le
domaine public, ou sous licence MIT. Les coefficients de
`src/color/oklab.ts` ont été comparés un à un au code publié.

Étapes de la conversion :
1. canal sRGB 8 bits → lumière linéaire :
   `c ≤ 0,04045 ? c / 12,92 : ((c + 0,055) / 1,055)^2,4` ;
2. linéaire → LMS (matrice d'Ottosson), puis racine cubique ;
3. → `(L, a, b)`.

Le sens inverse borne chaque canal à `[0, 255]` pour les valeurs hors gamut.
Des coordonnées non finies sont refusées (`INVALID_OKLAB`).

Vérifications :
- **Blanc D65** : la page source ne publie que des valeurs pour des entrées
  XYZ ; son blanc D65 (`L 1, a 0, b 0`) est retrouvé.
- **Primaires sRGB** : les valeurs utilisées (rouge, vert, bleu) sont des
  valeurs couramment citées, **recalculées** à partir des matrices ; elles
  servent de non-régression.
- **Aller-retour** RVB → OKLab → RVB **exact pour les 16 777 216 couleurs**
  (`GEOPLACER_EXHAUSTIVE=1`).
- **Gris neutres** : chroma ≈ 0 et `L` strictement croissante.

Distance par défaut : **ΔE_OK**, la distance euclidienne dans OKLab
(`oklabDistance`). La distance RVB euclidienne héritée de Wplacer reste
disponible (`rgbEuclideanDistance`). Exemple de divergence : le gris
`#777777` (L = 0,569) est rapproché du blanc en OKLab, mais du noir en RVB.

**Distance remplaçable** : toute implémentation de `ColorDistance` convient.
Si elle déclare un `euclideanSpace` (dimensions + projection), les
recherches projettent la palette une fois et chaque couleur source une
fois, puis comparent des distances au carré. Sur 50 000 couleurs, ce chemin
rapide choisit exactement les mêmes couleurs que le chemin générique. C'est
**vérifié par test, pas démontré** : seul un arrondi de racine carrée
pourrait les départager.

**Déterminisme** : sur un même moteur JavaScript, les résultats sont
identiques. `Math.cbrt` et `Math.pow` peuvent différer dans les derniers
bits d'un moteur à l'autre ; la règle d'égalité reste déterministe. Pour
garder des `TaskId` stables (couleur comprise), l'image quantifiée sera
**persistée** et jamais recalculée au chargement (critère de la 1B.2).

## 3. Palettes et quantification

- **Règle d'égalité** : la palette est parcourue dans l'ordre et seule une
  valeur strictement inférieure remplace le meilleur candidat. À distance
  égale, **la couleur placée en premier gagne**. Pour une distance
  euclidienne, la valeur comparée est la distance au carré ; même ordre.
- Doublons éliminés (première occurrence conservée) ; palette vide
  refusée (`EMPTY_PALETTE`).
- **Palette par agent** : `agentColors(catalogue, couleursDébloquées)`
  donne les couleurs du catalogue débloquées, dans l'ordre du catalogue,
  puis les couleurs débloquées hors catalogue, en ordre numérique. Aucune
  palette n'est supposée commune aux agents.
- **Quantification** (`quantizeRgba`, `quantizeWithMatcher`) :
  - RGBA ligne par ligne → `Uint32Array` (RVB 24 bits ou `TRANSPARENT_U32`) ;
  - statistiques : transparents, exacts, approchés ;
  - mémo borné des correspondances, vidé quand il est plein.
- **Couleurs absentes** : `missingColors(image, couleursAgent)`, en ordre
  croissant ; `countColors(image)` donne le nombre de pixels par couleur.

## 4. Performances mesurées

`npm run bench:core` (Node 22.23.2, Windows 10, 2000×2000 = 4 M pixels,
palette de 64 couleurs). « À froid » = premier passage ; « à chaud » =
médiane des 3 suivants.

| Cas | À froid | À chaud | Mémoire retenue |
|---|---|---|---|
| Projection, un objet par pixel (`imageToCanvas`) | 1 006 ms | 836 ms | 256 Mo |
| Projection numérique, sans stockage | 10 ms | 5 ms | 0 |
| Projection numérique stockée dans deux `Float64Array` | 20 ms | 24 ms | 32 Mo |
| OKLab sur les 16,7 M couleurs | 904 ms | 875 ms | 0 |
| 250 000 recherches, chemin générique | 1 851 ms | 2 014 ms | 0 |
| 250 000 recherches, chemin euclidien | 145 ms | 164 ms | 0 |
| Quantification pixel art (32 couleurs source) | 121 ms | 140 ms | 16 Mo |
| idem sans mémo | 2 473 ms | 2 476 ms | 16 Mo |
| Quantification bruit (~4 M couleurs source) | 3 480 ms | 3 426 ms | 16 Mo |
| idem sans mémo | 2 717 ms | 2 698 ms | 16 Mo |
| `Uint32Array` de 4 M pixels | 3 ms | 3 ms | 16 Mo |
| 4 M objets `{ix, iy, color}` | 511 ms | 74 ms | 224 Mo |

Lecture :
- **Projection** : à stockage équivalent, les tableaux typés sont environ
  **35 fois plus rapides** que les objets (24 ms contre 836 ms) et
  occupent **8 fois moins** de mémoire (32 Mo contre 256 Mo). Sans
  stockage, aucune allocation.
- **Recherche** : le chemin euclidien est environ 12 fois plus rapide que
  le chemin générique. Avant lui, la quantification du bruit prenait
  26,5 s.
- **Mémo** : il est conservé. Il divise par 18 le temps sur une image
  réaliste et ne coûte qu'environ 25 % sur du bruit pur, le pire cas.
- **Validations** des points d'entrée : aucun effet mesurable sur la
  quantification.
