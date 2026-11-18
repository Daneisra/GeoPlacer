# Phase 2G — petits lots contrôlés

Base : `8ae96b1da47ef26baee1b0c14e4d411e8459d50c` (2F validée). Branche locale : `feat/phase2g-controlled-batch`. Lecteur : **0.6.0**. Application : `6.0.0-rc.1`, sans tag ni release.

## Fonctionnement obtenu

- **Préparer le lot** sélectionne entre 1 et 5 cibles connues incorrectes avec le WorkPlanner existant. Le tableau expose leurs coordonnées natives et couleurs ; aucune requête au site n’est encore envoyée.
- **Autoriser et démarrer le lot** approuve cette liste exacte (identifiant + empreinte), pour deux minutes maximum. Une seule opération à la fois, avec au moins une seconde entre deux envois terminés. Aucun achat ni compte supplémentaire.
- Le TaskScheduler existant orchestre une projection de travail bornée du modèle sélectionné, sans modifier son image enregistrée. Il utilise le même AttemptManager/Journal et ResourceManager que le port écrivain 2F. Les verrous interdisent l’exécution simultanée avec le moteur de simulation ou le fournisseur factice principal. Aucun algorithme d’ordonnancement n’est dupliqué dans le navigateur.
- Chaque réservation et démarrage est journalisé durablement ; sa correspondance avec le lot est sauvegardée **avant** livraison au navigateur. Le navigateur prend chaque commande au plus une fois. Le serveur acquitte le résultat après fermeture durable de la tentative.
- Avant chaque envoi : cible encore observée depuis moins de 30 s, autorisation active, canal/session, modèle, position et couche inchangés ; dans la page : énergie disponible, couleur réellement possédée, file native vide et absence de placement natif concurrent. L’endpoint et le corps natifs vérifiés en 2F restent identiques, avec un seul pixel par requête.
- **Pause** interdit les nouveaux envois et laisse terminer une requête déjà partie. **Reprendre** reprend le même lot avant expiration, sans élargir son périmètre. **Arrêter** retire immédiatement l’autorisation ; il ne peut annuler un envoi déjà parti.
- Une réponse manquante ou ambiguë arrête le lot : réservation incertaine conservée, aucun renvoi aveugle. Un redémarrage conserve les confirmations et exige une nouvelle autorisation des seules cibles restantes ; aucune autorisation n’est restaurée automatiquement.

## Confirmation, observation et sécurité

`connector-batch.json` conserve la liste approuvée et les références des tentatives ; le journal reste l’autorité sur leurs résultats. Les confirmations, y compris l’ancien pixel 2F, excluent leurs cibles d’une nouvelle sélection sur un cache ancien. L’identité inclut le **mode du fournisseur** : un succès factice ne compte jamais comme un placement réel. La migration de l’intention 2F conserve son modèle et sa position d’origine, même si le fantôme a ensuite été déplacé. Une archive de confirmations incomplète bloque les écritures plutôt que perdre cette protection.

Le dashboard sépare **envois confirmés** et **progression observée**. Aucun accusé ne modifie artificiellement le cache. L’expiration de chaque pixel à 30 s et l’incertitude sur la fraîcheur source restent inchangées. Un transparent observé est connu ; une tuile absente reste inconnue. Les ressources affichées restent celles du lecteur, éventuellement anciennes ou non datées. Le quota du ResourceManager pour le lot est une autorisation locale, pas l’énergie du compte.

Le navigateur garde ses identifiants de session ; aucune donnée d’authentification GeoPixels n’est envoyée au serveur local. Le transport conserve l’approbation privée, la capacité éphémère, la révocation, les schémas stricts et l’expiration absolue du couplage à dix minutes. Le lecteur passif ne récupère aucune tuile et ne possède aucun planificateur de peinture. L’ancien essai unitaire est conservé dans les options.

## Vérifications locales

