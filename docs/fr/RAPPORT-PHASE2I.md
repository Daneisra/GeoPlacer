# Phase 2I — dessin automatique supervisé

Base : `4a71b60e3e1a6c7ab570fba48c56040d2117f2dc` (2H validée). Branche locale : `feat/phase2i-supervised-session`. Lecteur **0.8.0** ; version applicative `6.0.0-rc.1` inchangée. Aucun placement réel effectué par l’agent.

## Session bornée obtenue

Le dashboard propose **Session supervisée — 25 pixels maximum**, avec deux budgets explicites : pixels et énergie, chacun entre 1 et 25. La prévisualisation utilise WorkPlanner pour choisir une liste fermée de cibles connues incorrectes, au plus le minimum des deux budgets et des cibles disponibles. Le tableau expose toutes leurs coordonnées et couleurs, ainsi que le coût maximal réel du périmètre préparé. Par exemple, 25 pixels / 12 énergie prépare au plus 12 destinations.

Un clic sur **Autoriser et démarrer la session** approuve l’identifiant et l’empreinte incluant cette liste et ses budgets. Le **TaskScheduler existant** enchaîne les groupes natifs de cinq maximum, avec une seconde minimum entre deux groupes terminés. Aucun nouveau planificateur ni sélection de nouvelles destinations en cours de session. Les modes groupé unique et séquentiel 2H restent disponibles pour d’autres lots explicitement autorisés.

Chaque groupe garde sa réservation et son démarrage durables dans AttemptManager/Journal, plus les références de ses cibles avant livraison au navigateur. ResourceManager suit uniquement le quota local d’autorisation ; il ne prétend pas représenter les ressources du compte. Les cibles acquittées sont exclues des sélections suivantes, même si un cache ancien est relu. La même simulation et le même fournisseur factice sont conservés.

## Énergie, observations et sécurité

Avant chaque groupe, le moteur vérifie le contexte lié, le canal et une observation exploitable de chaque cible. Le navigateur revérifie la session, le modèle, sa position, la couche de base, les couleurs possédées, l’énergie disponible et la file native vide. Chaque requête contient cinq cibles maximum et doit rester dans la liste approuvée.

Le lecteur vérifie aussi le budget cumulé de la session et fige son périmètre ; une réponse incertaine consomme conservativement son autorisation de transmission. Il conserve le plafond énergétique de la page diminué des envois effectués : **aucune régénération n’est créditée automatiquement**, même si le compteur de la page remonte. Un refus avant envoi met la session en pause. Une reprise est possible après vérification des ressources, dans la limite du budget conservateur initial et avant expiration ; si ce plafond est épuisé, recharger et refaire une autorisation adaptée plutôt qu’inventer de l’énergie.

Une capture récente du cache ne prouve toujours pas une actualisation côté serveur. L’expiration par pixel reste de 30 secondes ; une région inconnue reste inconnue et n’est pas assimilée à une zone incorrecte. Des cibles devenues conformes peuvent ne plus nécessiter d’envoi ; elles ne sont pas ajoutées aux compteurs d’acceptation. Le panneau distingue requêtes acceptées, cibles couvertes par leurs accusés et couleurs observées après envoi. Aucun accusé ne modifie le cache.

Les identifiants du site restent dans le navigateur. Même transport HTTP privilégié, approbation volontaire, permissions minimales, capacités éphémères, révocation et schémas stricts. Une session exige **readerVersion 7 / batchProtocol 3**, négociés par 0.8.0 ; les lecteurs plus anciens gardent leurs fonctions compatibles. Le couplage conserve sa limite absolue de dix minutes, la session son autorisation absolue de **deux minutes**, sans renouvellement silencieux.

## Interruptions et historique

Pause interdit les nouveaux envois ; une requête déjà partie peut terminer. Reprendre conserve le même périmètre et la même échéance. Arrêter retire l’autorisation, sans pouvoir annuler une requête déjà partie sur le service. Une course entre arrêt et transmission, après démarrage durable, a été testée et corrigée pour traiter une opération non livrée comme un refus connu plutôt que créer une fausse incertitude.

Un résultat ambigu bloque la suite et conserve tout le groupe en réconciliation, sans renvoi automatique ni passage en repli. Un cache non daté ne suffit pas à lever cette incertitude. Au redémarrage, les références et l’historique survivent mais aucune autorisation n’est restaurée : un nouvel accord porte sur le même périmètre, en excluant les cibles déjà acquittées. Après arrêt volontaire, une nouvelle préparation exige une nouvelle autorisation.

Le dashboard affiche les groupes de la session (jusqu’aux 50 dernières opérations), leur date de démarrage, nombre de cibles et résultat. Ces états proviennent du journal existant, pas d’un second historique d’exécution. L’archive conserve les références antérieures dans sa limite existante de 4 096 entrées ; aucun nettoyage n’est effectué.

## Validation locale

