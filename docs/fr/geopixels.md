# Préparer une image fantôme pour GeoPixels (Phase 1C.1)

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
- une **palette propre à chaque joueur** : des couleurs se débloquent
  (« Any hex color allowed ») ; aucune palette de base n'est publiée en
  clair ;
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
2. **Couleurs** : collez **vos** couleurs GeoPixels en hexadécimal
   (`#rrggbb`, une par ligne ou séparées par des espaces ; 256 au plus).
   Si votre image a déjà les bonnes couleurs (256 au plus), « Reprendre les
   couleurs de l'image » les remplit. Chaque pixel est ramené à la couleur la
   plus proche de cette liste (distance OKLab, la même conversion que pour
   la simulation).
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

## 5. Ce qui est vérifié, et ce qui ne l'est pas

Vérifié par des tests automatisés et une recette navigateur (Edge et
Firefox de Playwright), **sans réseau et sans compte** : transparence,
images non carrées, 3000 × 2000 réduite, 4096 × 4096, couleurs de la
palette uniquement, coordonnées grandes et négatives gardées, aucune
inversion de l'axe Y, export identique au modèle et à l'aperçu, aucune
connexion réseau, séparation d'avec la simulation, sauvegarde.

**Non vérifié** (GeoPixels ne le documente pas, et GeoPlacer n'accède jamais
au site) : que « Upload Image » accepte ce PNG, la taille maximale admise,
l'orientation affichée, la fidélité des couleurs et le traitement de la
transparence dans l'outil. La procédure ci-dessous permet de le vérifier à
la main.

## 6. Test manuel sur le vrai site (à faire par vous)

Durée : 10 minutes, avec votre compte habituel, sans rien peindre.

1. Dans GeoPlacer, préparez une **image de test** de 30 × 20 : un carré
   rouge en haut à gauche (5 × 5), un carré bleu en bas à droite, une bande
   transparente au milieu (lignes entières), le reste dans une de vos
   couleurs ; palette : vos couleurs. Téléchargez le PNG.
2. Dans GeoPixels, outil d'image fantôme, « Upload Image » : **le fichier
   est-il accepté** ? Notez tout message.
3. « Place on Map » à un endroit libre : **le rouge est-il en haut à
   gauche** ? (sinon, l'orientation diffère).
4. **La bande transparente** laisse-t-elle voir la carte ?
5. **Couleurs** : avec la pipette de GeoPixels, les couleurs lues sont-elles
   celles de votre palette ? (La protection contre l'empreinte du canevas de
   certains navigateurs ajoute du « bruit » : GeoPixels conseille de la
   désactiver pour le site.)
6. **Taille** : recommencez avec une image de 500 × 500, puis plus grande,
   jusqu'à un refus éventuel ; notez la taille maximale acceptée.
7. « Clear Image » pour retirer l'image fantôme.

Notez les résultats (acceptée ou non, orientation, transparence,
couleurs, taille maximale) : tant que ce test n'a pas été fait, la
compatibilité n'est **pas** considérée comme validée.

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
