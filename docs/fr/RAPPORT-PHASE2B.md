# Phase 2B — Validation du lecteur GeoPixels et assainissement

Date : 16 novembre 2026. Base vérifiée : `c658dd2bb58ba79a079d9316507c80c7a9ecaf2a`, branche Phase 2A propre. Travail local sur `feat/phase2b-reader-validation`, sans modification des anciennes branches. Version de l'application conservée : **6.0.0-rc.1**. Version propre du lecteur passif : **0.1.2**.

## 1. Résultat : lecteur installé, transport réel bloqué

**Le lecteur ne fonctionne pas encore de bout en bout sur le site réel.** L'utilisateur confirme que son panneau apparaît sur `https://geopixels.net`, mais le couplage échoue. Sa console fournit une cause précise :

```text
Connecting to 'ws://127.0.0.1:3921/api/v1/connector/channel' violates
Content Security Policy directive: connect-src [...]. The action has been blocked.
```

La liste connect-src transmise autorise les origines GeoPixels et plusieurs services du site ; elle n'autorise pas ce WebSocket de boucle locale. Ce constat est une **validation utilisateur d'un échec réel**, pas un résultat de fixture. Le serveur local était disponible. Le message générique du lecteur ne permettait initialement pas de distinguer ce blocage d'un code expiré ou d'une origine incorrecte. Désormais, le lecteur affiche un diagnostic CSP spécifique lorsque le navigateur émet l'événement correspondant, et conserve l'erreur après fermeture du socket.

Les messages utilisateur ont été recueillis avant l’ajout du diagnostic CSP de la version 0.1.2 ; le numéro installé n’a pas été relevé directement. Cette dernière correction a été testée localement, pas réinstallée ni validée sur la page réelle par l’agent.

Le diagnostic utilisateur indique aussi :

| Élément | Résultat déclaré sur la page réelle |
|---|---|
| Origine | https://geopixels.net |
| Panneau du lecteur | visible |
| Interface de couche getSelectedEventId | indisponible |
| Modèle fantôme | disponible |
| Position | disponible |
| Cache | disponible |
| OffscreenCanvas | disponible |
| Couplage local | échec, bloqué par CSP |
| Observation reçue par GeoPlacer | aucune |

La présence d'un cache ou d'une position ne prouve pas la validité de leur contenu. Aucun pixel réel, orientation Y, bord de tuile, ressource, changement de palette ou de session n'a été validé de bout en bout. Le lecteur refuse une interface de couche manquante au lieu de supposer silencieusement une couche de base.

L'agent n'a ni placé un pixel, ni acheté une amélioration, ni récupéré de cookie ou jeton GeoPixels. L'utilisateur a préalablement confirmé l'arrêt des bots de placement et de leur démarrage automatique.

## 2. Référence frontend et limite de compatibilité