Les tests couvrent 25 cibles distinctes / cinq groupes, un dernier groupe réduit (12 cibles : 5 + 5 + 2), budgets invalides, absence de nouvelle sélection sur cache ancien, refus énergétique, reprise contrôlée sans renouvellement, arrêt avant transmission, réponse perdue, résultat tardif, blocage du groupe et redémarrage après dix cibles acquittées. Le navigateur factice teste aussi l’absence de crédit de régénération. Le parcours HTTP vérifie le budget obligatoire, la négociation 0.8.0 et le consentement scellé.

Résultats :

- Contrôle complet `npm.cmd run check:logged` réussi : **1 020 tests réussis, un facultatif ignoré** (Jest 172 ; Vitest : adapters-node 66, core 388 + 1 ignoré, engine-service 343, simulator 51). Types et lints sans erreur ; 47 avertissements backend historiques conservés. Journal : `test-logs/2026-11-18T14-07-37-580Z-check.log`.
- **30 tests ciblés de lots/sessions réussis**, incluant le scénario complémentaire d’arrêt entre démarrage durable et publication : `test-logs/phase2i-session-final.log`. Types et lint revérifiés après ce complément. Les 92 tests ciblés précédents couvrent aussi l’écrivain navigateur et le transport HTTP (`test-logs/phase2i-targeted.log`).
- Build après le contrôle complet réussi : `test-logs/2026-11-18T14-17-30-107Z-build.log`.
- Recettes **Edge et Firefox locales réussies** : `test-logs/phase2i/edge-final/recipe.log` et `test-logs/phase2i/firefox/recipe.log`. Une approbation, un refus énergétique connu sans envoi, une reprise explicite, cinq groupes automatiques et 25 cibles distinctes ; les 25 conformités ne sont comptées qu’après nouvelle observation. L’historique conserve également le groupe refusé. Aucune erreur de page ni requête externe.
- Les placements sont des stubs locaux et l’API GM est simulée par Node ; aucune validation Tampermonkey réelle de la session n’est revendiquée. Installation, dépendances et packaging inchangés : pas de clone neuf, audit ni benchmark supplémentaire. `git diff --check` réussi ; licence et attributions conservées.

## Recette réelle — accord requis pour chaque nouvelle session

1. Redémarrer GeoPlacer, installer **0.8.0**, coupler, observer puis lier le modèle souhaité. Arrêter les autres bots et garder la file native vide.
2. Choisir **Session supervisée**, budgets **25 pixels / 25 énergie**, puis **Prévisualiser la session**. Vérifier les destinations exactes, couleurs, nombre de cibles réellement préparées et coût. **S’arrêter ici : attendre l’accord explicite de l’utilisateur sur cette liste.**
3. Après cet accord seulement, cliquer **Autoriser et démarrer la session** une fois. Pour 25 cibles toujours incorrectes et suffisamment d’énergie : cinq requêtes au maximum de cinq pixels chacune, sans clic entre groupes. Pause/reprise/arrêt restent disponibles ; aucun nouvel envoi en cas d’incertitude.
4. Observer à nouveau pour contrôler les couleurs, puis arrêter et révoquer le canal. La fraîcheur source reste indiquée séparément ; une couleur absente du cache ne justifie pas un renvoi automatique.

**La première session réelle de 25 pixels est validée par l’utilisateur**, selon les éléments ci-dessous. Chaque nouvelle session conserve ses budgets et son accord explicite. La validation réelle 2H reste acquise pour un groupe de cinq. Aucun push, modification de main, achat, nouveau compte, tag, release ou nettoyage.


## Validation utilisateur réelle — 18 novembre 2026

L’utilisateur confirme « c’est tout bon » et fournit les captures après l’essai de session supervisée :

- Budgets affichés : **25 pixels / 25 énergie**, modèle de test **8 × 5** lié, couche de base.
- **25 / 25 cibles couvertes par un accusé**, **5 requêtes acceptées** ; l’historique affiche cinq opérations.
- Une première capture montre les cibles « À réobserver après envoi » ; la capture suivante affiche **une couleur conforme pour chacune des 25 destinations**, noires et blanches. Les accusés et l’observation restent ainsi distincts.
- Progression globale constatée : **36 corrects, 2 incorrects, 0 inconnu**, sur 38 cibles opaques. Les deux cibles restantes ne sont pas envoyées automatiquement.
- Tentatives incertaines affichées : **0**. Fraîcheur source toujours **non vérifiée** ; la capture ne certifie pas l’âge réel du cache côté service.

Cette confirmation valide, **pour cet essai réalisé par l’utilisateur**, la session bornée et l’enchaînement de cinq groupes avec contrôle ultérieur des 25 couleurs. L’agent n’a effectué aucun placement pour enregistrer ce résultat. Les scénarios de refus énergétique, pause/reprise, arrêt, expiration, réponse perdue et redémarrage restent couverts localement ; ils ne sont pas présentés comme testés sur le service réel lors de cet essai. Aucun changement applicatif ni nouvel envoi n’accompagne cette mise à jour documentaire.
