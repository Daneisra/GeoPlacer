# Préparer une image fantôme pour GeoPixels (6.0.0-rc.1 consolidée)

GeoPlacer prépare **sur votre ordinateur** une image destinée à l'outil
d'image fantôme (« ghost image ») de [GeoPixels](https://geopixels.net/) :
conversion dans **vos** couleurs, dimensions, aperçu, PNG standard. Vous
importez ensuite ce PNG **vous-même** dans GeoPixels, et vous placez les
pixels à la main.

GeoPlacer **ne se connecte jamais à GeoPixels** : aucune requête, aucun
compte, aucun cookie, aucun jeton, aucune modification de la page de
GeoPixels. Il ne dessine rien à votre place.

## 1. Ce qui a été vérifié sur GeoPixels

Pages officielles lues le 16/11/2026, sans connexion ni formulaire :
`https://www.geopixels.net/`, `https://www.geopixels.net/TOS.html` (version
« Last updated: September 2, 2026 ») et `https://www.geopixels.net/nuances.html`
(page « Rule Nuances & Clarifications », sans date). Aucune autre page,
aucun script du site ni code d'extension n'a été consulté.

**Fonctions natives décrites par la page d'accueil** :
- l'**image fantôme** (icône 👁) : « Upload Image », « Place on Map »,
  « Clear Image » ; outils associés : « Scan Errors », « Scan Missing »,
  « Nearest », « Group Noise », « Set Palette », « Match My Palette »,
  « Pinned Locations », « Save Configuration » ;
- le **ditherer** (🏁) qui pixellise une image ;
- l'outil « Restore Area », qui utilise l'image fantôme chargée et **son coin
  haut-gauche** ;
- une **palette propre à chaque joueur** : le site propose les choix Base,
  Active (couleurs actives) et Full (couleurs débloquées), ainsi que le
  déblocage de couleurs supplémentaires (« Any hex color allowed »). Les
  pages consultées ne certifient pas une liste initiale exhaustive ;
- des champs de coordonnées « X,Y », un point d'apparition
  `[107958,196137]` (page « Nuances »).

**Non documenté** (donc non vérifiable sans essai) : formats de fichier
acceptés par « Upload Image », taille maximale, opacité, sens de l'axe Y,
traitement de la transparence. La mention « bottom-left corner » de l'outil
d'historique suggère un axe Y vers le haut, mais ce n'est qu'une déduction.

## 2. Conditions d'utilisation (analyse)

Ce que disent les pages lues (citations courtes) :
- **Automatisation interdite** : TOS 1(c) (« Automation: The use of automated
  systems, scripts, macros, or "bots" to create accounts, paint pixels… »),
  2(i) (scripts ou « bots » pour peindre ou interagir) ; 6(b) : le
  « botting » entraîne un bannissement immédiat et définitif ;
- **Un seul compte** : 1(c) (« Multi-Accounting… strictly prohibited ») ;
- **Requêtes automatisées ou excessives** interdites (2(i)) ;
- **Modification du client** interdite (2(i)), **sauf** par une extension
  permise au titre de 1(d) ; 1(d) : GeoPixels peut désigner des extensions
  communautaires permises et les lier depuis le site ; une extension qui
  automatise la peinture, contourne l'énergie ou interagit avec les serveurs
  de façon automatisée est interdite ;
- la page d'accueil (règle 12) interdit de modifier le site, **sans**
  reprendre l'exception des extensions ; elle présente deux extensions
  communautaires (GeoPixels++, GeoPixelcons), **sans dire** qu'elles sont les
  extensions désignées au sens de 1(d).

**Position de GeoPlacer** : il ne fait qu'une **préparation locale
d'image**, comme un éditeur d'images. Il n'automatise rien sur GeoPixels,
n'envoie aucune requête au site et ne modifie pas son client ; l'import et le
dessin restent manuels. D'après la lecture des pages ci-dessus, cet usage
n'entre dans aucune interdiction ; ce n'est pas une autorisation de
GeoPixels, et chaque joueur reste responsable de son usage du site.
GeoPlacer n'utilise ni ne recommande d'extension.

## 3. Parcours