Référence publique examinée : [AntCDev/GeoPixelsFront au commit 74783afc5b7e3064a43eed20b0f6638007853324](https://github.com/AntCDev/GeoPixelsFront/tree/74783afc5b7e3064a43eed20b0f6638007853324), commit « Event Layers » daté **2026-11-16T04:55:48Z**. Cette pointe n'a pas changé depuis l'étude 2A. Le README distingue production `https://geopixels.net` et développement ; le dépôt public ne garantit pas que les deux déploiements aient déjà cette révision.

Fichiers réexaminés : `wwwroot/js/index.js`, `config.js`, `ghost.js`, `pixel-tile-layer.js`, `sync-worker.js`, `eventLayer.js` et `user.js`. `getSelectedEventId()` appartient à `eventLayer.js` et a été ajouté dans le changement Event Layers. Le HTML public le charge comme script classique. Les contrats utilisés restent :

- `ghostImageOriginalData`, `ghostImageTopLeft`, `ghostActivePaletteColors` : identité, dimensions, position native et filtres du fantôme ; SHA-256 calculé localement.
- `tileImageCache`, entrées `colorBitmap`, tuiles de 1000 × 1000, clé `tileX,tileY` ; `ghost.js/getMapPixelHex` justifie l'ordre des pixels.
- `gridY` natif croissant vers le haut ; rangées PNG vers le bas. Le fournisseur convertit vers les coordonnées du modèle local.
- `getSelectedEventId() === null` : seule couche de base admise. Absence de la fonction et sélection d'un événement produisent des erreurs différentes.
- `userData.energy`, `maxEnergy`, `pixels`, `energyRate`, `checkedTick` et `Colors` : données facultatives validées ; quantité absente = null. La valeur d'énergie est celle de l'objet observé, pas nécessairement le compteur animé/recalculé à l'écran. Un horodatage trop ancien n'est pas traité comme une ressource actuelle.

Des GET publics anonymes vers les sept fichiers JavaScript du site ont répondu **HTTP 403**. Aucun contournement ni requête authentifiée n'a été tenté. Il est donc impossible d'attester l'identité des fichiers servis en production avec le commit GitHub. L'interface de couche absente alors que modèle/cache sont accessibles est compatible avec un déploiement plus ancien ou incomplet, mais **ce n'est qu'une hypothèse**, pas une version identifiée. Une isolation d'injection reste également à examiner. Ne pas ajouter de repli aveugle vers la couche de base.

[Documentation officielle Tampermonkey sur les contextes d'injection](https://www.tampermonkey.net/documentation.php?q=sandbox) : le lecteur déclare `@sandbox raw` pour demander le contexte principal nécessaire aux variables de page. Cela ne prouve ni la disponibilité des variables, ni l'autorisation réseau par la CSP.

## 3. Correctifs effectués, périmètre limité

| Fichier | Changement |
|---|---|
| `packages/engine-service/src/geopixels/pairing.ts` | Autorise explicitement les deux origines HTTPS racine/www pour le lecteur, en conservant la liaison du code à une origine exacte |
| `frontend/src/components/geopixels/ConnectorDashboard.tsx` | Sélecteur d'origine racine/www ; le choix alimente réellement le couplage |
| `browser/geopixels-client.js` | Diagnostic non secret, erreurs persistantes, refus synchrone de socket géré, diagnostic CSP ciblé, rejet des messages d'un ancien socket, contrôle de capture après chaque attente |
| `scripts/build-connector.mjs` | Métadonnées root/www, raw, noframes ; lecteur 0.1.2 |
| `public/geopixels-connector.user.js` | Artefact régénéré depuis les sources ; aucune édition manuelle séparée |
| `packages/engine-service/test/geopixels-client.test.ts` | 15 tests VM/DOM/socket locaux du client réel |
| `packages/engine-service/test/geopixels-provider.test.ts` | Deux cas supplémentaires de contrôle exact des origines et de refus d'écriture factice depuis le site |

La copie de position est figée avant le hash asynchrone. Chaque bande vérifie ensuite modèle, position, filtres, couche et identité de session locale : un changement pendant la lecture interrompt la capture. L'identifiant de compte utilisé pour détecter un changement reste dans la page ; il ne figure pas dans les messages. Les données privées ne sont pas incluses dans Diagnostiquer.

Ni scheduler, ni logique de placement, ni calcul de ressources, ni réseau vers le service, ni authentification GeoPixels n'ont été ajoutés ou modifiés. Le port lecteur réel ne possède toujours aucun exécuteur d'écriture. Les contrôles d'origine exacte, Host local, schémas stricts, code à usage unique de 256 bits valable 60 secondes, révocation et séparation read-only/local-fake sont conservés. Le sous-domaine dev et les origines ressemblantes restent refusés. Aucun CORS global ni protection navigateur n'a été abaissé.

### Traitement requis du blocage CSP

Passer simplement à `wss://localhost` ne résout pas une directive connect-src qui ne l'autorise pas. Désactiver la CSP, lancer un navigateur sans sécurité ou élargir globalement les origines du serveur n'est pas une solution retenue.

Pour la prochaine étape, prototyper un **transport de connecteur distinct du contexte de page**, par exemple une petite extension dédiée ou un canal privilégié userscript documenté et testable, avec permissions minimales et messages fermés. Le lecteur de page ne doit transmettre que les observations structurées ; aucun cookie/Google token ne doit franchir le canal. Le nouveau transport devra refaire la preuve de liaison à l'onglet et à l'origine autorisés, de couplage explicite, révocation, validation stricte, absence de proxy arbitraire et résistance aux autres pages locales. Il ne suffit pas de supprimer le contrôle Origin pour accepter un Origin d'extension ou absent. Cette modification architecturale ne fait pas partie des corrections minimales livrées ici.

Identifier parallèlement le contrat de couche **effectivement déployé**, à partir de sources accessibles et d'informations non secrètes de la page utilisateur. Prévoir des variantes de contrat versionnées et testées si nécessaire, sans inventer la couche à partir d'un cache incomplet. Le transport et ce contrat doivent être validés avant de reprendre la recette réelle.

## 4. Recette interactive préparée et état des cas

L'utilisateur a choisi un accompagnement pas à pas. L'automatisation de sa fenêtre Chrome a été arrêtée par une protection de Computer Use : l'URL courante ne pouvait pas être vérifiée avec assez de confiance. Aucun contournement, lecture du profil navigateur, action d'authentification ni automatisation de cette fenêtre n'a suivi. Les liens ont donc été fournis à l'utilisateur pour ouverture et installation manuelles ; aucun onglet n'est prétendu ouvert par l'agent.

Un serveur dédié a été lancé sur `http://127.0.0.1:3921`, avec données isolées dans `test-logs/phase2b/session/`, sans réutiliser les données de développement. Fixture PNG locale asymétrique **8 × 5**, 40 pixels dont 38 opaques et 2 transparents, blanc/noir, pour repérer le coin haut gauche et l'orientation. Son modèle local a été importé et sélectionné ; aucun moteur d'écriture n'a été lancé. La PNG de test et les données de recette sont ignorées par Git. Les codes temporaires ne sont ni consignés ni publiés. Le canal a été révoqué par l’API locale après le diagnostic (HTTP 200) ; état déconnecté, aucune dernière synchronisation. Le serveur de recette a ensuite été terminé en ciblant uniquement son PID et son chemin vérifiés. Ce n’est pas un test physique Ctrl+C ; les données et fichiers de recette sont conservés.

Parcours préparé : dashboard local → source connecteur → origine exacte → téléchargement du lecteur → installation Tampermonkey → image native fantôme → couplage → Diagnostiquer → Observer. L'utilisateur confirme l'apparition du panneau et fournit les erreurs ci-dessus. La recette s'arrête avant réception d'observations ; répéter le code de couplage ne corrigerait pas le blocage CSP.

| Cas réel demandé | État |
|---|---|
| Région chargée, partielle, tuiles absentes | Non validés sur le vrai site ; contrats couverts localement |
| Image non carrée, coin supérieur gauche, coordonnées/couleurs | Fixture 8 × 5 préparée ; aucune observation réelle reçue |
| Déplacement du fantôme, changement de palette | Non validés réellement ; changements pendant capture couverts par VM |
| Nouvelle session, déconnexion/reconnexion | Non validées réellement ; transport bloqué avant couplage |
| Ressources | Aucune ressource réelle reçue ; absence/obsolescence couvertes en tests |

Après correction du transport et identification du contrat de couche : recommencer avec une copie locale sauvegardée de l'image et de sa position initiale, garder tous les bots désactivés, contrôler manuellement les 40 pixels et les deux transparences, déplacer au bord d'une tuile puis vers une région non chargée, modifier les filtres, renouveler la session et révoquer/reconnecter. Aucun clic de placement ni achat ne fait partie de cette recette.

## 5. Tests et journaux

Résultats sur les sources du commit applicatif `2f40df0260ea479a362d188efdda146bd09ec945` :

| Contrôle | Résultat |
|---|---|
| `npm.cmd run check:logged` | Succès, code 0 ; journal `test-logs/2026-11-16T22-34-21-908Z-check.log` |
| `npm.cmd run build` (via run-logged) | Succès, code 0 ; journal `test-logs/2026-11-16T22-40-07-081Z-build.log` |
| Jest | 171 tests / 19 suites réussis |
| Vitest adapters-node | 66 réussis |
| Vitest core | 386 réussis, 1 facultatif ignoré |
| Vitest engine-service | 152 réussis |
| Vitest simulator | 51 réussis |
| Total automatique | **826 réussis, 1 ignoré**, contre 809 + 1 en Phase 2A |
| TypeScript, lint frontend/packages | Succès ; aucune erreur |
| Lint backend | Aucune erreur ; 47 avertissements `no-explicit-any` hérités |
| Syntaxe `node --check` du client et userscript généré | Succès |

Une passe initiale de 823 tests a précédé les trois nouveaux cas CSP/refus synchrone. Une passe intermédiaire a trouvé deux invocations de listener potentiellement indéfini dans le **nouveau mock TypeScript** ; les assertions de présence ont été corrigées et la passe complète finale ci-dessus est verte. Aucun timeout n'a été augmenté pour masquer un échec. Le build local affiche encore l'avertissement Vite hérité relatif à NODE_ENV dans .env ; il termine avec succès.

- Client VM et fournisseur : **58 tests réussis** après les corrections CSP (15 + 43).
- Canal HTTP/WebSocket local : **8 scénarios réussis**, dont origine, authentification, code incorrect, révocation et refus de fetch/achat/champs tokenUser. Commande correcte : `node --import tsx scripts/test-connector-channel.mjs`. Un premier lancement sans `--import tsx` a échoué à résoudre les imports TypeScript ; il a été relancé correctement, sans changer les délais ni le produit.
- Recette **Edge/Chromium** factice : réussie ; aucun pageerror et aucune requête externe. 64 × 64 jusqu'à zéro incorrect/inconnu, transparents exclus, rechargement IndexedDB durable, modification externe réobservée, politique factice, révocation puis retour simulation.
- Recette **Firefox** factice : mêmes résultats. Images 595 × 894 et 2000 × 2000 stockées/rechargées, sans exécution de millions de placements. Ces tailles ne constituent pas un benchmark de dessin réel.
- Les sondes de canvas exécutent le code de lecture de cache dans les vrais moteurs navigateur, mais sur une page **locale factice**. Elles n'attestent pas le cache du site réel.

Journaux initiaux de recette : `test-logs/phase2b/{edge,firefox}/`, `channel.log`, et preuve utilisateur `recette-reelle-utilisateur.json`. Les journaux sont locaux/ignorés, conservés ; ce rapport garde les conclusions et empreintes critiques. Ne pas publier les données ou configurations locales avec eux sans examen.

### Installation sur clone neuf

Clone local indépendant `--no-hardlinks` dans un répertoire temporaire, branche 2B, commit `2f40df0260ea479a362d188efdda146bd09ec945`. Aucun node_modules, `.env` personnel ni dossier data de développement copié. `npm.cmd run setup:windows` : **succès** sous Node 22.23.2 / npm 10.9.8, cache npm propre au répertoire temporaire. Installation depuis lockfiles avec scripts désactivés, module canvas précompilé chargé et archive vérifiée SHA-256, build complet, création de configuration par défaut, API démarrée dans un dossier isolé puis arrêtée par le test d'installation. Le lanceur `cmd /d /c .\start.bat` avec `GEOPLACER_SETUP_ONLY=1` confirme l'installation à jour, code 0 ; ce test valide le chemin du lanceur et ne prétend pas être un Ctrl+C physique.

Journaux : `test-logs/phase2b/clone.json`, `clone.log`, `clone-setup.log`, `clone-start-bat.log`. La recette Edge du clone final a réussi intégralement, sans erreur de page ni requête externe ; preuves dans `test-logs/phase2b/clone-edge/`. La recette Firefox exécutée depuis ce même clone final a également réussi, sans erreur de page ni requête externe (`clone-firefox/`). Le sélecteur d’origine est visible et sans débordement évident sur la capture Edge de recette (1280 px de largeur) ; aucun contrôle visuel réel du panneau 0.1.2 n’est revendiqué. L'installateur affiche des avertissements de dépendances héritées obsolètes ; aucune dépendance n'a été modifiée dans cette phase. Les paramètres Windows et installations globales sont inchangés.

## 6. Préparer le dashboard complet sans second moteur

| Besoin | Disponible | Travail restant après validation du lecteur |
|---|---|---|
| Corrects/incorrects/inconnus | Provider, ProgressCalculator, panneau observé | Validation sur cache réel et présentation de la couverture/fraîcheur |
| Surveillance continue | Réévaluation du scheduler sur nouvelles observations ; fixture de modification externe | Déclenchement et cadence du lecteur réel, invalidation des caches |
| Priorités couleur et zones | WorkPlanner et stratégies existantes ; géométrie | Paramétrage ergonomique relié aux observations et tests réels |
| Plusieurs projets | TemplateManager et sélection ; une liaison active de connecteur | File explicite de projets, transitions sûres et état du navigateur |
| Historique/progression | AttemptJournal et checkpoints, statistiques de simulation | Historique d'observations réel distinct des intentions d'écriture |
| Ressources/améliorations | Observations optionnelles, ResourceManager, décisions et propositions factices | Contrats déployés, coûts/règles à jour, confirmation des dépenses ; aucun achat ici |
| ETA | EtaEstimator du moteur local | Estimation honnête conditionnée à la couverture et aux ressources réelles |
| Interruptions/reprise | Journal durable, réconciliation, tentative ambiguë non rejouée automatiquement | Scénarios interactifs du transport réel ; aucun renvoi aveugle |

Limites de lecture : 2000 × 2000 au maximum, en bandes de 65 536 pixels au plus. Les bitmaps chargés ne prouvent pas la couverture globale, leur fraîcheur n'est pas inventée et une tuile absente/fermée/illisible reste inconnue. Le décodage est local et peut être répété entre bandes ; aucun benchmark de capture réelle ni garantie de latence en production n'est fourni ici.

La simulation reste disponible et constitue l'environnement de référence. Le connecteur expérimental reste signalé séparément. Les huit stratégies, l'API /api/v1 et WebSocket existants sont conservés ; aucun scheduler navigateur n'est ajouté. Les politiques factices ne deviennent pas des commandes d'achat réelles par changement d'étiquette.

## 7. Git, organisation et décision

Commit applicatif local : `2f40df0260ea479a362d188efdda146bd09ec945` — `fix(connector): diagnose CSP failures and harden passive reader context`. Les documents sont enregistrés ensuite dans un commit documentaire distinct ; `git log c658dd2..feat/phase2b-reader-validation --oneline` donne la liste définitive sans réécrire l'histoire.

Voir [PLAN-NETTOYAGE-GIT-DOSSIERS.md](PLAN-NETTOYAGE-GIT-DOSSIERS.md) pour l'inventaire complet, les sauvegardes restaurées, les objets WIP non référencés, les données ignorées et les procédures futures. Aucun dossier ni aucune branche n'a été supprimé ou déplacé. Aucun push ; main inchangé ; aucun tag ni release. GeoPlacer-Audit et GhostPixelBot-FR n'ont pas été modifiés.

La Phase 2B établit un diagnostic réel vérifiable et un plan de rangement sûr ; **elle ne valide pas encore le lecteur comme opérationnel sur GeoPixels**. Le prochain jalon est le transport compatible CSP et le contrat de couche déployé, puis une nouvelle recette réelle en lecture seule. Le placement, les achats et la publication restent soumis à une validation distincte.
