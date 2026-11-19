# Dessin autonome supervisé — lecteur 1.1.0

Branche locale `feat/autonomous-drawing`, issue de `e38998f`. Aucun nouvel envoi réel effectué pendant ce développement.

## Utilisation

1. Redémarrer GeoPlacer avec `npm.cmd run start:reader`. Ouvrir directement l’adresse locale affichée et choisir la source GeoPixels. Garder la clé privée de la console pour le dashboard.
2. **Importer l’image**, puis **Télécharger le fantôme pour GeoPixels**. Charger ce même PNG préparé dans l’outil natif du site et le positionner.
3. Installer le lecteur **1.0.0**, désactiver l’ancien et recharger GeoPixels. Garder les autres bots arrêtés et la file manuelle vide.
4. Dans **Connexion au navigateur**, effectuer le couplage : clé privée dans le dashboard uniquement, code temporaire dans le lecteur, comparaison de l’empreinte et confirmation locale. Une première observation de 256 × 256 maximum part automatiquement ; le reste demeure inconnu.
5. La correspondance des pixels RGBA est vérifiée par SHA-256 et le modèle est lié automatiquement. Vérifier l’aperçu, le rectangle natif et le budget, puis **Lancer le dessin**. Surveillance, planification et envois démarrent ensemble.

L’import affiche sa progression puis son résultat juste sous le bouton. Un ancien brouillon ou travail interrompu sans opération ouverte est retiré automatiquement, en conservant ses confirmations. Un dessin actif/pausé ou une opération incertaine bloque toujours le changement de modèle. Le couplage n’est pas nécessaire pour importer.

**Options du dessin** permet de réduire le budget et de choisir la taille cible des groupes. **0 = automatique** : départ à 16, hausse progressive après acceptation, dans la limite de l’énergie observée, du budget et du transport local. Une valeur positive fixe le maximum souhaité. Le transport négocié réserve 128 Kio par commande, soit au maximum 793 cibles avec sa marge de métadonnées ; ce nombre n’est pas présenté comme une limite du serveur GeoPixels. Les anciens parcours séquentiels/groupés restent disponibles avec leurs limites historiques. Un travail déjà autorisé conserve son plafond ; arrêter puis préparer un nouveau travail pour le changer.

Sans budget personnalisé, le maximum correspond aux cibles opaques. La palette proposée reprend la liste personnelle de 28 couleurs, sans présumer des couleurs débloquées ; la modifier avant l’import si nécessaire. **Réglages avancés** retrouve les anciens parcours et diagnostics.

Pause, reprise, arrêt et révocation restent disponibles. **Préparer la suite** crée une nouvelle prévisualisation après arrêt/terminaison, sans autoriser d’envoi.

## Garanties et limites

- **Travail et transport distincts.** L’accord porte sur un modèle/révision, une image, un contexte, une position, une couche et un budget non extensible. Il dure jusqu’à terminaison, arrêt, révocation ou interruption invalidante. Il n’est jamais restauré actif au redémarrage.
- **Couplage de session.** Le serveur conserve l’approbation en mémoire jusqu’à son arrêt, à la révocation, à la déconnexion volontaire ou à la perte du contexte du lecteur. Le code initial et la demande d’approbation expirent. Une interruption temporaire du transport peut reprendre avec la capacité du même lecteur.
- **Interruptions.** Une erreur temporaire de statut peut être retentée. Une prise de commande ou une écriture incertaine bloque la poursuite. Deux accusés d’observation manquants ferment le canal pour séquence incertaine. Un rechargement du lecteur ou un redémarrage de GeoPlacer exige un nouveau couplage. Les confirmations restent conservées pour la même identité.
- **Un seul moteur.** Le TaskScheduler existant travaille par vues de 256 × 256 du même modèle. Le lecteur utilise uniquement les tuiles déjà chargées ; aucune récupération automatique. Les pixels absents/expirés restent inconnus, avec expiration à 30 s. Une capture récente d’un cache non daté ne prouve pas sa fraîcheur serveur ; plusieurs régions ne constituent pas un instantané atomique.
- **Capture conservée.** Le tableau de bord peut afficher les compteurs datés de la dernière capture complète après la diminution de la couverture exploitable. Les compteurs historiques ne participent pas à la planification.
- **Énergie observée.** Le lecteur utilise les réponses du worker natif et, pendant un travail autorisé, une lecture de `/GetUserData` au plus toutes les dix secondes. Quand une réponse récente fournit le solde, la date de référence, l’intervalle de recharge et la capacité, le lecteur applique le calcul de recharge de GeoPixels et borne le résultat au compteur natif. Les envois restent déduits si la même date de référence revient. Le compteur de la page seul ne crée aucun crédit. Les identifiants restent dans le navigateur.
- **Taille des groupes.** Les tailles supérieures à cinq sont vérifiées localement, pas encore sur le service. Le frontend public envoie un tableau sans plafond de cinq ; la limite serveur exacte n’est pas publiée dans les sources examinées. Le plafond de 5 000 du bot communautaire n’est pas repris comme une garantie. Un HTTP 413 explicite réduit la fenêtre et exige une nouvelle preuve de ressources. Toute réponse ambiguë bloque les placements concernés sans renvoi automatique.