Dans GeoPlacer (menu **« Préparer pour GeoPixels »**) :

1. **Image** : un PNG (8 Mio au plus, 4096 × 4096 au plus) et un nom.
2. **Palette de couleurs** :
   - **Ma palette GeoPixels (28 couleurs)** : liste fournie par l’utilisateur,
     dans son ordre original, avec `#ffffff` corrigé ; sélectionnée par défaut.
   - **Palette communautaire GeoPixels (30 couleurs)** : liste Manako sur
     [Lospec](https://lospec.com/palette-list/geopixels-free-colors), consultée
     le 16 novembre 2026, alors signalée en attente de modération. Elle
     contient les 28 couleurs et, en plus, `#ff9f1c` et `#ffff00`, dans l’ordre
     propre à la source. Aucun mélange silencieux des deux listes.
   - **Palette personnalisée** : coller vos codes à six chiffres ; espaces,
     virgules, points-virgules et retours à la ligne acceptés, casse normalisée.
     Les doublons sont signalés puis ignorés en conservant la première occurrence.
     `#fffff`, les valeurs alpha et caractères invalides sont refusés explicitement.
     Une palette vide ou dépassant 256 couleurs bloque la préparation.
   - **Couleurs originales de l’image** : couleurs des pixels retenus au
     seuil alpha choisi, jusqu’à 256 couleurs. Au-delà, choisir une autre
     palette ; une image filtrée entièrement transparente n’ajoute pas de
     couleur opaque fictive.

   Pastilles, codes, nombre et bouton de copie sont disponibles. Le mode et
   la liste personnalisée sont conservés dans ce navigateur si le stockage
   local est autorisé ; revenir à un préréglage ne remplace pas votre liste.
   Les presets ne sont pas présentés comme officiels et ne prouvent jamais
   les couleurs débloquées de votre compte. Aucun accès au compte n’est fait.
   La distinction Base/Active/Full est visible sur la
   [page native](https://www.geopixels.net/), sans certification de ces listes.

   Le choix alimente la prochaine **Préparation de l’image**, par le même
   quantificateur OKLab que la simulation. Un modèle déjà enregistré conserve
   sa palette effective et son export, même si un préréglage évolue ensuite.
3. **Dimensions** : largeur et/ou hauteur (une seule : proportions gardées) ;
   seuil de transparence (128 par défaut).
4. **Placement** : le coin haut-gauche visé sur GeoPixels (X, Y), noté tel
   quel, sans conversion, et repris dans le nom du fichier.
5. **« Préparer l'image »**, puis vérifiez l'**aperçu** (agrandi, sur damier :
   les cases visibles sont transparentes), les dimensions, le nombre de
   pixels à placer et les couleurs utilisées.
6. **« Télécharger le PNG »** : `geopixels-<nom>-<largeur>x<hauteur>-x<X>-y<Y>.png`.

Puis, **vous-même**, dans GeoPixels :

7. Ouvrez l'outil d'image fantôme (👁), « Upload Image », choisissez le PNG.
8. « Place on Map » : placez l'image (le coin haut-gauche noté sert de
   repère).
9. Facultatif : « Match My Palette » ou « Set Palette » si vos couleurs ont
   changé depuis la préparation.
10. Peignez à la main.

## 4. Détails techniques

- **Format exporté** : PNG RGBA 8 bits ; fragments `IHDR`, `IDAT`, `IEND`
  seulement (aucun gamma ni profil de couleur qui ferait décaler les
  couleurs) ; alpha **0 ou 255** (un pixel est transparent ou opaque, jamais
  à moitié) ; les lignes dans l'ordre de l'image (aucune inversion).
- **Le PNG téléchargé est l'aperçu** : l'aperçu affiche ces mêmes octets ;
  la recette le vérifie pixel pour pixel dans un vrai navigateur.
- **Réimport** : réimporter le PNG exporté avec la même palette redonne le
  même modèle.
- **Redimensionnement** : réduction par moyenne de blocs, pondérée par
  l'alpha (un pixel transparent n'assombrit pas ses voisins) ; agrandissement
  au plus proche voisin. Un bloc à moitié transparent a un alpha d'environ
  128 : avec le seuil par défaut (128), il devient **opaque**. Pour garder
  des bords transparents nets, réduire d'un facteur entier, ou monter le
  seuil.
