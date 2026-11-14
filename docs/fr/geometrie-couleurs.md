# Géométrie et couleurs (Phase 1B.1)

Conventions du cœur `@geoplacer/core` (`src/geometry`, `src/color`,
`src/palette`). Toutes les fonctions sont pures, sans entrée/sortie.

## 1. Repères

| Repère | Origine | Axe X | Axe Y | Valeurs |
|---|---|---|---|---|
| Image source = modèle | pixel en haut à gauche | vers la droite | **vers le bas** | `ix`, `iy` entiers, `0 <= ix < largeur`, `0 <= iy < hauteur` |
| Toile | définie par le fournisseur | vers la droite | `yAxis: 'down'` (vers le bas) ou `'up'` (vers le haut) | entiers sûrs, négatifs admis ; limites facultatives (`bounds`) |
| Placement | — | — | — | `topLeft` = position sur la toile du pixel image (0, 0), le coin haut-gauche tel qu'il apparaît à l'écran |

En V1, le modèle est l'image source elle-même : aucun recadrage,
redimensionnement ni rotation.

### Projection image → toile

```
x = topLeft.x + ix
y = topLeft.y + iy    si yAxis = 'down'
y = topLeft.y - iy    si yAxis = 'up'
```

L'axe X ne s'inverse jamais. La projection inverse (`canvasToImage`) peut
renvoyer un point hors de l'image ; `locateInImage` renvoie alors `null`.

Rectangle couvert par un modèle de `w × h` (`templateBounds`) :
`minX = topLeft.x` ; `minY = topLeft.y` (down) ou `topLeft.y - (h - 1)` (up) ;
largeur `w`, hauteur `h`. Les rectangles ont des bords **inclus** :
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
repère dans lequel le placement du modèle a été exprimé. S'il diffère,
`convertPlacement` / `canvasSystemTransform` le convertit **explicitement** :

| Cas | Résultat |
|---|---|
| Même sens de Y ; limites égales, ou absentes d'un côté | identité |
| Même sens de Y ; deux limites différentes | `AMBIGUOUS_TRANSFORM` |
| Sens opposés ; mêmes `minX`, largeur et hauteur | réflexion verticale `y' = ySum - y` |
| Sens opposés ; limites absentes ou incompatibles | `AMBIGUOUS_TRANSFORM` (l'axe de réflexion ne peut pas être deviné) |

La ligne comptée depuis le haut de l'écran est conservée :
- `ySum = maxY(cible) + minY(source)` de `down` vers `up` ;
- `ySum = minY(cible) + maxY(source)` de `up` vers `down`.

Un placement converti peint exactement les mêmes pixels physiques
(vérifié par test).

### Validation

- Coordonnées : entiers sûrs (`Number.isSafeInteger`). `NaN`, `Infinity`,
  les fractions et les valeurs au-delà de 2⁵³ sont refusés
  (`NOT_AN_INTEGER`).
- Tailles : au moins 1×1 (`INVALID_SIZE`).
- Tout résultat qui sortirait des entiers sûrs est refusé (`OUT_OF_RANGE`).
- `yAxis` inconnu (par exemple lu dans un JSON) : `UNKNOWN_COORDINATE_SYSTEM`.
- Aucune correction silencieuse ; les résultats ne contiennent jamais `-0`.

### Parcours de grandes images

`placementTransform` précalcule `{ originX, originY, yStep }`. Les fonctions
`canvasXOf`, `canvasYOf`, `imageXOf` et `imageYOf` sont purement
numériques : aucun objet n'est créé par pixel.

## 2. Couleurs

- `Rgb` : entier sur 24 bits `0xRRGGBB`, validé (`isRgb`, `asRgb`,
  `rgb(r, g, b)`). Hexadécimal canonique : `#rrggbb` en minuscules (`#RGB`
  accepté en entrée ; les formes avec alpha sont refusées).
- **Noir ≠ transparent.** `0x000000` est une couleur. La transparence vaut
  `TRANSPARENT = -1` dans l'API et `TRANSPARENT_U32 = 0xFFFFFFFF` (hors de la
  plage 24 bits) dans les tableaux compacts.
- **Règle alpha** : `alpha < seuil` → transparent ; sinon le RVB est utilisé
  **tel quel**, sans mélange avec un fond ni prémultiplication. Seuil
  entier dans `[0, 256]` : 0 ne rend rien transparent, 256 rend tout
  transparent.

### OKLab

Conversion de Björn Ottosson (2020) :
1. canal sRGB 8 bits → lumière linéaire :
   `c ≤ 0,04045 ? c / 12,92 : ((c + 0,055) / 1,055)^2,4` ;
2. linéaire → LMS (matrice d'Ottosson), puis racine cubique ;
3. → `(L, a, b)`.

Le sens inverse borne chaque canal à `[0, 255]` pour les valeurs hors gamut.

Vérifications :
- écart aux valeurs publiées < 5·10⁻⁷ (rouge, vert, bleu, blanc, noir) ;
- aller-retour RVB → OKLab → RVB **exact pour les 16 777 216 couleurs**
  (`GEOPLACER_EXHAUSTIVE=1`) ;
- gris neutres : chroma ≈ 0 et `L` strictement croissante.

Distance par défaut : **ΔE_OK** = distance euclidienne dans OKLab
(`oklabDistance`). La distance RVB euclidienne héritée de Wplacer reste
disponible (`rgbEuclideanDistance`). Exemple de divergence : le gris
`#777777` (L = 0,569) est rapproché du blanc en OKLab, mais du noir en RVB.

**Distance remplaçable** : toute implémentation de `ColorDistance` convient.
Si elle déclare un `euclideanSpace` (dimensions + projection), les
recherches projettent la palette une fois et chaque couleur source une
fois, puis comparent des distances au carré.

**Déterminisme** : sur un même moteur JavaScript, les résultats sont
identiques. `Math.cbrt` et `Math.pow` peuvent différer dans les derniers
bits d'un moteur à l'autre. La règle d'égalité reste déterministe.

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
| Projection, un objet par pixel (`imageToCanvas`) | 1 177 ms | 873 ms | 256 Mo |
| Projection numérique (`PlacementTransform`) | 9 ms | 5 ms | 0 |
| OKLab sur les 16,7 M couleurs | 928 ms | 893 ms | 0 |
| 250 000 recherches, chemin générique | 1 867 ms | 2 027 ms | 0 |
| 250 000 recherches, chemin euclidien | 140 ms | 166 ms | 0 |
| Quantification pixel art (32 couleurs source) | 116 ms | 123 ms | 16 Mo |
| idem sans mémo | 2 529 ms | 2 552 ms | 16 Mo |
| Quantification bruit (~4 M couleurs source) | 3 638 ms | 3 743 ms | 16 Mo |
| idem sans mémo | 2 912 ms | 2 645 ms | 16 Mo |
| `Uint32Array` de 4 M pixels | 3 ms | 3 ms | 16 Mo |
| 4 M objets `{ix, iy, color}` | 550 ms | 75 ms | 224 Mo |

Lecture :
- Structures compactes : 16 Mo au lieu de 224 à 256 Mo, et une projection
  environ 170 fois plus rapide.
- Avant le chemin euclidien, la quantification du bruit prenait 26,5 s.
- Le mémo est conservé : il divise par 20 le temps sur une image réaliste
  et ne coûte qu'environ 30 % sur du bruit pur, le pire cas.