## Cache et grandes images

Les cellules de 256 × 256 restent des vues du même modèle. Le lecteur 1.1.0 parcourt les régions d’une passe sans attendre cinq secondes entre chacune ; la pause s’applique entre les passes. Les indications de présence des bitmaps privilégient les régions chargées, avec une sonde équitable toutes les huit captures. Une présence ne garantit ni la lisibilité ni la fraîcheur. Afficher manuellement les zones manquantes sur GeoPixels reste nécessaire : le connecteur ne télécharge pas de tuiles.

Le cache décodé est invalidé si le bitmap, ses dimensions ou son curseur natif changent. Seuls les bitmaps immuables peuvent être réutilisés entre captures. Les preuves natives sont corrélées au bitmap installé : remplacement complet, réponse sans changement ou fusion unique identifiée. Des fusions concurrentes/ambiguës restent non vérifiées. L’âge de cette preuve ne change pas lors d’une relecture locale. Le dashboard distingue couverture, conformité, tuiles mises à jour/vérifiées et tuiles absentes. Les détails expliquent séparément l’absence de date serveur : `ServerTimestamp` est un curseur opaque, jamais converti en date.

L’expiration des pixels reste de 30 secondes. Une grande image peut donc conserver des régions inconnues ou expirées ; aucun pourcentage global complet n’est inventé et aucune observation composite n’est présentée comme atomique. Les accusés ne modifient pas les pixels observés et leurs cibles restent exclues d’un nouvel envoi automatique.

## Améliorations automatiques facultatives

Désactivées par défaut. Dans les options, choisir les catégories et leur priorité, le budget maximal de monnaie du jeu, la réserve, la capacité ciblée et le seuil de recharge. La prévisualisation inclut cette politique dans l’autorisation signée du dessin. **Lancer le dessin** autorise ensemble ce périmètre et son budget ; changer les options ne modifie jamais un travail actif.

Tarifs du frontend public : recharge **10 → +20 énergie**, capacité **50 → +5**, récupération **500 → −1 s** (minimum 15 s), couleur **100**. Le profil prévoit aussi la gratuité des premières couleurs (`Colors.length < 35`, transparence comprise). Le déblocage automatique nécessite une palette native concordante et une condition de prix identifiable ; sinon il est indisponible. Seules les couleurs effectivement utilisées dans l’image sont proposées.

`ResourceManager` et `UpgradePlanner` établissent les propositions ; leurs états simulés ne deviennent jamais un solde réel. Les achats sont sérialisés avec le scheduler existant, à un point sans placement en vol et avec un solde natif postérieur aux placements précédents. Ils peuvent attendre un point d’inactivité énergétique. Chaque intention est enregistrée durablement dans `connector-upgrades.json` avant sa livraison unique. Après acceptation HTTP 200, une nouvelle réponse doit confirmer **le débit exact et l’effet** avant un autre achat. Perte de réponse, interruption ou effet/débit discordant : achats du type concerné bloqués, sans nouvel envoi automatique. Aucun achat n’est restauré actif au redémarrage.

