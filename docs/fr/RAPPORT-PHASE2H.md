# Phase 2H — envoi groupé natif

Base validée : `d5f95ca2325d2897b6aa503e706695bad7156e63` (2G). Branche locale : `feat/phase2h-native-batch`. Lecteur **0.7.0** ; version applicative `6.0.0-rc.1` inchangée. Aucun envoi réel effectué par l’agent.

## Fonctionnement

Le sélecteur propose **Groupé natif — une requête** et **Séquentiel — solution de repli**. La taille est configurable de **1 à 5 pixels**. Avant autorisation, le tableau affiche les destinations natives, couleurs et le coût maximal : un point d’énergie par cible. Le mode fait partie de l’empreinte approuvée ; le changer exige d’arrêter puis de préparer un nouveau lot.

Le mode groupé utilise le **WorkPlanner et le TaskScheduler existants**, avec une seule tentative contenant toutes les cibles restantes du groupe. AttemptManager réserve le coût complet ; son journal durable et les références par cible sont écrits avant que la commande puisse être livrée. Le même port écrivain et le même ResourceManager d’autorisation locale sont conservés. Aucun moteur supplémentaire.

Le navigateur reçoit une commande structurée de protocole 2 et envoie **un seul `POST /PlacePixels` avec le tableau `Pixels` complet**. Il vérifie toutes les couleurs, l’énergie nécessaire à l’ensemble, la session, le modèle, la position, la couche de base, la file native vide et l’autorisation encore active. L’endpoint reste fixe ; aucun achat, proxy arbitraire, récupération de tuiles ou transfert d’identifiants de session au serveur local.

Le groupe préparé n’est pas réduit silencieusement si certaines cibles deviennent correctes ou inconnues avant l’exécution : la tentative partielle est annulée avant démarrage, le lot bloqué et une nouvelle préparation demandée. Chaque cible garde sa limite d’observation de 30 secondes. L’autorisation dure deux minutes ; le couplage garde sa limite absolue de dix minutes.

## Limites vérifiées

