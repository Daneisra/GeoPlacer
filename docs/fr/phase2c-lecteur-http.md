# Lecteur GeoPixels HTTP — observations et petits lots contrôlés

Version actuelle : **1.1.0**, avec un parcours simple par défaut et dessin du modèle entier explicitement autorisé. Voir [le guide du mode autonome](MODE-AUTONOME.md) pour l’import, la correspondance automatique du fantôme, le lancement et la séparation entre autorisation de travail et renouvellement du transport.

Les parcours historiques décrits ci-dessous restent disponibles sous « Réglages avancés ». Le dessin continu 2J conserve ses anciennes limites 30–600 s / 1 000 pixels ; ces limites ne décrivent pas le nouveau mode autonome. Les validations réelles 2H–2J restent acquises, sans valider par avance le lecteur 1.1.0.

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
3. Télécharger et installer le lecteur Tampermonkey proposé. Vérifier **1.1.0**, désactiver les anciens lecteurs GeoPlacer, puis recharger GeoPixels. Un seul lecteur doit être actif.
4. Les seules pages autorisées sont `https://geopixels.net/*` et `https://www.geopixels.net/*`. La permission réseau GM est **127.0.0.1**, sans `*` et sans permission de récupération sur le service. Si Tampermonkey demande l'autorisation locale, contrôler cette destination précise.
5. Garder tous les bots de placement arrêtés. Ouvrir/recharger la page GeoPixels et conserver une copie de son fantôme et de sa position avant de changer d'image.

## Couplage et confirmation volontaire

1. Dans le dashboard, choisir l'origine exacte affichée dans l'adresse du site, puis « Coupler le lecteur GeoPixels ».
2. Le dashboard affiche un **code temporaire à usage unique**, valable 60 secondes. La clé privée du serveur et ce code ont deux rôles différents.
3. Dans le lecteur, cliquer « Coupler », indiquer `http://127.0.0.1:PORT`, puis coller **le code temporaire**. La clé privée d'approbation ne doit jamais être saisie sur la page GeoPixels.
4. Comparer les empreintes courtes de la demande dans les deux panneaux, puis cliquer « Confirmer la demande HTTP » dans le dashboard avant expiration. L'origine est **déclarée**, pas attestée cryptographiquement par HTTP.
5. Attendre « Couplé par HTTP privilégié, en lecture seule ». Aucun cookie, identifiant Google ou token GeoPixels n'est demandé.

La capacité approuvée reste en mémoire pendant la session GeoPlacer. Une interruption temporaire peut reprendre avec le même lecteur. Les échanges de statut ne rafraîchissent pas les pixels. Un rechargement du lecteur, un redémarrage de GeoPlacer ou une révocation exige un nouveau code et une confirmation.

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
2. Dans « Régions d’observation », ajouter un rectangle : nom, X, Y, largeur, hauteur. Jusqu'à **16 régions**, entièrement à l'intérieur du modèle ; somme des surfaces limitée par le budget mémoire négocié (les chevauchements comptent dans ce budget de travail).
3. Choisir principale ou secondaire ; désactiver une région la suspend. Enregistrer applique et sauvegarde la configuration. « Observer cette région » demande une capture unique pendant la pause/l'arrêt.
4. Démarrer la surveillance. À coût égal, la rotation attribue trois captures à une principale pour une à une secondaire ; les captures terminées servent de mesure d'équité. Une région secondaire activée n'est pas ignorée indéfiniment. Cette rotation n'est pas un second scheduler de peinture et n'a aucun accès aux placements.
5. Le panneau distingue capture propre expirée, couverture actuelle des cibles, valeurs correctes/incorrectes/inconnues, fenêtre des dates de capture encore valides, date source lorsqu'elle est connue et durée de réception des bandes. Une région peut bénéficier d'un chevauchement récent sans avoir été recapturée elle-même.
6. « Observer le modèle entier » enregistre une configuration sans région personnalisée : le comportement complet historique reprend. Si toutes les régions personnalisées sont suspendues, démarrer est refusé ; pas de retour silencieux à un balayage complet.

Le total global ne double pas les chevauchements. Des cellules de calcul disjointes 256² réutilisent **le même calcul de progression et la même image** ; les cellules modifiées ou expirées sont recalculées. Des régions prises à des dates différentes ne deviennent pas artificiellement simultanées. Les bandes initiales d'une capture longue peuvent expirer avant ses dernières bandes : elles redeviennent inconnues.

