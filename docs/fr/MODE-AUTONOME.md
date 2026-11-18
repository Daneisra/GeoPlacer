# Dessin autonome supervisé — lecteur 1.0.0

Branche locale `feat/autonomous-drawing`, issue de `e38998f`. Aucun nouvel envoi réel effectué pendant ce développement.

## Utilisation

1. Redémarrer GeoPlacer avec `npm.cmd run start:reader`. Ouvrir directement l’adresse locale affichée et choisir la source GeoPixels. Garder la clé privée de la console pour le dashboard.
2. **Importer l’image**, puis **Télécharger le fantôme pour GeoPixels**. Charger ce même PNG préparé dans l’outil natif du site et le positionner.
3. Installer le lecteur **1.0.0**, désactiver l’ancien et recharger GeoPixels. Garder les autres bots arrêtés et la file manuelle vide.
4. Dans **Connexion au navigateur**, effectuer le couplage : clé privée dans le dashboard uniquement, code temporaire dans le lecteur, comparaison de l’empreinte et confirmation locale. Une première observation de 256 × 256 maximum part automatiquement ; le reste demeure inconnu.
5. La correspondance des pixels RGBA est vérifiée par SHA-256 et le modèle est lié automatiquement. Vérifier l’aperçu, le rectangle natif et le budget, puis **Lancer le dessin**. Surveillance, planification et envois démarrent ensemble.

**Options du dessin** permet de réduire le budget et de régler les groupes entre **1 et 5** pixels. Sans budget personnalisé, le maximum correspond aux cibles opaques. La palette proposée reprend la liste personnelle de 28 couleurs, sans présumer des couleurs débloquées ; la modifier avant l’import si nécessaire. **Réglages avancés** retrouve les anciens parcours et diagnostics.

Pause, reprise, arrêt et révocation restent disponibles. **Préparer la suite** crée une nouvelle prévisualisation après arrêt/terminaison, sans autoriser d’envoi.

## Garanties et limites

- **Travail et transport distincts.** L’accord porte sur un modèle/révision, une image, un contexte, une position, une couche et un budget non extensible. Il dure jusqu’à terminaison, arrêt, révocation ou interruption invalidante. Il n’est jamais restauré actif au redémarrage.
- **Canal renouvelable.** Inactivité maximale : 30 s ; bail de capacité : 10 min. Pendant un travail autonome autorisé ou sa pause, une rotation avant expiration utilise un nonce idempotent, puis une preuve de possession de la nouvelle capacité. Elle conserve contexte, séquences, ressources et accord de travail. Elle ne réactive jamais un accord arrêté/révoqué ou un résultat incertain. Les anciens modes conservent leurs limites.
- **Interruptions.** Les erreurs temporaires de statut peuvent être retentées pendant un bail valide. Aucune prise de commande ni écriture ambiguë n’est renvoyée. Deux accusés d’observation manquants ferment le canal pour séquence incertaine. Coupure longue, rechargement ou redémarrage : nouveau couplage et nouvel accord, avec conservation des confirmations de la même identité. La temporisation du navigateur peut provoquer cet arrêt sûr.
- **Un seul moteur.** Le TaskScheduler existant travaille par vues de 256 × 256 du même modèle. Le lecteur utilise uniquement les tuiles déjà chargées ; aucune récupération automatique. Les pixels absents/expirés restent inconnus, avec expiration à 30 s. Une capture récente d’un cache non daté ne prouve pas sa fraîcheur serveur ; plusieurs régions ne constituent pas un instantané atomique.
- **Énergie observée.** Seules les réponses natives reçues dans le navigateur fournissent un solde exploitable, diminué des envois. Énergie indisponible/expirée/insuffisante : attente d’une preuve utilisable. Aucune régénération estimée, achat ou transmission de session.
- **Taille des groupes.** Cinq reste le maximum réellement validé par les essais utilisateurs 2H–2J. Le tableau `Pixels` du frontend ne prouve pas une capacité serveur supérieure.

Les plafonds 600 s / 1 000 cibles / 4 096 confirmations ne s’appliquent pas au nouveau mode. Les dimensions sont admises selon `GEOPLACER_MODEL_MEMORY_MIB` : au moins 64 MiB, au plus la moitié de la RAM ; défaut au plus 1 GiB et un quart de la RAM. L’estimation réserve 64 octets par pixel, sans garantir la mémoire totale du processus. Cache et index restent en RAM ; mémoire/disque insuffisants arrêtent les nouvelles réservations. Ce n’est pas un stockage entièrement paginé. Les paquets restent limités à 65 536 valeurs ; les réponses du lecteur restent bornées. Le dashboard présente les 200 dernières destinations avec compteurs cumulés.

Les confirmations sont enregistrées en segments immuables chaînés SHA-256, à côté du journal existant. La migration conserve `connector-confirmations/legacy-v1.json`. Sauvegarder/restaurer ensemble **tout le dossier `connector-confirmations`, `connector-batch.json` et le journal**. Une chaîne incohérente bloque l’écriture. Les anciennes versions ne lisent pas le manifeste v2 : un retour arrière exige une copie indépendante d’une sauvegarde compatible, sans mélanger ancien manifeste et journal récent.

## Vérifications locales

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

Aucun clone supplémentaire : installation, dépendances et archives Windows inchangées. Les données de votre serveur n’ont pas été utilisées ni migrées pendant les tests.

## Prochain essai réel

Garder un petit modèle connu, limiter le budget à **20 pixels**, groupes de cinq, puis vérifier l’image, ses couleurs et le rectangle affiché. **Attendre l’accord explicite de l’utilisateur sur cette destination avant de lancer.** Après quatre requêtes maximum, observer à nouveau et distinguer accusés reçus et couleurs réellement présentes dans le cache. Tester ensuite arrêt et révocation.
