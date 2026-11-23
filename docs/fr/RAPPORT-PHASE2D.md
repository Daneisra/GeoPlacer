# Phase 2D — Surveillance du cache GeoPixels et préparation du nettoyage

État du **17 novembre 2026**, Europe/Warsaw. GeoPlacer **6.0.0-rc.1**, lecteur **0.3.1**. Base vérifiée propre : `feat/phase2c-connector-transport`, `ea897de4aac0a174ef038733ace29f6c20dcdad0`. Développement sur **feat/phase2d-live-observation**, local uniquement. Aucun placement ou achat réel.

## 1. Publication contrôlée de 2C

La seule branche poussée est [feat/phase2c-connector-transport](https://github.com/Daneisra/GeoPlacer/tree/ea897de4aac0a174ef038733ace29f6c20dcdad0), sur **origin = Daneisra/GeoPlacer**. SHA distant confirmé par `git ls-remote` : **ea897de4aac0a174ef038733ace29f6c20dcdad0**. Push à blanc réussi, puis `git push -u origin feat/phase2c-connector-transport`. Aucun push upstream, force push, tag, release, PR ou modification de main.

Avant publication : état Git et remotes vérifiés, fetch des deux remotes existants sans suppression, examen des sept commits 2C, licence AGPL-3.0-only et attributions conservées. Le push rend aussi accessibles leurs ancêtres encore absents d'origin : **31 commits, 162 blobs** examinés, versions intermédiaires et merge inclus, aucun motif de secret à forte confiance, configuration privée, donnée applicative ou journal de travail détecté. La clé privée de recette a été recherchée sans en afficher le contenu. Ce contrôle ne prétend pas détecter tous les secrets possibles.

Les contrôles avant push ont réussi : **869 tests, un facultatif ignoré**, puis build. Journaux : `test-logs/2026-11-17T12-33-21-305Z-check.log`, `2026-11-17T12-42-02-858Z-build.log`, scan privé `test-logs/phase2d/prepublication-scan.json`.

## 2. Sauvegarde avant modification

Branche 2D créée depuis le SHA validé, sans réécrire les anciennes branches. Bundle externe :

`D:\Téléchargements\Code\GeoPlacer-sauvegardes\2026-11-17-avant-phase2d\GeoPlacer-avant-phase2d.bundle`

SHA-256 : **093f08f73f06a58be4489f7379b5b9d335d5f8ef04a5fef8935553d6cb3ea8fb**.

`git bundle verify`, restauration miroir dans un dossier temporaire neuf, toutes références comparées, HEAD identique, `git fsck --full` réussi, aucun alternates. Preuve locale : `test-logs/phase2d/backup-before.json`. Les sauvegardes privées 2C des données et des quatre WIP sont conservées ; le bundle 2D les complète, sans remplacer le pack d'objets non référencés. Aucun objet supprimé, aucun GC/prune.

## 3. Architecture effectivement implémentée

Le [service ObservationMonitor](../../packages/engine-service/src/geopixels/monitor.ts) gère les commandes, leurs révisions et confirmations, l'assemblage des captures, les changements et l'historique. **Aucun timer ou réseau dans ce service, aucun nouveau scheduler de peinture.** [GeoPixelsProvider.observe](../../packages/engine-service/src/geopixels/provider.ts) conserve son cache, sa liaison explicite et l'expiration des pixels. Les comparaisons de progression utilisent toujours `computeProgress`, le même moteur partagé avec la simulation.

Le [protocole](../../packages/engine-service/src/geopixels/protocol.ts) ajoute une métadonnée optionnelle stricte `capture: {id,index,count}`. Le lecteur envoie des bandes consécutives de largeur complète, au plus 16 384 positions chacune. Seules les captures entièrement assemblées entrent dans l'historique. Identité, ordre, rectangles et continuité sont vérifiés ; les bandes ont des ACK individuels. Un nouveau modèle/session/position/palette n'est pas un simple changement de couleurs.

Le [serveur de canal HTTP](../../packages/engine-service/src/geopixels/http-channel.ts) et les [routes dédiées](../../src/api/v1/connector-http.ts) portent les commandes de lecture dans les réponses de statut. L'API de gestion `POST /api/v1/connector/monitor` accepte seulement start/pause/resume/stop et une pause de 5 à 60 secondes. Elle exige le canal HTTP approuvé, la clé locale privée et, pour démarrer/reprendre, une source GeoPixels avec modèle lié. Aucun URL, proxy ou commande métier arbitraire.

Le [client navigateur](../../browser/geopixels-client.js) attend les réponses HTTP, applique les commandes par révision et effectue une capture à la fois. Une capture commencée se termine avant la confirmation d'une pause/arrêt. La cadence désigne la **pause après une capture**, non une garantie de captures à intervalles exacts. Pas de rattrapage en rafale. Les changements de contexte ou erreurs ferment le canal et demandent un nouveau couplage.

Les bitmaps sont décodés une seule fois **par capture**, puis réutilisés entre ses bandes. Le cache décodé n'est jamais conservé entre deux captures. Un remplacement ou une fermeture de bitmap invalide sa lecture ; un bitmap absent ou illisible reste inconnu. Aucun chargement automatique de tuiles, aucune requête vers GeoPixels.

`EngineService` mémorise la progression jusqu'à un changement pertinent ou l'échéance réelle d'expiration, évitant de rescanner une grande image à chaque polling inchangé. Les notifications utilisent le **WebSocket local existant**, via un événement connector coalescé ; aucun pixel brut ni nouvel ordonnancement n'y est diffusé. Le dashboard conserve une resynchronisation HTTP et charge son panneau GeoPixels seulement lorsque cette source est choisie.

## 4. Défaut réel découvert et correction 0.3.1

Le lecteur 0.3.0 passait les fixtures locales, mais le premier essai utilisateur a échoué en arrière-plan : deux captures espacées d'environ **59,7 secondes**, puis expiration du canal après plus de 30 secondes sans échange. L'utilisateur confirme que GeoPixels était dans un autre onglet de la même fenêtre Chrome. Le serveur a conservé la raison d'expiration et les horodatages.

Le diagnostic est cohérent avec le [ralentissement documenté des timers des onglets masqués par Chrome](https://developer.chrome.com/blog/timer-throttling-in-chrome-88). Les heuristiques internes de ce Chrome n'ont pas été instrumentées : l'attribution repose sur le contexte utilisateur, les intervalles observés et la régression locale reproduite, pas sur une prétendue inspection interne du navigateur.

**Correction :** attente de statut HTTP bornée à cinq secondes côté Node, interrompue par une commande, révocation ou abandon du client ; une seule attente par canal. Les réponses de statut et d'observation sont cadencées côté serveur, au moins 50 ms après le début de traitement. Le lecteur vérifie ce contrat négocié et ne dépend plus de setInterval ou de petits setTimeout pour la cadence. Les temporisateurs de délai d'erreur GM restent des garde-fous, pas le moteur de capture.

Les limites restent **30 secondes d'inactivité et 10 minutes absolues**. Ni délai augmenté pour réussir la recette, ni autorisation renouvelée silencieusement, ni changement de CSP, CORS général ou paramètres de Chrome. Une page réellement gelée, abandonnée ou un ordinateur suspendu peut toujours arrêter les callbacks : l'expiration est alors normale, suivie d'un couplage volontaire. Le correctif ne prétend pas contourner cette suspension.

## 5. Validation sur le véritable GeoPixels

Interactions effectuées par **l'utilisateur** sous Chrome et Tampermonkey ; l'agent a préparé le récepteur local et relevé son état. Les versions exactes actuelles de Chrome/Tampermonkey n'ont pas été relevées de nouveau. Aucun test d'écriture, achat ou authentification automatisée.

| Cas réel | Résultat confirmé |
|---|---|
| Installation/couplage 0.3.1 | Réussi, après remplacement du lecteur 0.3.0 |
| Surveillance, GeoPixels en arrière-plan | Captures augmentant seules, connexion active ; 14 captures dans le relevé utilisateur |
| Modèle | Fantôme asymétrique 8 × 5 déjà validé en 2C ; 38 cibles opaques, 2 transparentes |
| Lecture de cette zone transparente | 40 valeurs connues, dont 40 transparentes ; aucune inconnue extraite |
| Progression des cibles | 0 correct, 38 incorrects, 0 inconnu ; couverture 38/38, cohérente avec des cibles opaques sur un cache vide |
| Cadence réelle relevée | Environ sept secondes entre captures pour une pause configurée de cinq secondes |
| Source | Explicitement non datée/non vérifiée, même après captures identiques répétées |
| Pause d'au moins 35 secondes | Compteur stable, expiration et 38 cibles inconnues, confirmé |
| Reprise | Compteur augmentant, retour à 0/38/0, confirmé |
| Arrêt | Compteur stable après confirmation, confirmé |
| Révocation | Dashboard déconnecté et transmission indisponible, confirmé |

Le récepteur corrobore les commandes start, pause, resume, stop et révocation, ainsi que 25 captures complètes conservées à la fin. Il a ensuite été arrêté proprement par **IPC, code 0**. Ni Ctrl+C physique ni écriture réelle n'est revendiqué. Les autres cas (pixel coloré modifié/effacé, tuiles partielles, couche et changement de projet) sont couverts par les fixtures/tests ; ils ne sont pas présentés comme des modifications réalisées sur le service.

Preuves privées : `test-logs/phase2d/real-first-attempt.json`, `real-held-confirmed.json`, profil de recette séparé et journaux. Les coordonnées réelles, valeurs de compte, clés et codes ne sont pas recopiés dans le rapport public. Le test utilisateur est un constat technique, pas une autorisation officielle d'automatisation du service.

## 6. Fraîcheur, couverture et historique

- **Réception :** date d'arrivée de chaque bande dans GeoPlacer, distincte du début de la capture complète et de la date source.
- **Capture :** horodatage du lecteur avant lecture de chaque bande. Une grande image est un balayage étalé, pas un instantané atomique de toute la carte.
- **Source :** observedAt n'est renseigné que s'il est établi. Le vrai lecteur continue d'envoyer null : relire le même cache ne prouve pas une actualisation de GeoPixels.
- **Couverture :** valeurs connues/inconnues du rectangle parcouru et couverture des cibles opaques sont distinctes. Les transparents de la cible sont exclus par le moteur ; les transparents observés sont des valeurs connues.
- **Expiration :** les pixels non relus depuis plus de 30 secondes ou explicitement datés trop anciens restent inconnus. Une lecture récente d'un cache non daté est une information récente sur ce cache, sans garantie d'actualité de la toile distante.

Le pourcentage affiché est celui du **cache observé**, uniquement lorsque toutes les cibles sont connues. Sinon progression indéterminée ; aucun pourcentage de carte globale. Les régions affichées sont les rectangles parcourus et peuvent contenir des tuiles inconnues. Les ressources lisibles peuvent rester anciennes ou non datées ; aucune énergie ou monnaie n'est recalculée comme si elle était fraîche.

Historique : 120 captures complètes au plus, agrégats de progression et de changements, pas de pixels bruts ; 40 événements de session. Stockage local `connector-observations.json`, écrit atomiquement par la file existante du service et inclus dans les sauvegardes de données. Une histoire invalide est préservée sans être écrasée, avec avertissement ; la surveillance reste alors en mémoire. Le redémarrage recharge les points historiques, jamais une capacité, une liaison active ou une surveillance autorisée. Les courbes sont séparées par identité de projet/session et modèle local, avec rupture aux captures incomplètement couvertes.

## 7. Tests et validation locale

Contrôle complet final : **892 tests réussis, un facultatif ignoré** : Jest 171/19 suites ; Vitest adapters-node 66, core 386 (+1 ignoré), engine-service 218, simulator 51. `npm run check:logged` : code 0. Lint/TypeScript : aucune erreur ; 47 avertissements backend hérités. Build réussi ; avertissement Vite hérité sur NODE_ENV, sans blocage. Le chargement conditionnel du connecteur garde le bundle principal sous 500 ko.

Journal complet final : `test-logs/2026-11-17T13-23-02-993Z-check.log`. Build du code applicatif final : `test-logs/2026-11-17T13-19-55-028Z-build.log`. Les noms sont UTC, les dates de recette sont Europe/Warsaw.

Les tests couvrent identité et ordre des captures, réponse manquante, ACK identique, refus de replay, changements modèle/position/palette/session/couche, région inconnue, effacement et couleur modifiée, cache identique/non daté, source datée ancienne, expiration et révocation, requête de statut concurrente ou abandonnée et durée absolue non prolongeable. Les tests du journal, scheduler, reprise et fournisseur factice restent en place.

Un passage intermédiaire a échoué sur deux assertions de `service-waits.test.ts` : avec une régénération de fixture à 15 ms et des I/O concurrentes, la simulation avait déjà terminé avant l'état d'attente attendu. Les mêmes tests inchangés passent isolément, puis la suite complète passe sans installation concurrente. Aucun timeout ou règle métier modifié, aucun test retiré. Les journaux d'échec sont conservés (`2026-11-17T13-09-53-537Z-check.log`). Cette sensibilité de la fixture au temps réel reste à connaître.

Dix scénarios HTTP réels de boucle locale vérifient notamment approbation privée, absence de contournement WebSocket, Origin réservé à l'entrée privilégiée, refus CORS/formulaires, commandes et champs inconnus, limites, retransmission, révocation et contrôles de surveillance. Les fixtures Edge/Firefox reproduisent CSP et GM via Node et **ralentissent les temporisateurs de page à 60 secondes** : captures, changement de pixel, pause/reprise/arrêt continuent sans désactiver les protections ou augmenter les délais. Aucun accès au service dans ces tests.

Preuves locales : `security-held.log`, `edge-held/`, `firefox-held/`, métriques et captures explicitement de fixture. Le test Tampermonkey réel est uniquement celui de la section précédente.

## 8. Performances et limites de taille

| Taille | Capture (3 passages) | CPU par capture, hors calcul de progression | JSON par capture | Calcul de progression | RSS pic observe | Couverture retenue finale |
|---|---|---|---|---|---|---|
| 64 ? 64 | 0.082?0.084 s | 0.031?0.189 s CPU | 8 739 octets | 2.7?6.4 ms | 150.0 Mio | 4 095 corrects  1 incorrect  0 inconnu |
| 595 ? 894 | 2.546?2.576 s | 0.875?1.140 s CPU | 1 082 420 octets | 74.8?98.0 ms | 175.8 Mio | 531 929 corrects  1 incorrect  0 inconnu |
| 2000 ? 2000 | 18.265?19.065 s | 5.657?6.453 s CPU | 8 137 745 octets | 493.9?532.6 ms | 310.6 Mio | 3 999 999 corrects  1 incorrect  0 inconnu |

ACK HTTP des observations dans ce banc : moyennes de 57.5 ms, 54.5 ms, 54.3 ms. Les attentes de statut de 5 secondes sont exclues de cette latence. Donn?es brutes : `test-logs/phase2d/benchmark-final/metrics.json` et `benchmark-final.log`. Un autre passage 2000? a atteint 30,2 s ; il est conserv? dans `benchmark-held/metrics.json`, sans ?tre omis pour embellir le r?sultat.

Le benchmark exécute les vrais calculs du lecteur, une API GM simulée, HTTP réel local, GeoPixelsProvider et le calcul de progression partagé. Trois captures par taille, une modification de couleur puis un effacement synthétiques, pause de cinq secondes. Les images sont dominées par le noir : le volume JSON dépend des couleurs et n'est pas une borne maximale. CPU et RSS concernent ce processus Node, avec canvas natif ; ils ne sont pas une mesure CPU de Chrome réel. Le temps de calcul de progression est relevé séparément. Pic mémoire échantillonné, pas une garantie de maximum système.

Sur la fixture Edge, le temps de tâches de page et le tas JS sont relevés par CDP ; ces métriques ne sont pas disponibles sous Firefox par cette méthode. Elles ne mesurent pas tout le processus navigateur. La latence dashboard inclut notification/polling et rendu. Les mesures initiales 0.3.0 sont conservées séparément, sans les attribuer au transport final cadencé côté serveur.

À 2000², la durée de balayage et les variations de charge peuvent atteindre la fenêtre d'expiration de 30 secondes. La couverture utilisable du moteur peut donc être inférieure aux valeurs extraites : elle doit rester explicitement inconnue si les premières bandes ont expiré. Aucun délai augmenté pour masquer ce cas. Cette limite et l'absence de chargement global de tuiles motivent la prochaine optimisation par régions, pas un second moteur.

## 9. Installation sur clone neuf

Code applicatif testé : **95cba4b21b815420789e3bdb64de5effbb32b244**. Nouveau clone `--no-hardlinks`, sans alternates, hors du développement ; aucun node_modules ni build du projet copié. Installation `npm run setup:windows` réussie avec Node **22.23.2**, npm **10.9.8**, lockfiles, canvas précompilé vérifié, configuration créée depuis l'exemple, compilation et démarrage API de contrôle avec arrêt gracieux IPC. Le cache de paquets npm du premier clone 2D est réutilisé, pas ses dépendances installées.

Les journaux et recettes finales du clone sont conservés dans `test-logs/phase2d/clone.json`, `clone-edge-separated/`, `clone-firefox-separated/` et les logs de setup du clone. Le clone initial 506d4a8 avait aussi réussi l'installation, mais il ne remplace pas le clone final incluant 0.3.1.

## 10. Matrice des fonctionnalités visées

| Fonction | État à cette phase | Composants disponibles / suite nécessaire |
|---|---|---|
| Import, palettes, quantification, export PNG | Disponible localement | TemplateManager, OKLab, export existant ; import GeoPixels manuel |
| Plusieurs modèles enregistrés | Disponible | TemplateManager et dashboard ; un seul modèle actif/lié en 2D |
| File de plusieurs projets | Non implémentée | Réutiliser sources de modèles et TaskScheduler ; pas de second scheduler |
| Huit stratégies de dessin | Disponible uniquement en simulation/factice | WorkPlanner, stratégies et ordonnanceur existants ; aucune exécution réelle |
| Priorités de couleurs | Disponible dans le moteur, interface dédiée à compléter | StrategyConfig.colorOrder, color-by-color ; pas de priorité d'écriture réelle |
| Zones de travail configurables | Non implémentées dans la supervision réelle | Géométrie, clipping et régions des stratégies réutilisables ; édition/priorités à ajouter |
| Lots et tentatives | Disponible uniquement en simulation/factice | WorkPlanner, AttemptManager, AttemptJournal ; lecture réelle ne crée pas de tentative de placement |
| Corrects/incorrects/inconnus | Disponible en lecture réelle du cache | GeoPixelsProvider + computeProgress ; fraîcheur distante non vérifiée |
| Surveillance des changements | Disponible en lecture réelle, session liée | Cadence contrôlée, changements de valeurs et couverture ; pas de lecture de toute la carte |
| Historique d'avancement | Disponible en lecture réelle | 120 captures persistées ; historique de tentatives distinct en simulation |
| ETA | Disponible uniquement en simulation/factice | EtaEstimator ; débit de placement et ressources réelles non vérifiés, aucun ETA inventé |
| Ressources | Disponible en lecture réelle, fraîcheur à valider | Valeurs observées et avertissements ; ResourceManager opérationnel en simulation |
| Propositions d'améliorations | Disponible uniquement en simulation/factice | evaluateUpgradePolicy ; catalogue/coûts/bénéfices réels à établir, achat interdit |
| Reprise après interruption | Disponible, avec limites explicites | Journal/reconciliation simulation conservés ; historique lecteur restauré, nouveau couplage obligatoire |
| Placement et achats sur GeoPixels | Non implémentés et indisponibles | Futur port écrivain distinct, validation interactive, intentions durables ; pas activables par un simple réglage |

Références : `packages/core/src/work/planner.ts`, `scheduler/scheduler.ts`, `contracts/template.ts`, `progress/progress.ts`, `progress/eta.ts`, `resources/manager.ts`, `upgrades/planner.ts` et `packages/engine-service/src/service.ts`. La présence d'un contrat de bas niveau ne signifie pas qu'une interface de configuration complète existe déjà.

## 11. Nettoyage et main

Le [plan actualisé](PLAN-NETTOYAGE-GIT-DOSSIERS.md) donne toutes les branches, SHA, relations d'ancêtres, actions proposées et commandes futures. **16 candidates locales, cinq distantes**, désormais contenues dans la référence origin/2C conservée. Les PR ouvertes de Daneisra/GeoPlacer sont recherchées ; liens/PR d'autres dépôts et pointes doivent être recontrôlés juste avant toute suppression.

Les archives phase0 (18 fichiers, 531 897 octets) et phase1a (32 fichiers, 99 498 octets) sont de nouveau identiques aux originaux et manifestes au SHA-256. Aucun ancien script exécuté. Aucun original déplacé/supprimé. Copier sur un autre support physique et tester restauration avant de demander un retrait nominatif ; une autre partition du même disque ne suffit pas.

Main et origin/main restent `46877e120f9e7bc721084fdf88a9ae8f006cb117`. L'avance rapide vers la RC `fe392266` reste possible ; son suivi local est toujours upstream/main. Le plan prévoit **plus tard**, après accord, `git merge --ff-only fe392266...`, puis `git branch --set-upstream-to=origin/main main`, contrôles, push à blanc et publication spécifique. Aucune de ces opérations n'a été exécutée. Pas de tag/release ni nouvelle archive présentée comme RC finale.

## 12. Commits et suite prioritaire

- `7ac914f` — service d'observation, historique borné et protocole.
- `6f778bc` — captures répétées sous contrôle du dashboard.
- `98d1e83` — supervision, couverture, fraîcheur et WebSocket partagé.
- `506d4a8` — recettes et mesures reproductibles.
- `95cba4b` — correctif démontré pour l'onglet masqué, lecteur 0.3.1 et tests sans timers de cadence.

Les mesures finales et la documentation sont enregistrées séparément ; la liste finale se lit avec `git log ea897de..feat/phase2d-live-observation --oneline`. **Aucun commit 2D poussé.** Les branches anciennes, main, remotes et tags sont conservés. GeoPlacer-Audit et GhostPixelBot-FR ne sont pas modifiés.

Prochaine priorité : améliorer la couverture et le coût des grandes observations par régions et preuves de version/fraîcheur de cache, puis proposer l'édition des zones et priorités et une file de modèles en réutilisant le scheduler unique. L'ETA et les politiques de ressources réelles demandent leurs propres contrats vérifiés. Une future écriture reste une phase distincte, avec intention durable, résultat confirmé et réconciliation sans renvoi aveugle ; aucun placement ni achat ne résulte de cette phase de lecture.

Les décisions restantes concernent une éventuelle publication 2D, la copie sur un autre support, le retrait nominatif des dossiers/branches et la promotion de main. Attendre la validation utilisateur avant ces actions.
