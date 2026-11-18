# Lecteur GeoPixels HTTP, surveillance et régions — Phase 2E

Version du lecteur : **0.5.2**, serveur Phase 2F local. Le lecteur reste passif par défaut et conserve les observations régionales du protocole 1 ; les lecteurs 0.3.1/0.4.0 restent compatibles pour leurs observations respectives. Le port écrivain séparé prépare seulement un essai d'un pixel soumis à confirmation explicite dans le dashboard **et** dans le navigateur. Aucun achat ; aucun placement réel validé en Phase 2F. Voir la [recette et les limites de cet essai](RAPPORT-PHASE2F.md). Main fournit toujours la RC de démonstration sans connecteur expérimental.

## Installation et lancement

Dans le clone installé, serveur arrêté :

```powershell
npm.cmd run setup:windows
npm.cmd run start:reader
```

`start:reader` affiche une **clé locale d'approbation privée**, renouvelée à chaque lancement. Elle n'est pas servie par l'API HTTP et le lanceur ne l'enregistre pas. Garder cette console privée ; ne pas partager de capture de cette ligne. La simulation reste accessible ; `npm start` et `start.bat` conservent leur parcours habituel, sans activer ce transport sauf configuration explicite de sa clé.

Taper directement l'adresse locale dans la barre d'adresse d'un nouvel onglet (par défaut `http://127.0.0.1:3000`). Un lien depuis un autre site peut recevoir `Forbidden / cross-site` : ouvrir un nouvel onglet, Ctrl+L, saisir l'adresse et Entrée. Ne pas désactiver la protection d'origine. Sur le dashboard :

1. Choisir « GeoPixels — connecteur expérimental ».
2. Saisir la clé privée dans « Clé locale d'approbation ». Elle reste dans la mémoire du formulaire pendant ce montage.
3. Télécharger et installer le lecteur Tampermonkey proposé. Vérifier **0.5.2**, désactiver les anciens lecteurs GeoPlacer, puis recharger GeoPixels. Un seul lecteur doit être actif.
4. Les seules pages autorisées sont `https://geopixels.net/*` et `https://www.geopixels.net/*`. La permission réseau GM est **127.0.0.1**, sans `*` et sans permission de récupération sur le service. Si Tampermonkey demande l'autorisation locale, contrôler cette destination précise.
5. Garder tous les bots de placement arrêtés. Ouvrir/recharger la page GeoPixels et conserver une copie de son fantôme et de sa position avant de changer d'image.

## Couplage et confirmation volontaire

1. Dans le dashboard, choisir l'origine exacte affichée dans l'adresse du site, puis « Coupler le lecteur GeoPixels ».
2. Le dashboard affiche un **code temporaire à usage unique**, valable 60 secondes. La clé privée du serveur et ce code ont deux rôles différents.
3. Dans le lecteur, cliquer « Coupler », indiquer `http://127.0.0.1:PORT`, puis coller **le code temporaire**. La clé privée d'approbation ne doit jamais être saisie sur la page GeoPixels.
4. Comparer les empreintes courtes de la demande dans les deux panneaux, puis cliquer « Confirmer la demande HTTP » dans le dashboard avant expiration. L'origine est **déclarée**, pas attestée cryptographiquement par HTTP.
5. Attendre « Couplé par HTTP privilégié, en lecture seule ». Aucun cookie, identifiant Google ou token GeoPixels n'est demandé.

La capacité reste en mémoire. Inactivité maximale : **30 secondes** ; durée absolue : **10 minutes**, jamais renouvelée silencieusement. Les échanges de statut maintiennent le canal, sans renouveler les pixels. Après rechargement, redémarrage, expiration ou révocation : nouveau code et confirmation.

Le statut utilise une attente HTTP côté serveur de 5 secondes au plus, interrompue par une commande. Les réponses de statut et d'observation sont cadencées côté serveur (50 ms minimum). Aucune cadence de capture ne dépend d'un setInterval ou d'un petit setTimeout de la page. Cela traite le ralentissement des temporisateurs d'un onglet masqué ; cela ne garantit pas l'exécution d'une page gelée ou abandonnée par le navigateur. Si le navigateur suspend réellement le lecteur, le canal expire normalement. Ne pas désactiver les protections ou l'économie d'énergie globale pour ce test.