Le navigateur vérifie à nouveau boutique, modèle, session, file manuelle, prix, réserve et budget. Seul `/MakePurchase` est accessible pour les quatre améliorations de jeu ; aucun paiement, abonnement, compte ou proxy générique. Les prix proviennent du frontend, sans transaction conditionnelle côté serveur : tout écart observé suspend les achats. Une validation réelle reste nécessaire. Sauvegarder **tout le répertoire de données**, journal d’améliorations compris.

Contrats consultés : [frontend 74783af](https://github.com/AntCDev/GeoPixelsFront/tree/74783afc5b7e3064a43eed20b0f6638007853324) (`wwwroot/js/index.js`, `sync-worker.js`, `userProfile.js`, `wwwroot/index.html`) ; [bot communautaire 756472d](https://github.com/Fox3225/GeoPixelsBotClean/tree/756472d3ac90f1b72c5fc8354aa6e89b53b7ac85). Leur code de planification n’a pas été importé.

`MakePurchase` est également identique dans [la révision historique 8367389](https://github.com/AntCDev/GeoPixelsFront/blob/83673896886c016a3d23bd46a2309570194a19da/wwwroot/js/userProfile.js) ; le profil y contient déjà la condition des couleurs gratuites. Cela ne dispense pas des vérifications du navigateur.

## Validation locale de l’optimisation

- Fournisseur factice : 400 cibles en 5 requêtes adaptatives, contre 80 avec le plafond précédent ; 600 cibles sur trois régions en 8 requêtes, contre 122. Comparaison de nombres de requêtes, sans promesse de latence réelle.
- Writer navigateur : groupes de 16, 50, 100, 300 et 793, budgets, interruption, anti-rejeu ; HTTP 413 réduit la fenêtre et impose une preuve de ressources postérieure.
- Cache : bitmap remplacé/fermé, curseur modifié, fusion native corrélée ou ambiguë, régions manquantes et expiration inchangée. Sélection de régions sur une image 2048 × 2731 ; conversions et progression complètes sur 64², 595 × 894 et 2000².
- Achats factices : budget, réserve, gratuité, plancher de récupération, intention durable, effet/débit, réponse perdue, reprise et refus de redélivrer. La lecture des ressources ne copie aucune session vers le serveur.
- Edge et Firefox, pages factices uniquement : import/couplage/lancement, groupes adaptatifs, recharge de 10 monnaies puis 20 cibles, arrêt/révocation ; aucune erreur de page ni requête externe. Journaux : `test-logs/optimization-edge-final.log`, `test-logs/optimization-firefox-delivery.log`. Le shim GM ne valide pas Tampermonkey réel.
- Sécurité HTTP locale : dix scénarios réussis, journal `test-logs/optimization-privileged-security.log`. Le quota reste de 25 messages authentifiés/s ; les revérifications internes d’une même réponse ne sont plus comptées comme de nouveaux messages. Le statut compact ne reconstruit pas l’historique à chaque poll.
- Contrôle complet : **1 126 tests réussis, un facultatif ignoré**, types et lints sans erreur (47 avertissements backend préexistants). Journal `test-logs/2026-11-18T23-36-44-927Z-check.log`. Build réussi : `test-logs/2026-11-18T23-43-45-136Z-build.log`.
- Trois vérifications finales ciblées : HTTP 413 avec maintien du plafond réduit, poll sans reconstruction de l’historique et bundle reproductible en LF ; `test-logs/optimization-last-regressions.log`. Le plafond réduit reste conservateur jusqu’à un nouvel accord de travail.

Ces résultats ne constituent ni un essai réel de nouveaux groupes ni une validation des achats sur GeoPixels. Dépendances, installation et packaging inchangés : aucun clone supplémentaire.

Les plafonds 600 s / 1 000 cibles / 4 096 confirmations ne s’appliquent pas au nouveau mode. Les dimensions sont admises selon `GEOPLACER_MODEL_MEMORY_MIB` : au moins 64 MiB, au plus la moitié de la RAM ; défaut au plus 1 GiB et un quart de la RAM. L’estimation réserve 64 octets par pixel, sans garantir la mémoire totale du processus. Cache et index restent en RAM ; mémoire/disque insuffisants arrêtent les nouvelles réservations. Ce n’est pas un stockage entièrement paginé. Les paquets restent limités à 65 536 valeurs ; les réponses du lecteur restent bornées. Le dashboard présente les 200 dernières destinations avec compteurs cumulés.

Les confirmations sont enregistrées en segments immuables chaînés SHA-256, à côté du journal existant. La migration conserve `connector-confirmations/legacy-v1.json`. Sauvegarder/restaurer ensemble **tout le dossier `connector-confirmations`, `connector-batch.json` et le journal**. Une chaîne incohérente bloque l’écriture. Les anciennes versions ne lisent pas le manifeste v2 : un retour arrière exige une copie indépendante d’une sauvegarde compatible, sans mélanger ancien manifeste et journal récent.

## Vérifications antérieures — lecteur 1.0.0

| Contrôle | Résultat |
|---|---|
| Contrôle complet | 1 081 tests réussis ; un facultatif ignoré ; types et lints validés |
| Dessin complet factice | 400 pixels / 80 groupes ; 600 pixels sur trois régions / 122 groupes partiellement remplis aux bords |
| Fiabilité | Attente d’énergie, pause/arrêt, perte de réponse, reprise sans doublon, révocation |
| Limites remplacées | Prévisualisation de 1 500 cibles ; image large de 5 000 pixels ; restauration de 5 001 confirmations |
| Lecture initiale | 256 positions transmises pour un modèle large de 100 000 pixels ; aucune fausse capture complète |
| Navigateurs | Edge : simulateur/fournisseur factice et mode simple ; Firefox : parcours HTTP et mode simple, sans erreur de page ni requête externe |
| Connexion prolongée | Une heure avec horloge contrôlée ; aucun renouvellement après retrait d’accord |

Journal complet : `test-logs/2026-11-18T20-20-44-528Z-check.log`. Après le dernier ajustement de l’interface, lint frontend sans avertissement et build avec types validés : `test-logs/2026-11-18T20-33-52-132Z-build.log`. Journaux des recettes : `test-logs/autonomous-edge-delivery.log` (simulateur/factice), `test-logs/autonomous-edge-http-delivery.log` et `test-logs/autonomous-firefox-delivery.log` (HTTP final). Les recettes navigateur utilisent une page factice et une API GM simulée ; elles ne valident pas Tampermonkey sur le site réel.

Correctif d’import : 11 tests du dessin autonome réussis, dont quatre cas de reprise/import (55 confirmations conservées, brouillon non autorisé, pause et résultat incertain), types et lints validés. Journal : `test-logs/import-fix-all-drawing-tests.log`. Build : `test-logs/2026-11-18T21-20-27-021Z-build.log`. Recette ciblée : `node scripts/recette-connecteur.mjs test-logs/import-fix/edge --import-only` (page locale uniquement).

Aucun clone supplémentaire : installation, dépendances et archives Windows inchangées. Les données de votre serveur n’ont pas été utilisées ni migrées pendant les tests.

## Prochain essai réel — lecteur 1.1.0

Arrêter le travail précédent, redémarrer GeoPlacer et installer le lecteur proposé dans le tableau de bord, puis refaire le couplage. Garder une petite zone connue, fixer **16 pixels maximum**, taille cible **16**, améliorations **désactivées**. Vérifier le PNG, le rectangle et les couleurs. **Attendre l’accord explicite de l’utilisateur sur ces destinations avant de lancer.** Relever les requêtes acceptées, les pixels observés et les preuves de tuiles. Tester l’arrêt et la révocation avant d’augmenter la taille du groupe.

Les achats feront l’objet d’un essai distinct : une seule recharge, budget 10 monnaies et réserve vérifiée, avec accord préalable explicite. Ni cet achat ni les groupes supérieurs à cinq n’ont été exécutés pendant le développement.