La configuration est sauvegardée dans `connector-regions.json`, liée au modèle/révision, aux filtres du fantôme et à sa position. Après reconnexion ou redémarrage, une restauration **explicite** n'est proposée que si cette identité concorde ; aucune surveillance, liaison ou capacité active n'est restaurée. Un déplacement ou un changement de session impose de coupler et lier de nouveau.

## Cache décodé, coût et limites

Le lecteur parcourt les intersections des tuiles au lieu de rechercher la même entrée pour chaque pixel. Les bandes contiennent au plus **65 536 valeurs**, restent sous la limite HTTP de 768 Kio et conservent séquences, accusés et déduplication identique des réponses perdues.

Un cache décodé de **32 Mio** réutilise seulement les objets **ImageBitmap natifs**, dont les pixels ne disposent pas d'API de mutation. Le remplacement d'objet, une fermeture/transfert (dimensions nulles), la disparition d'une tuile, une nouvelle identité de modèle/couche/position/session invalident ces données. Les objets de type canvas, mutables, sont redécodés à chaque bande. Cette optimisation découle du [contrat ImageBitmap du standard HTML](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#imagebitmap) ; elle ne date pas le contenu du cache GeoPixels et n'atteste pas la bonne foi de la page.

Limite du modèle : budget mémoire configurable, sans plafond indépendant de 4 096 pixels par côté ; voir [le mode autonome](MODE-AUTONOME.md#garanties-et-limites). Les paquets restent bornés à 65 536 valeurs. Les benchmarks historiques 2E ne caractérisent pas toutes les nouvelles dimensions admissibles. Une petite région réduit lecture/envoi, mais le hachage d’identité porte encore sur l’image entière et le cache moteur reste dimensionné pour le modèle.

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


## Premier lot réel — cinq pixels maximum (Phase 2G)

1. Installer le lecteur **0.6.0**, coupler le navigateur, observer le fantôme puis lier le bon modèle. Le bouton « Utiliser le modèle de test 8 × 5 » restaure la fixture si nécessaire. Arrêter les autres bots et vider la file native de placement.
2. Dans « Dessiner un petit lot », garder **5** puis cliquer **Préparer le lot**. Vérifier chaque coordonnée native et code couleur du tableau, ainsi que le modèle, la position et la couche de base.
3. **S’arrêter ici jusqu’à l’accord explicite de l’utilisateur sur ce lot et sa destination.** Après cet accord seulement : cliquer **Autoriser et démarrer le lot**. Les pixels s’enchaînent sans autre confirmation ; garder le lecteur ouvert. Ne pas utiliser le bouton d’essai unitaire.
4. Vérifier le nombre d’**envois confirmés**, puis **Observer le modèle** pour mesurer séparément la progression. Pause, reprise du même lot et arrêt immédiat sont disponibles. Révoquer ensuite le canal.

L’autorisation de cet essai dure deux minutes maximum. Un délai minimal d’une seconde sépare deux envois terminés. Chaque envoi exige une observation non expirée de sa cible et les vérifications navigateur (énergie, couleur possédée, file native vide, session, modèle, position et couche inchangés). Le budget du moteur borne l’autorisation locale. Recharger avant un nouveau lot si le budget conservateur du lecteur est épuisé.

Un résultat manquant ou ambigu arrête le lot et conserve la réservation incertaine. Aucun renvoi aveugle, même après redémarrage. Une réponse `Ok` confirme l’envoi, sans modifier le cache ni la progression observée. Les confirmations durables excluent ces cibles d’un nouveau lot si un ancien cache est relu. La réconciliation exige une source datée postérieure à l’interruption ; le cache réel actuellement non daté ne suffit pas. Un redémarrage ne restaure aucune autorisation : les cibles confirmées sont conservées et les restantes demandent un nouvel accord. L’arrêt ne peut pas annuler une requête déjà partie.


## Premier envoi groupé natif (Phase 2H)

Après installation du lecteur 0.7.0 et liaison du modèle, choisir **Groupé natif — une requête**, fixer **5**, puis **Préparer le lot**. Vérifier destinations, couleurs et coût maximal de cinq points d’énergie. **Attendre l’accord explicite de l’utilisateur sur ces cinq cibles avant de cliquer « Autoriser et démarrer le lot ».** Un seul appel `/PlacePixels` porte le tableau complet ; une réponse `Ok` accepte cette requête, sans prouver la couleur finale de chaque cible. Réobserver pour comparer chaque ligne, en conservant l’indication de fraîcheur source.

Le séquentiel reste sélectionnable pour un nouveau lot. Un groupe incertain ne peut pas être renvoyé automatiquement dans ce mode. Après départ d’une requête groupée, pause/arrêt ne peut pas annuler son application sur le service. La borne de cinq est une limite locale conservatrice, pas une limite officielle du serveur. Voir [le rapport 2H](RAPPORT-PHASE2H.md).


Validation réelle 2H du 18 novembre 2026 : l’utilisateur confirme le succès d’un lot groupé de cinq cibles, avec une requête acceptée et cinq couleurs conformes dans l’observation. La fraîcheur source du cache reste non vérifiée. Détails : [rapport 2H](RAPPORT-PHASE2H.md#validation-utilisateur-réelle--18-novembre-2026).


## Session supervisée (Phase 2I)

Installer 0.8.0, coupler et lier le modèle après observation. Choisir **Session supervisée**, budgets de pixels et d’énergie (25 maximum chacun), puis **Prévisualiser la session**. Le nombre de destinations ne dépasse pas le plus petit budget ni les cibles connues disponibles. **Attendre l’accord explicite de l’utilisateur sur les coordonnées/couleurs affichées avant « Autoriser et démarrer la session ».** Les groupes de cinq maximum s’enchaînent ensuite sans nouvelle confirmation.

Pause/reprise ne renouvelle pas l’échéance absolue de deux minutes. Arrêt ou résultat incertain bloque les envois suivants ; une requête déjà partie ne peut être annulée sur le service. Aucune régénération d’énergie n’est créditée automatiquement. Le redémarrage conserve l’historique des groupes et les cibles acquittées, jamais l’autorisation. La progression observée et sa fraîcheur restent distinctes de l’acceptation des requêtes. Voir [le rapport 2I](RAPPORT-PHASE2I.md).


Validation réelle 2I du 18 novembre 2026 : l’utilisateur confirme une session de 25 cibles, cinq requêtes acceptées et 25 couleurs conformes après observation ; progression globale du modèle : 36 corrects, 2 incorrects, 0 inconnu. La fraîcheur source reste non vérifiée et les deux cibles restantes ne sont pas envoyées automatiquement. Voir [le rapport 2I](RAPPORT-PHASE2I.md#validation-utilisateur-réelle--18-novembre-2026).


## Dessin continu supervisé (Phase 2J)

Choisir **Dessin continu — zone et budgets autorisés**. X/Y désignent le coin supérieur gauche dans l’image (Y vers le bas), pas les coordonnées de la carte. La prévisualisation indique le rectangle natif (Y décroissant), les budgets et la durée. Elle autorise les futures cibles incorrectes de ce rectangle, pas une liste figée. Les lignes apparaissent au fur et à mesure des réservations durables. Le modèle, sa révision, ses couleurs, sa position et sa couche sont scellés ; leur changement interrompt la session.

Les groupes s’enchaînent dans le TaskScheduler existant. Une cible déjà acquittée reste exclue malgré un cache ancien ou une modification ultérieure. Les autres pixels devenus incorrects peuvent être sélectionnés dans la zone. Les pixels inconnus restent ignorés jusqu’à une capture exploitable ; la surveillance du cache doit être active pour suivre les changements. Le lecteur ne récupère aucune tuile.

**Énergie :** le lecteur observe passivement les réponses du `syncWorker` natif (`sync-delta` / `ok`, `userData.energy`, `colors`). Il ne déclenche pas de synchronisation et ne transmet que sept champs autorisés : source, séquence, début de requête, réception, énergie brute, solde conservateur et couleurs. Le compteur `currentEnergy`, recalculé à l’horloge par GeoPixels, peut abaisser le solde mais jamais le recharger. Les réponses anciennes ou initiées avant les envois précédents ne peuvent pas restituer leur coût. Une réponse doit rester exploitable moins de 30 s ; sa réception n’atteste pas la fraîcheur des tuiles.

Sans cette interface ou sans nouvelle réponse native, l’état devient **Attente de ressources observables**. Aucun calcul de régénération ne fait repartir les envois. Le frontend peut suspendre sa synchronisation native lorsque son onglet est masqué : remettre GeoPixels au premier plan, puis consulter **Diagnostiquer**. Ne pas désactiver la sécurité du navigateur. Cette interface d’énergie supplémentaire est testée sur contrats factices et sa disponibilité est confirmée par le diagnostic réel du premier essai 2J ; la reprise après épuisement d’énergie reste à valider sur le service.

Pause/reprise conserve l’échéance initiale. Arrêt, expiration de l’autorisation ou du couplage interrompt les nouveaux envois. Un groupe déjà parti peut rester incertain : aucun renvoi, même après redémarrage. L’autorisation et le solde exploitable ne sont jamais restaurés automatiquement. Une nouvelle approbation explicite peut reprendre le périmètre conservé, dans le budget restant, seulement après traitement des tentatives incertaines.

### Premier essai réel 2J — ne pas démarrer avant accord

1. Utiliser le lecteur **1.0.0** en mode continu hérité, coupler comme précédemment ; dans le dashboard, choisir Simulation locale → Importer un PNG → [le PNG 20 × 20](../../public/fixtures/geoplacer-20x20.png), laisser X/Y à 0 et cliquer Importer et sélectionner. Charger le même fichier dans le fantôme GeoPixels, puis repasser sur le connecteur GeoPixels. Vérifier l’image, sa position et la liaison. Garder les autres bots arrêtés et la file native vide.
2. Choisir **Dessin continu**, zone image **X=0, Y=0, largeur=10, hauteur=10**, **50 pixels / 50 énergie / 120 s**. Cliquer **Prévisualiser la session**. Vérifier le modèle, la couche et les deux coins natifs affichés. **S’arrêter ici et faire valider explicitement ce rectangle et ces budgets par l’utilisateur.** Aucun envoi n’est encore autorisé.
3. Après cet accord seulement : démarrer la surveillance du cache, puis **Autoriser et démarrer la session**. Les groupes de cinq maximum avancent automatiquement ; si l’énergie n’est pas exploitable, ils attendent une nouvelle réponse native. Ne pas augmenter le budget pour contourner cette attente.
4. Observer les compteurs et l’historique ; tester pause/reprise puis arrêt et révocation. Vérifier ensuite les couleurs séparément des accusés, éventuellement après rechargement du site. Rapporter le résultat sans transmettre de code, clé ou donnée de session.


Validation réelle 2J du 18 novembre 2026 : l’utilisateur confirme **50 cibles acquittées en dix requêtes**, puis **50 couleurs conformes** après observation, avec arrêt au budget et aucune tentative incertaine. La zone 10 × 10 compte 50 correctes / 50 incorrectes / 0 inconnue ; le modèle 20 × 20 compte 50 correctes / 350 incorrectes / 0 inconnue. Le diagnostic confirme les réponses natives d’énergie. La fraîcheur serveur des tuiles reste non vérifiée. Les autres scénarios de fiabilité restent des validations locales. Voir [le rapport 2J](RAPPORT-PHASE2J.md#validation-utilisateur-réelle--18-novembre-2026). Aucun nouvel envoi n’est autorisé par cette consignation.


### Deux échéances et diagnostic d’interruption

Le dashboard sépare le **couplage navigateur**, valable pour la session GeoPlacer, de l’**autorisation de dessin**, dont la durée dépend du mode choisi. Toute révocation interrompt le canal et invalide les opérations autorisées par ce canal.

Après interruption, le dernier motif connu s’affiche : expiration absolue, inactivité, contexte changé, canal remplacé, déconnexion ou révocation. Les nouveaux journaux serveur `[connector-http]` et `[connector-drawing]` conservent les dates et compteurs utiles, sans secrets. Une fermeture par inactivité ne permet pas à elle seule de distinguer rechargement, suspension de l’onglet ou perte de transport. Le lecteur 0.9.0 reste compatible ; aucun allongement de limite n’est nécessaire.

Les cibles acquittées restent exclues. Reprendre le lot conservé exige un nouveau couplage, une observation/liaison vérifiée et une nouvelle autorisation du budget restant. Voir [le diagnostic de l’arrêt après 55 cibles](DIAGNOSTIC-2J-INTERRUPTION.md).