## Première observation reproductible

Le fichier **[geoplacer-8x5.png](../../public/fixtures/geoplacer-8x5.png)** est une fixture publique synthétique de 8 × 5, 40 pixels, dont 38 opaques et 2 transparents. Depuis le serveur, le lien est `/fixtures/geoplacer-8x5.png`. Il est inclus dans Git et fonctionne sur clone neuf ; aucun fichier personnel n'est nécessaire.

1. Importer cette PNG dans GeoPlacer et sélectionner son modèle local, sans démarrer le moteur.
2. Charger le même fichier comme fantôme natif sur GeoPixels, le positionner sur une petite région visible, puis attendre le chargement des tuiles.
3. « Diagnostiquer » fonctionne aussi déconnecté : contrat, couche, présence du cache, taille de tuile, bitmap, lecture d'un pixel et lecture utilisée par le moteur. Aucun secret n'y apparaît.
4. Cliquer « Observer le modèle » ; l'envoi est manuel. L'accusé confirme la réception des observations, pas leur fraîcheur côté service.
5. Comparer dimensions, image, filtres et position avant de cliquer « Lier ce modèle » dans le dashboard. Une dimension identique ne prouve pas une image identique.
6. Relever immédiatement corrects, incorrects et inconnus. Leur somme doit être **38** pour cette fixture ; les 2 pixels transparents de la cible sont exclus.

**Chaque pixel observé expire au bout de 30 secondes selon sa date propre.** Les couleurs anciennes sont retirées et les pixels redeviennent inconnus. Une nouvelle capture relit le cache, sans preuve de son actualisation côté GeoPixels. Un transparent observé est connu ; une tuile absente, un bitmap fermé ou une lecture impossible reste inconnu.

## Surveillance pendant une session

1. Après le couplage et la liaison du modèle, choisir une **pause entre captures de 5 à 60 secondes**, 10 par défaut.
2. Cliquer « Démarrer la surveillance » dans le dashboard. Le lecteur confirme la révision de cette commande ; l'interface distingue la demande et sa confirmation.
3. Laisser le lecteur parcourir les bitmaps déjà chargés. Il ne charge aucune tuile et ne contacte aucune API du service.
4. Le temps entre deux débuts de capture est la durée de la capture précédente + la pause, avec la granularité des réponses HTTP de 5 secondes. Aucun rattrapage en rafale, aucune capture simultanée. Le bouton manuel est désactivé pendant la surveillance.
5. « Mettre la surveillance en pause », « Reprendre la surveillance » et « Arrêter la surveillance » sont distincts du scheduler factice. Le contrôle HTTP continue pendant une grande capture ; la pause ou l'arrêt l'interrompt entre deux bandes acquittées. Les bandes reçues gardent leurs propres dates, sans point d'historique complet. Une dernière bande déjà acceptée peut terminer la capture avant la commande. Le canal reste couplé jusqu'à sa révocation ou expiration.
6. Une pause longue ou une cadence de 60 secondes peut laisser expirer des pixels : l'interface doit alors afficher l'inconnu, sans prolonger leur validité artificiellement.

Le panneau distingue heure de réception, début de la dernière capture complète, âge de lecture, date source si elle est connue, couverture des cibles et progression du cache. **Relire une ancienne tuile ne date pas sa source.** Des captures identiques peuvent rester connues comme lectures récentes du cache, tout en étant explicitement de fraîcheur source non vérifiée. Le pourcentage du modèle est indéterminé si la couverture des cibles est incomplète ; il ne constitue jamais une mesure certifiée de la toile entière.

Les changements de valeurs connues, nouvelles valeurs connues, valeurs devenues inconnues et valeurs identiques sont comptés séparément. Un pixel effacé est un transparent connu, pas une tuile inconnue. Les rectangles parcourus peuvent inclure des parties non chargées. La courbe ne relie que des captures à couverture complète du même projet/session, du même modèle local et du même rectangle/révision régionale. Le total du modèle assemble des lectures prises à des instants différents et ne représente jamais une capture atomique.

