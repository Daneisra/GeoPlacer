# Lecteur GeoPixels HTTP et surveillance — Phase 2D

Version du lecteur : **0.3.1**. GeoPlacer : **6.0.0-rc.1**, branche locale `feat/phase2d-live-observation`, non publiée. La branche 2C publiée conserve son lecteur 0.2.2 et son rapport historique. Le lecteur 0.3.1 nécessite le serveur 2D : son contrôle de compatibilité refuse un ancien serveur sans cadence HTTP négociée. Ce guide concerne uniquement le cache d'une page déjà ouverte ; aucun placement ni achat réel.

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
3. Télécharger et installer le lecteur Tampermonkey proposé. Vérifier **0.3.1**, désactiver les anciens lecteurs GeoPlacer, puis recharger GeoPixels. Un seul lecteur doit être actif.
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

**Une capture expire au bout de 30 secondes.** Les couleurs anciennes sont retirées et les pixels redeviennent inconnus. Une nouvelle capture relit le cache, sans preuve de son actualisation côté GeoPixels. Un transparent observé est connu ; une tuile absente, un bitmap fermé ou une lecture impossible reste inconnu.

## Surveillance pendant une session

1. Après le couplage et la liaison du modèle, choisir une **pause entre captures de 5 à 60 secondes**, 10 par défaut.
2. Cliquer « Démarrer la surveillance » dans le dashboard. Le lecteur confirme la révision de cette commande ; l'interface distingue la demande et sa confirmation.
3. Laisser le lecteur parcourir les bitmaps déjà chargés. Il ne charge aucune tuile et ne contacte aucune API du service.
4. Le temps entre deux débuts de capture est la durée de la capture précédente + la pause, avec la granularité des réponses HTTP de 5 secondes. Aucun rattrapage en rafale, aucune capture simultanée. Le bouton manuel est désactivé pendant la surveillance.
5. « Mettre la surveillance en pause », « Reprendre la surveillance » et « Arrêter la surveillance » sont distincts du scheduler factice. Une capture déjà en cours se termine avant confirmation de la pause/arrêt. Le canal reste couplé jusqu'à sa révocation ou expiration.
6. Une pause longue ou une cadence de 60 secondes peut laisser expirer des pixels : l'interface doit alors afficher l'inconnu, sans prolonger leur validité artificiellement.

Le panneau distingue heure de réception, début de la dernière capture complète, âge de lecture, date source si elle est connue, couverture des cibles et progression du cache. **Relire une ancienne tuile ne date pas sa source.** Des captures identiques peuvent rester connues comme lectures récentes du cache, tout en étant explicitement de fraîcheur source non vérifiée. Le pourcentage du modèle est indéterminé si la couverture des cibles est incomplète ; il ne constitue jamais une mesure certifiée de la toile entière.

Les changements de valeurs connues, nouvelles valeurs connues, valeurs devenues inconnues et valeurs identiques sont comptés séparément. Un pixel effacé est un transparent connu, pas une tuile inconnue. Les rectangles parcourus peuvent inclure des parties non chargées. La courbe ne relie que des captures à couverture complète du même projet/session et du même modèle local.

L'historique conserve **120 captures complètes** au maximum, avec comptes de progression du moteur, et 40 événements de session. Les bandes incomplètes ne deviennent pas une capture complète. Les agrégats d'avancement sont sauvegardés dans `data/engine/connector-observations.json` (ou le GEOPLACER_ENGINE_DIR choisi), inclus dans les sauvegardes de données. Aucun pixel brut, token ou capacité n'y est conservé. Au redémarrage l'historique est consultable ; ni liaison, ni autorisation, ni surveillance active ne sont restaurées. Les changements de projet sont séparés par leur identité, jamais assimilés à des modifications de pixels.

Pour contrôler couleurs et orientation : utiliser une zone déjà colorée, comparer la couleur du coin avec l'outil natif de lecture, et vérifier le L noir en haut à gauche / les points isolés en bas à droite du fantôme. Les indices de rangées PNG sont convertis explicitement vers Y natif décroissant. Les tests locaux couvrent les quatre bords de tuiles, des coordonnées négatives et des tuiles absentes.

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
node --expose-gc --import tsx scripts/bench-live-observation.mjs test-logs/phase2d/benchmark
# Playwright disponible séparément, Edge installé :
$env:GEOPLACER_PLAYWRIGHT_CORE = '<chemin vers playwright-core>'
node scripts/recette-connecteur.mjs test-logs/phase2d/edge
# Pour cibler uniquement la nouvelle recette HTTP : ajouter --http-only.
```

Pour Firefox, définir aussi `GEOPLACER_BROWSER_ENGINE=firefox` et `PLAYWRIGHT_BROWSERS_PATH`. La recette reproduit une page CSP, ralentit ses temporisateurs courts à 60 secondes et **simule l'API GM via Node** ; elle n'installe pas Tampermonkey et ne contacte pas le site. Voir le [rapport 2D](RAPPORT-PHASE2D.md) pour les résultats exacts, les limites et la validation utilisateur, distincte de ces fixtures.