- Tests ciblés : enchaînement de cinq cibles distinctes, cache ancien, pause/reprise, refus avant envoi, réponse perdue, arrêt avant/après livraison, résultat tardif, expiration, changement de contexte et redémarrage.
- Tests de séparation factice/réel, import d’une intention 2F après déplacement du fantôme et blocage si les métadonnées de confirmation manquent.
- Écrivain navigateur testé avec cinq requêtes factices sans dialogue individuel ; contrôle de l’énergie, des couleurs, de la session, du périmètre et de l’anti-doublon.
- Parcours HTTP avec API réelle locale : clé/capacité obligatoires, empreinte exacte, champs inconnus refusés, livraison unique, résultat durable et accusé idempotent.
- Recettes **Edge et Firefox locales** : cinq envois séquentiels après un clic, zéro dialogue individuel, progression inchangée jusqu’à recapture, déconnexion et révocation. Les appels `/PlacePixels` sont remplacés par un stub ; les autres requêtes externes sont bloquées. L’API GM est simulée par Node, pas un Tampermonkey réel.

**Contrôle complet initial réussi : 990 tests, un facultatif ignoré** (Jest 172 ; Vitest : adapters-node 66, core 388 + 1 ignoré, engine-service 313, simulator 51). `npm.cmd run check:logged` inclut types et lints, sans erreur ; les 47 avertissements backend historiques restent présents. Les deux correctifs de fin de revue (séparation factice/réel et migration 2F) sont couverts. Les 13 tests ciblés du lot passent aussi après le dernier garde-fou de capacité ; les composants du panneau ont été relintés après la distinction des confirmations factices.

Journaux conservés localement (ignorés par Git) :

- Contrôle complet : `test-logs/2026-11-18T10-52-48-292Z-check.log`.
- Build après le contrôle complet : `test-logs/2026-11-18T10-59-08-049Z-build.log` (**réussi**).
- Tests ciblés : `test-logs/phase2g-batch-delivery.log`, `phase2g-mode-isolation.log`, `phase2g-migration.log`, `phase2g-reader-final.log` ; parcours HTTP intégré au test Jest `single-pixel-channel.test.ts`.
- Recettes : `test-logs/phase2g/edge-final/recipe.log` et `test-logs/phase2g/firefox/recipe.log`, avec captures et diagnostics locaux. Le parcours navigateur 0.6.0 est complété par les tests ciblés de migration et d’isolation exécutés sur le code final.

Aucun clone ou benchmark supplémentaire : installation, dépendances et packaging inchangés.

## Limites et premier essai utilisateur

**L’agent n’a déclenché aucun placement réel.** L’utilisateur a ensuite exécuté un premier lot : sa validation est **partielle**, détaillée ci-dessous. La validation réelle unitaire 2F reste acquise ; elle ne prouve pas le fonctionnement complet d’un lot.

Le cache réel actuel n’est pas daté par sa source : il ne peut pas lever une incertitude d’exécution. La réconciliation exige une observation source datée postérieure à l’interruption. Les confirmations restent exclues pour cette identité ; leur remise en jeu après une modification externe relève d’une future maintenance fondée sur des observations fiables. L’archive est bornée à 4 096 références ; un registre plein bloque les nouveaux lots sans purge automatique. Le budget navigateur est conservateur et ne crédite pas la régénération pendant l’essai ; recharger si nécessaire avant un nouveau lot.

Recette courte :

1. Redémarrer GeoPlacer, installer le lecteur **0.6.0**, coupler, observer et lier le modèle voulu (fixture 8 × 5 disponible).
2. Garder **5** puis cliquer **Préparer le lot** ; vérifier les cinq lignes, le modèle, la position et la couche. **S’arrêter avant l’autorisation** et faire approuver explicitement ce lot et ses destinations par l’utilisateur.
3. Après cet accord seulement : **Autoriser et démarrer le lot**. Les envois s’enchaînent ; les boutons pause, reprise et arrêt restent disponibles.
4. Relire les confirmations puis **Observer le modèle** pour mesurer séparément le résultat ; arrêter et révoquer le canal.