L'historique conserve **120 captures complètes du modèle ou d’une région** au maximum, avec comptes de progression du moteur, et 40 événements de session. Les bandes incomplètes ne deviennent pas une capture complète. Les agrégats d'avancement sont sauvegardés dans `data/engine/connector-observations.json` (ou le GEOPLACER_ENGINE_DIR choisi), inclus dans les sauvegardes de données. Aucun pixel brut, token ou capacité n'y est conservé. Au redémarrage l'historique est consultable ; ni liaison, ni autorisation, ni surveillance active ne sont restaurées. Les changements de projet sont séparés par leur identité, jamais assimilés à des modifications de pixels.

Pour contrôler couleurs et orientation : utiliser une zone déjà colorée, comparer la couleur du coin avec l'outil natif de lecture, et vérifier le L noir en haut à gauche / les points isolés en bas à droite du fantôme. Les indices de rangées PNG sont convertis explicitement vers Y natif décroissant. Les tests locaux couvrent les quatre bords de tuiles, des coordonnées négatives et des tuiles absentes.

## Observer des régions utiles

Les régions sont des rectangles **dans l’image du même modèle**, pas de nouveaux modèles. X augmente vers la droite, Y vers le bas, origine (0, 0) au coin supérieur gauche. Le lecteur convertit explicitement ces coordonnées vers la grille GeoPixels Y vers le haut.

1. Surveiller un seul modèle lié. Mettre la surveillance en pause ou l'arrêter et attendre qu'aucune bande ne soit en cours.
2. Dans « Régions d’observation », ajouter un rectangle : nom, X, Y, largeur, hauteur. Jusqu'à **16 régions**, entièrement à l'intérieur du modèle ; somme des surfaces au plus 4096² (les chevauchements comptent dans ce budget de travail).
3. Choisir principale ou secondaire ; désactiver une région la suspend. Enregistrer applique et sauvegarde la configuration. « Observer cette région » demande une capture unique pendant la pause/l'arrêt.
4. Démarrer la surveillance. À coût égal, la rotation attribue trois captures à une principale pour une à une secondaire ; les captures terminées servent de mesure d'équité. Une région secondaire activée n'est pas ignorée indéfiniment. Cette rotation n'est pas un second scheduler de peinture et n'a aucun accès aux placements.
5. Le panneau distingue capture propre expirée, couverture actuelle des cibles, valeurs correctes/incorrectes/inconnues, fenêtre des dates de capture encore valides, date source lorsqu'elle est connue et durée de réception des bandes. Une région peut bénéficier d'un chevauchement récent sans avoir été recapturée elle-même.
6. « Observer le modèle entier » enregistre une configuration sans région personnalisée : le comportement complet historique reprend. Si toutes les régions personnalisées sont suspendues, démarrer est refusé ; pas de retour silencieux à un balayage complet.

Le total global ne double pas les chevauchements. Des cellules de calcul disjointes 256² réutilisent **le même calcul de progression et la même image** ; les cellules modifiées ou expirées sont recalculées. Des régions prises à des dates différentes ne deviennent pas artificiellement simultanées. Les bandes initiales d'une capture longue peuvent expirer avant ses dernières bandes : elles redeviennent inconnues.

La configuration est sauvegardée dans `connector-regions.json`, liée au modèle/révision, aux filtres du fantôme et à sa position. Après reconnexion ou redémarrage, une restauration **explicite** n'est proposée que si cette identité concorde ; aucune surveillance, liaison ou capacité active n'est restaurée. Un déplacement ou un changement de session impose de coupler et lier de nouveau.

## Cache décodé, coût et limites

Le lecteur parcourt les intersections des tuiles au lieu de rechercher la même entrée pour chaque pixel. Les bandes contiennent au plus **65 536 valeurs**, restent sous la limite HTTP de 768 Kio et conservent séquences, accusés et déduplication identique des réponses perdues.

Un cache décodé de **32 Mio** réutilise seulement les objets **ImageBitmap natifs**, dont les pixels ne disposent pas d'API de mutation. Le remplacement d'objet, une fermeture/transfert (dimensions nulles), la disparition d'une tuile, une nouvelle identité de modèle/couche/position/session invalident ces données. Les objets de type canvas, mutables, sont redécodés à chaque bande. Cette optimisation découle du [contrat ImageBitmap du standard HTML](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#imagebitmap) ; elle ne date pas le contenu du cache GeoPixels et n'atteste pas la bonne foi de la page.

