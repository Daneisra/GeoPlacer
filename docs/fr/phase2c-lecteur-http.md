# Lecteur GeoPixels HTTP — Phase 2C

Version du lecteur : **0.2.2**. GeoPlacer : **6.0.0-rc.1**, branche de développement `feat/phase2c-connector-transport`. Ce guide concerne la lecture du cache d'une page GeoPixels déjà ouverte par l'utilisateur. Il ne propose aucun placement ni achat réel.

## Installation et lancement

Dans le clone installé, serveur arrêté :

```powershell
npm.cmd run setup:windows
npm.cmd run start:reader
```

`start:reader` affiche une **clé locale d'approbation privée**, renouvelée à chaque lancement. Elle n'est pas servie par l'API HTTP et le lanceur ne l'enregistre pas. Garder cette console privée ; ne pas partager de capture de cette ligne. La simulation reste accessible ; `npm start` et `start.bat` conservent leur parcours habituel, sans activer ce transport sauf configuration explicite de sa clé.

Ouvrir l'adresse locale réellement affichée (par défaut `http://127.0.0.1:3000`). Sur le dashboard :

1. Choisir « GeoPixels — connecteur expérimental ».
2. Saisir la clé privée dans « Clé locale d'approbation ». Elle reste dans la mémoire du formulaire pendant ce montage.
3. Télécharger et installer le lecteur Tampermonkey proposé. Vérifier **0.2.2** et un seul lecteur GeoPlacer actif.
4. Les seules pages autorisées sont `https://geopixels.net/*` et `https://www.geopixels.net/*`. La permission réseau GM est **127.0.0.1**, sans `*` et sans permission de récupération sur le service. Si Tampermonkey demande l'autorisation locale, contrôler cette destination précise.
5. Garder tous les bots de placement arrêtés. Ouvrir/recharger la page GeoPixels et conserver une copie de son fantôme et de sa position avant de changer d'image.

## Couplage et confirmation volontaire

1. Dans le dashboard, choisir l'origine exacte affichée dans l'adresse du site, puis « Coupler le lecteur GeoPixels ».
2. Le dashboard affiche un **code temporaire à usage unique**, valable 60 secondes. La clé privée du serveur et ce code ont deux rôles différents.
3. Dans le lecteur, cliquer « Coupler », indiquer `http://127.0.0.1:PORT`, puis coller **le code temporaire**. La clé privée d'approbation ne doit jamais être saisie sur la page GeoPixels.
4. Comparer les empreintes courtes de la demande dans les deux panneaux, puis cliquer « Confirmer la demande HTTP » dans le dashboard avant expiration. L'origine est **déclarée**, pas attestée cryptographiquement par HTTP.
5. Attendre « Couplé par HTTP privilégié, en lecture seule ». Aucun cookie, identifiant Google ou token GeoPixels n'est demandé.

La capacité de canal reste en mémoire du lecteur. Inactivité maximale : 30 secondes ; durée absolue : 10 minutes. Les heartbeats maintiennent le canal pendant cette durée, mais ne renouvellent pas les observations. Après rechargement, redémarrage, expiration ou révocation : nouveau code et nouvelle confirmation.

## Première observation reproductible

Le fichier **[geoplacer-8x5.png](../../public/fixtures/geoplacer-8x5.png)** est une fixture publique synthétique de 8 × 5, 40 pixels, dont 38 opaques et 2 transparents. Depuis le serveur, le lien est `/fixtures/geoplacer-8x5.png`. Il est inclus dans Git et fonctionne sur clone neuf ; aucun fichier personnel n'est nécessaire.

1. Importer cette PNG dans GeoPlacer et sélectionner son modèle local, sans démarrer le moteur.
2. Charger le même fichier comme fantôme natif sur GeoPixels, le positionner sur une petite région visible, puis attendre le chargement des tuiles.
3. « Diagnostiquer » fonctionne aussi déconnecté : contrat, couche, présence du cache, taille de tuile, bitmap, lecture d'un pixel et lecture utilisée par le moteur. Aucun secret n'y apparaît.
4. Cliquer « Observer le modèle » ; l'envoi est manuel. L'accusé confirme la réception des observations, pas leur fraîcheur côté service.
5. Comparer dimensions, image, filtres et position avant de cliquer « Lier ce modèle » dans le dashboard. Une dimension identique ne prouve pas une image identique.
6. Relever immédiatement corrects, incorrects et inconnus. Leur somme doit être **38** pour cette fixture ; les 2 pixels transparents de la cible sont exclus.

**Une capture expire au bout de 30 secondes.** Le moteur retire alors les couleurs anciennes et les pixels redeviennent inconnus. Le dashboard affiche « Capture expirée ». Cliquer de nouveau sur « Observer le modèle » pour une nouvelle lecture. Une valeur transparente observée dans le cache est connue ; une tuile absente, un bitmap fermé ou une lecture impossible reste inconnu.

Pour contrôler couleurs et orientation : utiliser une zone déjà colorée, comparer la couleur du coin avec l'outil natif de lecture, et vérifier le L noir en haut à gauche / les points isolés en bas à droite du fantôme. Les indices de rangées PNG sont convertis explicitement vers Y natif décroissant. Les tests locaux couvrent les quatre bords de tuiles, des coordonnées négatives et des tuiles absentes.

## Déplacement, session, arrêt

Après une capture, un changement de modèle, position, filtres, couche ou compte détecté par le lecteur nécessite un nouveau couplage. Le lecteur ferme le canal pour éviter de continuer à présenter l'ancienne liaison. Déconnecter avant de déplacer le fantôme, puis coupler, observer et relier explicitement.

« Déconnecter » ferme le canal depuis le lecteur. « Révoquer le canal » le rend inutilisable depuis le dashboard ; une observation ultérieure doit être refusée. Arrêter le serveur rend toutes ses capacités invalides. Elles ne sont pas restaurées avec les sauvegardes.

La lecture repose sur les bitmaps **déjà chargés**. Elle ne charge pas toute la carte, ne contacte pas une API GeoPixels et n'offre pas de surveillance continue. L'âge réel des bitmaps reste inconnu lorsque le frontend n'en donne pas une date fiable. Les ressources peuvent être lisibles tout en étant anciennes ou non datées ; aucun recalcul d'énergie réel n'est inventé.

## Tests locaux

```powershell
npm.cmd run check:logged
npm.cmd run build
node --import tsx scripts/test-privileged-reader.mjs
node --import tsx scripts/test-connector-channel.mjs
# Playwright disponible séparément, Edge installé :
$env:GEOPLACER_PLAYWRIGHT_CORE = '<chemin vers playwright-core>'
node scripts/recette-connecteur.mjs test-logs/phase2c/edge
# Pour cibler uniquement la nouvelle recette HTTP : ajouter --http-only.
```

Pour Firefox, définir aussi `GEOPLACER_BROWSER_ENGINE=firefox` et `PLAYWRIGHT_BROWSERS_PATH` vers son installation Playwright. La recette HTTP locale reproduit une page CSP et **simule l'API GM via Node** ; elle n'installe pas Tampermonkey et ne contacte pas le site. Voir le [rapport de Phase 2C](RAPPORT-PHASE2C.md) pour distinguer ces résultats de la validation utilisateur réelle.