Référence ciblée : frontend public [GeoPixelsFront `83673896886c016a3d23bd46a2309570194a19da`, `index.js`](https://github.com/AntCDev/GeoPixelsFront/blob/83673896886c016a3d23bd46a2309570194a19da/wwwroot/js/index.js#L1703), contrat de production reconnu en 2C/2F. `placePixels` transmet le tableau de la file, teste la réponse globale `Ok` et soustrait le nombre de pixels à l’énergie. L’activation du bouton dépend du nombre de cibles et de l’énergie disponible (ligne 3686) ; l’ajout à la file vérifie aussi capacité et énergie (lignes 3985–3989).

Le frontend ne démontre **ni plafond serveur absolu ni atomicité par pixel**. Le maximum de cinq est donc un plafond **local conservateur testé**, pas une limite officielle de GeoPixels. L’énergie du compte doit suffire au groupe entier ; aucune régénération ou dépense incertaine n’est créditée automatiquement par le budget navigateur. Les ressources affichées par le lecteur peuvent rester non datées ou anciennes. Le quota ResourceManager ne représente pas l’énergie réelle du compte.

## Accusés, incertitude et reprise

Une réponse globale `Ok` signifie **une requête acceptée couvrant N cibles**. Les résultats `applied` du port historique servent ici à clôturer la tentative et son quota local sur cet accusé ; ils ne constituent pas une preuve de la couleur de chaque pixel. Le panneau et le lecteur distinguent désormais le nombre de requêtes acceptées, les cibles couvertes par l’accusé et les couleurs réellement observées. La comparaison par cible introduite en 2G est conservée, avec date de capture postérieure à l’accusé et fraîcheur source indiquée séparément.

Une réponse perdue ou ambiguë conserve **toute la tentative et toutes ses cibles** en réconciliation. Aucun renvoi, ni conversion automatique en séquentiel. La réconciliation exige une source datée postérieure à l’interruption pour chacune des cibles ; une couverture partielle ou un cache non daté ne suffit pas. La reprise après redémarrage restaure les références et confirmations, jamais l’autorisation. Un groupe préparé sans exécution exige un nouvel accord.

Pause/arrêt avant livraison empêchent l’envoi. Après le départ de la requête, ces commandes ne peuvent pas annuler son application sur le serveur ; une réponse absente laisse tout le groupe incertain. Une course détectée dans le repli séquentiel (pause entre démarrage durable et transmission) a été corrigée : le port refuse alors sans envoi, sans inventer d’incertitude, et le scheduler se met en pause normalement.

## Compatibilité et validation locale

Le lecteur 0.7.0 négocie `readerVersion: 6` / `batchProtocol: 2`. Les lecteurs 0.6.0 conservent le protocole séquentiel ; le serveur refuse de leur confier une commande groupée. Les archives 2G sans champ de mode restent séquentielles et conservent leur empreinte. Aucun changement de dépendances, d’installation ou de packaging ne nécessite un clone neuf.

Les tests couvrent : groupe de cinq en une tentative, comparaison avec cinq envois séquentiels, coût et limites, périmètre strict, énergie insuffisante, couleur absente, commande malformée, refus global, pause, arrêt d’une requête, réponse perdue, blocage de tout le groupe après redémarrage, autorisation non restaurée, anciennes archives, observations partielles et absence de renvoi. Le parcours HTTP vérifie les permissions, la négociation de version et le maintien du repli après un refus connu.

Résultats :

- `npm.cmd run check:logged` réussi : **1 011 tests réussis, un facultatif ignoré** (Jest 172 ; Vitest : adapters-node 66, core 388 + 1 ignoré, engine-service 334, simulator 51), types et lints sans erreur ; 47 avertissements backend historiques inchangés. Journal : `test-logs/2026-11-18T13-24-21-355Z-check.log`.
- **24 tests de lots réussis** après ajout d’un scénario complémentaire exigeant la couverture datée de chaque cible avant réconciliation ; types des tests et lint revérifiés. Journal : `test-logs/phase2h-groups-final.log`. Les tests navigateur de l’écrivain et du protocole font aussi partie du contrôle complet.
- Recettes locales **Edge et Firefox réussies**, sans erreur de page ni requête externe : `test-logs/phase2h/edge/recipe.log` et `test-logs/phase2h/firefox/recipe.log`. Comparaison observée : cinq requêtes séquentielles contre une requête groupée, même coût de cinq autorisations et même ensemble de cibles ; un accusé de groupe reste distinct de quatre couleurs conformes observées. Aucun benchmark général ni promesse absolue de vitesse.
- Le site est une fixture locale ; les appels de placement sont des stubs et l’API GM est simulée par Node. Aucun test Tampermonkey sur le vrai site n’est revendiqué.
- Build de clôture réussi après le contrôle complet : `test-logs/2026-11-18T13-32-52-553Z-build.log`. `git diff --check` vérifié avant commit ; aucune dépendance ni attribution modifiée.

## Recette réelle — chaque nouveau lot exige un accord

1. Redémarrer GeoPlacer, installer **0.7.0**, coupler puis observer et lier le modèle souhaité. Garder les autres bots arrêtés et la file native vide.
2. Choisir **Groupé natif**, limite **5**, puis **Préparer le lot**. Vérifier ses cinq destinations, couleurs et coût maximal **5 énergie**. **S’arrêter ici jusqu’à l’accord explicite de l’utilisateur sur ce lot précis.**
3. Après cet accord seulement : **Autoriser et démarrer le lot**. Attendu : **1 requête acceptée / 5 cibles couvertes**, puis contrôle par une nouvelle observation. Un délai d’actualisation est possible, comme lors de la validation 2G ; une couleur absente du cache ne justifie pas de renvoi automatique.
4. Arrêter et révoquer le canal. Tout résultat ambigu bloque le groupe ; ne pas le renvoyer via le mode de repli.

**Le premier lot groupé réel de cinq pixels est validé par l’utilisateur**, selon les éléments ci-dessous. Chaque nouveau lot reste soumis à son accord. Aucun push, modification de main, tag, release, achat, nettoyage ou création de compte.


## Validation utilisateur réelle — 18 novembre 2026

L’utilisateur confirme « c’est tout bon » et fournit les captures de GeoPixels et du dashboard après l’essai :

- Mode **Groupé natif — une requête**, cinq cibles sur la couche de base : trois blanches (`#ffffff`) et deux noires (`#000000`).
- Dashboard : **1 requête acceptée**, **5 / 5 cibles couvertes par un accusé**.
- Comparaison du cache après envoi : **5 conformes, 0 différente, 0 à observer de nouveau** ; chacune des cinq lignes indique une couleur conforme.
- Progression globale du modèle : **11 corrects, 27 incorrects, 0 inconnu**, sur ses 38 cibles opaques.

Cela valide le parcours réel de ce lot de cinq cibles, exécuté volontairement **par l’utilisateur**. Aucun placement n’a été déclenché par l’agent pour consigner ce résultat. La fraîcheur source reste **non vérifiée**, comme indiqué sur la capture : l’acceptation de la requête et les couleurs observées restent distinctes. Les interruptions, pertes de réponse et reprises restent validées localement sur fournisseurs factices ; cet essai ne certifie pas des groupes plus grands ni tous les cas d’erreur réels.