Procédure et limites : [guide du lecteur](phase2c-lecteur-http.md#premier-lot-réel--cinq-pixels-maximum-phase-2g).

Revue initiale des 21 fichiers : aucun fichier de configuration privée, donnée applicative, archive ou secret détecté dans les fichiers inclus ; licence et attributions inchangées. `git diff --check` réussi avec la configuration de fins de ligne du dépôt.

Aucun push, changement de main, tag, release, nettoyage, achat ou création de compte. Toute nouvelle écriture exige un nouveau lot et un accord explicite. La priorité après le retour ci-dessous est de comparer les cinq destinations observées, sans renvoi automatique.


## Retour utilisateur — validation réelle partielle (18 novembre 2026)

L’utilisateur confirme que le lot s’est exécuté, mais signale **un pixel blanc manquant**. Les captures montrent cinq réponses acceptées par le parcours d’envoi. Après une nouvelle observation demandée sans placement supplémentaire, l’utilisateur confirme **5 corrects, 33 incorrects, 0 inconnu**, dont le pixel noir déjà posé en 2F : cela correspond à **quatre nouvelles cibles conformes**, et ne valide donc pas cinq placements effectifs. La fraîcheur source reste non vérifiée. La cause (application côté service, cache, modification concurrente ou autre) n’est pas déterminée ; aucun renvoi correctif n’est déclenché.

Le correctif sépare la réponse d’envoi de l’observation pour chacune des cinq destinations. Le panneau affiche « Envois terminés — résultat à observer », les réponses `Ok`, puis une colonne « Observation du cache » : conforme, différente, inconnue/expirée ou à réobserver après envoi. Une capture antérieure à l’accusé ne valide pas le résultat. Les confirmations et les exclusions durables restent intactes : une différence observée ne déclenche aucun nouvel envoi.

L’utilisateur précise également le fonctionnement natif : on peut préparer plusieurs pixels puis cliquer une fois sur **Paint**. Vérification ciblée du [frontend public historique, `placePixels`, lignes 1703–1780](https://github.com/AntCDev/GeoPixelsFront/blob/83673896886c016a3d23bd46a2309570194a19da/wwwroot/js/index.js#L1703) : il construit `pixelsToSend` depuis la file et transmet tout le tableau `Pixels` dans une requête `/PlacePixels`. La réponse testée est globale (`Ok`), sans résultat individuel. Ce contrat confirme l’envoi groupé, sans établir un nombre illimité ni une atomicité serveur. La Phase 2G reste séquentielle ; passer à une seule requête groupée nécessitera de traiter l’incertitude du groupe entier et de conserver la vérification des cibles. Aucun changement du transport d’écriture n’est inclus dans ce correctif.


### Vérification du correctif de lecture

- 58 tests ciblés réussis (lots, écrivain unitaire, intégration moteur, canal HTTP), dont le cas cinq accusés/quatre conformités, capture antérieure à l’accusé, expiration et déconnexion : `test-logs/phase2g-observation-regression.log`.
- Packages compilés, lints des fichiers concernés et frontend sans erreur ; build réussi : `test-logs/2026-11-18T12-39-28-858Z-build.log`.
- Le lecteur **0.6.0** et le transport de placement sont inchangés. Redémarrer GeoPlacer puis coupler/réobserver le même modèle pour renseigner les nouvelles colonnes ; aucun placement n’est nécessaire.
- Recette Edge locale réussie avec cinq accusés/quatre cibles conformes, puis une cinquième conformité après une nouvelle lecture, **sans nouvel envoi** : `test-logs/phase2g/observed-discrepancy-edge/recipe.log`. Aucun accès au service réel ; API GM simulée et placements factices.
