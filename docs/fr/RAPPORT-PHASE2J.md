# Phase 2J — dessin continu supervisé

18 novembre 2026. Base : `3405e6e` (2I validée). Branche : `feat/phase2j-continuous-drawing`. Modifications et commits locaux uniquement ; main et les remotes sont inchangés.

## Fonctionnement

- Autorisation scellée : modèle/révision/position/couche, rectangle image, durée 30–600 s, budgets pixels/énergie 1–1 000. Prévisualisation des coins natifs et du coût maximal avant un unique accord.
- Le **TaskScheduler existant** sélectionne dynamiquement les pixels incorrects connus avec WorkPlanner. Groupes natifs de cinq maximum. `watchOnIdle` garde ce scheduler en attente lorsqu’aucun travail exploitable n’est visible ; le simulateur conserve son comportement par défaut.
- AttemptManager/Journal réserve et démarre durablement chaque groupe ; `connector-batch.json` conserve le périmètre et les références. Les confirmations antérieures excluent leurs cibles, y compris après redémarrage ou relecture d’un ancien cache. Les inconnus ne deviennent jamais des cibles incorrectes par défaut.
- Pause/reprise sans renouvellement, arrêt, échéance absolue et révocation conservés. Un résultat incertain bloque la suite ; aucune redélivrance de commande, aucun renvoi automatique. Au redémarrage : pas d’autorisation ni d’énergie exploitable restaurée ; reprise par nouvel accord uniquement.
- Dashboard : zone, durée, quotas consommés/réservés, énergie exploitable datée ou indisponible, attente d’observations/ressources, progression du rectangle et historique des groupes. Accusés de requête et conformité du cache restent distincts. Modes 2F–2I conservés.

## Énergie et contrat navigateur

Lecteur **0.9.0**, négociation `readerVersion:8` / `batchProtocol:4`. Référence ciblée : [GeoPixelsFront 8367389](https://github.com/AntCDev/GeoPixelsFront/tree/83673896886c016a3d23bd46a2309570194a19da), `wwwroot/js/index.js` (`syncWorker`, `synchronize`, mise à jour périodique de `currentEnergy`) et `wwwroot/js/sync-worker.js` (réponse native après `/GetUserData`). Aucun nouvel audit de l’écosystème.

`browser/geopixels-energy.js` écoute les réponses du worker natif et transmet uniquement un schéma strict de sept champs publics de ressources. Les arguments sensibles de `postMessage` sont transmis inchangés à la fonction native, jamais conservés ni exportés par ce module. Aucune requête supplémentaire au service. La session reste dans le navigateur ; permissions GM et couplage local inchangés. Ces données sont déclarées par le connecteur approuvé, sans attestation cryptographique de leur origine.

Le solde brut est diminué des envois connus/engagés. Une hausse du compteur animé ne crédite rien. Seule une nouvelle réponse native compatible, initiée après les envois précédents, peut apporter un solde renouvelé ; les réponses retardées, incompatibles, périmées ou désordonnées sont écartées. Source absente ou énergie insuffisante : attente via le scheduler existant. Les contrôles de session, file native, couleur, modèle et autorisation sont revérifiés dans le navigateur avant chaque requête.

Les dates de requête/réception des ressources ne prouvent pas une fraîcheur serveur de la toile. Cache non daté, couverture partielle et expiration des pixels à 30 s restent indiqués séparément. La limite absolue du couplage de dix minutes n’est pas prolongée par cette phase.

## Vérifications locales

- `npm.cmd run check:logged` : **1 059 réussis, 1 facultatif ignoré**. Jest 172 ; Vitest : adapters-node 66, core 388 + 1 ignoré, engine-service 381, simulator 52. Types et lints valides ; 47 avertissements backend historiques, aucun nouveau défaut de lint. Journal complet : `test-logs/2026-11-18T15-50-34-033Z-check.log`.
- Build après le contrôle : réussi, `test-logs/2026-11-18T15-55-51-444Z-build.log`. L’avertissement Vite préexistant concernant `NODE_ENV` dans `.env` reste visible ; compilation terminée avec code 0.
- **29 tests ciblés continuité/énergie réussis** (`test-logs/phase2j-targeted-final.log`) ; le contrôle complet couvre également les 12 scénarios HTTP de sécurité, les autres modes d’écriture et la simulation.
- Recettes Edge et Firefox locales réussies : `test-logs/phase2j/edge/recipe.log`, `test-logs/phase2j/firefox/recipe.log`. Dernière recette Edge après le build et avec le PNG livré : réussie, `test-logs/phase2j/edge-final/recipe.log`. Aucun appel externe ni erreur de page ; captures d’écran locales dans ces dossiers.
- Le contrôle initial a révélé des mocks/traductions à adapter et un résumé de confirmations trop coûteux sur plusieurs centaines de cibles. Les résumés utilisent maintenant des index au lieu de scans répétés. Le test volumineux détecte dix secondes sans progression, sous la limite totale de test de 30 s existante ; aucun délai applicatif n’a été augmenté. Les journaux des passages échoués sont conservés.
- `git diff --check` valide, licence/attributions conservées, recherche de secrets négative. Aucun changement de dépendance, installation ou packaging : pas de clone neuf ni de benchmark supplémentaire.

Tests ciblés : modèle 20 × 20, 300 cibles distinctes puis 100 restantes malgré cache ancien ; budgets pixels/énergie différents ; zone limitée ; ancien pixel correct devenu incorrect ; tuile inconnue ; attente d’énergie et rejet d’une fausse recharge ; pause/reprise, arrêt, expiration, remplacement de canal ; réponse perdue et redémarrage sans doublon. Le navigateur vérifie aussi la zone/couleur exacte du fantôme, le budget cumulé, la date limite et les refus avant réseau. Le transport HTTP refuse champs inconnus et version incompatible.

Recette Edge locale : modèle 20 × 20, rectangle 10 × 10, attente d’une réponse native factice puis 30 cibles distinctes en six groupes ; pause/reprise ; aucun appel externe. API GM et placements simulés, pas Tampermonkey réel.

## Limites et prochain essai

**Aucun placement réel 2J réalisé ; aucune validation réelle revendiquée.** Le contrat supplémentaire du worker d’énergie doit être confirmé sur la production. En son absence, le dessin attend ; aucun repli vers une régénération estimée. L’onglet GeoPixels peut devoir rester visible pour que sa synchronisation native fournisse de nouvelles réponses.

Le fantôme doit présenter les couleurs quantifiées exactes du modèle : le lecteur refuse une cible dont le RGB ne correspond pas ou dont l’alpha n’est pas 255. Utiliser le PNG préparé/exporté plutôt qu’une image source différente.

Le registre conserve sa limite protectrice de 4 096 références ; le mode continu est borné et ne constitue pas un service de dessin illimité. Un seul modèle/agent actif. Les cibles acquittées restent exclues même si un tiers les modifie ensuite : une politique de maintenance distincte reste à définir.

Recette proposée : PNG de test 20 × 20, zone 10 × 10, 50 pixels / 50 énergie / 120 s ; **faire valider les coins natifs affichés avant de cliquer Autoriser**. Voir [le guide](phase2c-lecteur-http.md#premier-essai-réel-2j--ne-pas-démarrer-avant-accord). Aucun achat, nouveau compte, push, tag, release ou nettoyage.

Commit de livraison : `feat(geopixels): add bounded continuous supervised drawing` ; consulter `git log -1` sur la branche 2J pour son identifiant.