- **Stockage** : les images préparées sont des modèles de GeoPlacer dans un
  projet à part (`geopixels`), invisibles pour la simulation ; elles sont
  incluses dans les sauvegardes (`npm run backup`).
- **API locale** : `GET/POST /api/v1/geopixels/templates`,
  `GET /api/v1/geopixels/templates/:id`, `GET …/:id/export.png`,
  `DELETE …/:id` (voir [api-v1.md](api-v1.md)).

## 5. Validation utilisateur du 16 novembre 2026

L’utilisateur a préparé un PNG **595 × 894** avec une palette de **28 couleurs**,
puis l’a importé manuellement dans GeoPixels. Il confirme le téléchargement,
l’acceptation par l’outil natif d’image fantôme, l’affichage et le positionnement,
sans inversion évidente. Cette validation a été réalisée par l’utilisateur,
pas par Codex ; elle ne certifie pas toutes les dimensions, palettes, formats,
couleurs ou transparences. Les limites des formats et tailles acceptés par le
site restent non déterminées hors de cet exemple.

| Mesure rapportée | Pixels |
|---|---:|
| Surface totale, 595 × 894 | 531 930 |
| Opaques retenus par GeoPlacer | 294 647 |
| Transparents | 237 283 |
| Dénominateur affiché par GeoPixels | 531 930 |

Les compteurs peuvent utiliser des définitions différentes. La surface inclut
la transparence ; GeoPlacer applique le seuil alpha et ne compare pas les pixels
à l’état réel de la carte. Cette différence n’est donc pas déclarée comme un bug.
La recette locale utilise une **fixture synthétique** de mêmes dimensions et
mêmes compteurs, pas le fichier personnel de l’utilisateur.

## 6. Recette locale reproductible

`node scripts/recette-geopixels.mjs <dossier>` utilise le serveur compilé dans
un dossier temporaire et Edge ; avec `GEOPLACER_BROWSER_ENGINE=firefox`, elle
utilise le Firefox de Playwright. `GEOPLACER_PLAYWRIGHT_CORE` désigne l’outil
installé séparément. Elle vérifie les quatre choix, erreurs, doublons,
persistance, quantification effective, conservation des anciens modèles,
couleurs utilisées/inutilisées, téléchargement et égalité pixel par pixel de
l’aperçu et du PNG. Les requêtes externes sont bloquées ; les liens GeoPixels
et Lospec ne sont pas suivis. Les journaux et captures sont conservés.

Pour un contrôle manuel, préparer d’abord une petite image locale, vérifier les
pastilles et le damier, puis télécharger le PNG. Son import dans GeoPixels est
une action manuelle séparée ; aucun placement automatique n’est proposé.

## 7. Intégrations plus poussées : ce qu'il faudrait demander à GeoPixels

Non développé, volontairement. Chacune demanderait une **autorisation
explicite** des responsables de GeoPixels (contact indiqué par les TOS :
l'adresse de la section 13) :

| Intégration | Ce qu'il faudrait | Pourquoi une autorisation |
|---|---|---|
| Lire automatiquement **votre palette débloquée** | une API documentée ou un export de palette depuis le site | interroger les serveurs par un programme est une « interaction automatisée » (TOS 2(i), 1(d)) |
| Placer l'image **directement** dans l'outil fantôme (sans téléchargement) | un format d'échange ou un lien d'import documenté par GeoPixels (ou une extension **désignée** au titre de 1(d)) | toute modification du client est interdite hors extension désignée |
| Comparer l'image à **l'état réel de la carte** (progression) | un accès en lecture autorisé (API ou export) | lecture automatisée des serveurs ; « Scan Errors » / « Scan Missing » existent déjà dans l'outil natif |
| Projets de **guilde** | la documentation du format de projet de guilde | non documenté |

Le dessin automatique, plusieurs comptes ou le contournement de l'énergie
ne sont **pas** des intégrations envisageables : ils sont interdits par les
conditions de GeoPixels.