Limite du modèle : **4096 × 4096**. Le fournisseur réserve 20 octets par position pour couleur, date de validité et date de capture, dans un budget de 384 Mio ; ce budget ne représente pas la mémoire totale de l'application, du navigateur ou des modèles. Le benchmark de processus fixe séparément 768 Mio et abandonne proprement si la mesure dépasse ce budget. Une petite région réduit lecture/envoi mais le hachage d'identité porte encore sur l'image entière et le cache moteur reste dimensionné pour le modèle.

Aucune date source n'est inventée : une lecture récente du même bitmap reste de fraîcheur source non vérifiée. Les ressources non datées restent signalées. Aucune récupération automatique de tuiles, de cookies, de token du site ou d'achat n'est ajoutée. Les règles Host/boucle locale, origine du contrôle, clé privée, confirmation volontaire et capacité éphémère restent appliquées.

## Déplacement, session, arrêt

Après une capture, un changement de modèle, position, filtres, couche ou compte détecté par le lecteur nécessite un nouveau couplage. Le lecteur ferme le canal pour éviter de continuer à présenter l'ancienne liaison. Déconnecter avant de déplacer le fantôme, puis coupler, observer et relier explicitement.

« Déconnecter » ferme le canal depuis le lecteur. « Révoquer le canal » le rend inutilisable depuis le dashboard ; une observation ultérieure doit être refusée. Arrêter le serveur rend toutes ses capacités invalides. Elles ne sont pas restaurées avec les sauvegardes.

La lecture repose sur les bitmaps **déjà chargés**. Elle ne charge pas toute la carte et ne contacte pas une API GeoPixels. L'âge réel des bitmaps reste inconnu sans date fiable. Les ressources peuvent être lisibles tout en étant anciennes ou non datées ; aucun recalcul d'énergie réel n'est inventé.

## Tests locaux

```powershell
npm.cmd run check:logged
npm.cmd run build
node --import tsx scripts/test-privileged-reader.mjs
node --import tsx scripts/test-connector-channel.mjs
# Phase 2F : écrivain entièrement factice, aucun appel au site
node --import tsx scripts/test-single-pixel.mjs
node --expose-gc --import tsx scripts/bench-regional-observation.mjs test-logs/phase2e/benchmark
# Playwright disponible séparément, Edge installé :
$env:GEOPLACER_PLAYWRIGHT_CORE = '<chemin vers playwright-core>'
node scripts/recette-connecteur.mjs test-logs/phase2e/edge
# Pour cibler uniquement la nouvelle recette HTTP : ajouter --http-only.
```

Pour Firefox, définir aussi `GEOPLACER_BROWSER_ENGINE=firefox` et `PLAYWRIGHT_BROWSERS_PATH`. La recette reproduit une page CSP, ralentit ses temporisateurs courts à 60 secondes et **simule l'API GM via Node** ; elle n'installe pas Tampermonkey et ne contacte pas le site. Voir le [rapport 2E](RAPPORT-PHASE2E.md) pour les résultats exacts, les limites et la validation utilisateur, distincte de ces fixtures.


## Validation utilisateur 2E

Le **17 novembre 2026**, l'utilisateur confirme le lecteur **0.4.0** sur le véritable GeoPixels : deux régions 4×5 du fantôme asymétrique 8×5, captures automatiques, bonne position relative et absence d'inversion. Sur le code final `03dfa09`, il confirme la pause avec expiration des 38 cibles après au moins 35 s, la reprise vers 0 correct / 38 incorrects / 0 inconnu dans la zone vide, puis l'arrêt et la révocation. La source reste explicitement non datée. La restauration des régions après redémarrage est volontaire ; aucune capacité n'est restaurée.

Cette validation ne certifie ni une actualisation côté service, ni les grandes dimensions, ni une modification extérieure réelle de pixels. Ces variantes disposent de tests locaux distincts. Le compteur d'octets JSON du panneau porte sur les observations uniques acceptées, hors renvois identiques et en-têtes HTTP.
