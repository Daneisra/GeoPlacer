# Phase 2C — Transport compatible CSP et archivage sécurisé

Validation : **17 novembre 2026** (Europe/Warsaw). Base contrôlée : branche `feat/phase2b-reader-validation`, HEAD `54add74aca4f1281fcba9f2e698ab7af0dceee91`, arbre propre. Branche créée : **feat/phase2c-connector-transport**. Application : **6.0.0-rc.1** ; lecteur : **0.2.2**.

## 1. Résultat et portée

**GeoPlacer reçoit maintenant des observations depuis le navigateur GeoPixels réel par le transport HTTP privilégié de Tampermonkey.** L'utilisateur a confirmé : couplage, fantôme 8 × 5, lecture d'une zone transparente puis colorée, absence d'inversion, déconnexion, reconnexion et révocation. Aucun placement ni achat réel n'a été déclenché. La simulation et le navigateur factice restent disponibles.

La capture du navigateur reste une observation de cache **non datée côté service**. Elle ne prouve pas l'état global ni instantané de la toile. Une tuile non chargée ou illisible reste inconnue. L'existence d'un script public et ce succès technique ne constituent pas une autorisation officielle du service pour de futures automatisations.

Les sauvegardes et copies historiques ont été effectuées hors du projet et contrôlées. Aucun original n'a été supprimé ou déplacé. Aucune branche ancienne, aucun remote, main ni tag n'a été modifié ; aucun push/publication.

## 2. Contrats du frontend examinés

| Référence | Usage et éléments examinés |
|---|---|
| [GeoPixelsFront 74783afc5b7e3064a43eed20b0f6638007853324](https://github.com/AntCDev/GeoPixelsFront/tree/74783afc5b7e3064a43eed20b0f6638007853324) | Référence publique Event Layers : `eventLayer.js/getSelectedEventId`, `activeEvent`, `index.js`, `ghost.js/getMapPixelHex`, cache et tuiles ; commit daté 2026-11-16T04:55:48Z |
| [GeoPixelsFront 83673896886c016a3d23bd46a2309570194a19da](https://github.com/AntCDev/GeoPixelsFront/tree/83673896886c016a3d23bd46a2309570194a19da) | Parent antérieur aux couches événementielles ; examen de `index.js/placePixels` comme texte uniquement, et `ghost.js/getMapPixelHex` ; aucune exécution du placement |
| Production, navigateur de l'utilisateur | Diagnostic réel : `base-only-8367389`, couche de base, modèle/position/cache disponibles, SYNC_TILE_SIZE = 1000, bitmap 1000 × 1000 lisible |

Le fichier `index.js` du parent a pour blob `37bcdadc3cd20eb682051c27d10ecf1bb8908ef5` ; `ghost.js`, `0f5044a4d00fd649f19c1453c538e92cf69fed50`. L'index de la référence Event Layers consulté a pour blob `cd9fa5c691c039bbbfd3c9339d09cd8b31271c68`.

La reconnaissance du contrat ancien exige **deux empreintes exactes** de fonctions publiques (source normalisée CRLF → LF), l'absence d'interface d'événement accessible et l'absence de script d'événement reconnu :

- `placePixels` : `046cded7e9792f2e3a3c7cf87f6f1a6343f2183b1dfc5fc4bdf0c61cb88794f2`.
- `getMapPixelHex` : `4d7fadb08c6b8bb77dbb4e596c2e67926574a283f4c702e1ef4b79177c865b87`.

Ces fonctions sont lues avec `Function.prototype.toString`, jamais appelées pour reconnaître le contrat. Seules les empreintes figurent dans le code livré ; les sources externes de preuve restent dans les journaux privés de travail. Une fonction absente ou différente ne donne pas automatiquement une couche de base.

Adaptateurs de `browser/geopixels-reader.js` : getter public Event Layers, état `activeEvent` de type vérifié, puis contrat ancien à empreintes. Une valeur d'état ambiguë (objet, tableau, booléen, NaN), une couche événementielle ou un contrat inconnu bloque l'observation. La couche est revérifiée pendant la capture.

Le diagnostic réel étaye donc un **contrat antérieur à Event Layers**, plutôt qu'une perte générale d'accès aux variables de page : modèle, cache, position et fonctions sont accessibles. Il ne démontre pas le SHA complet de tout le déploiement de production ; un déploiement composite n'est pas exclu. Les GET anonymes de fichiers de production avaient été refusés en 2B ; ils n'ont pas été contournés ni répétés avec des identifiants.

Les coordonnées restent natives Y vers le haut : le bas du fantôme vaut `gridY - height + 1`. Les rangées PNG sont converties explicitement. Le cache utilise des clés `tileX,tileY`, tuiles de 1000, bitmaps `colorBitmap`. La lecture distingue RGB opaque, transparent connu (-1), inconnu (-2) et alpha partiel non interprété comme opaque.

## 3. Transport retenu et comparaison

[La documentation Tampermonkey](https://www.tampermonkey.net/documentation.php?q=GM_xmlhttpRequest) précise que GM_xmlhttpRequest est exécuté par son contexte d'arrière-plan. C'est la piste retenue : aucun WebSocket de la page vers le serveur local. [@connect](https://www.tampermonkey.net/documentation.php?q=connect) limite les destinations ; le script déclare uniquement **127.0.0.1**, sans permission globale ni accès GM au service.

| Critère | GM_xmlhttpRequest retenu | Petite extension dédiée, alternative étudiée |
|---|---|---|
| Edge/Chrome | API Tampermonkey ; recette utilisateur réelle réussie sur son navigateur ; Edge automatisé sur fixture | Content script + arrière-plan et messagerie d'extension à développer |
| Firefox | Recette de contrat GM simulé réussie ; extension Tampermonkey réelle non installée par l'agent | Manifeste et API d'extension à adapter/tester séparément |
| Permissions | Deux @match HTTPS exacts, @noframes, un @grant, @connect 127.0.0.1 | Permissions de sites et de boucle locale, injection/messagerie minimales à définir |
| Installation | Un userscript, Tampermonkey déjà disponible | Installation et mises à jour d'une extension supplémentaires |
| Maintenance | Modules lecteur/transport séparés, générateur unique | Deux chaînes navigateur, manifeste et cycle de distribution à maintenir |
| Sécurité | Transport réseau d'arrière-plan, capacités limitées ; contexte de lecture raw nécessaire | Possibilité de conserver plus nettement les capacités dans un contexte isolé |
| Fiabilité | ACK, déduplication, limites, expiration ; limites de l'API GM testées localement | Mêmes garanties à concevoir, pas garanties par le seul choix d'extension |
| Débit | Lots bornés, maximum client 20 requêtes/s ; mesures ci-dessous | Potentiellement davantage de liberté, aucun prototype/benchmark réalisé |

Le [mode raw](https://www.tampermonkey.net/documentation.php?q=sandbox) permet l'accès aux variables lexicales du frontend. La séparation des modules ne doit pas être confondue avec une isolation cryptographique contre une page malveillante. Les données de page restent une source d'observations à confiance limitée. L'extension dédiée reste une option si l'accès aux contrats ou l'évolution de Tampermonkey l'exige ; aucun ancien composant Wplace de LOAD_UNPACKED n'a été réutilisé.

## 4. Protocole et sécurité

Modules : `packages/engine-service/src/geopixels/http-channel.ts`, `src/api/v1/connector-http.ts`, `browser/geopixels-http-transport.js`. La logique de pixels reste dans `geopixels-capture.js` et `geopixels-reader.js` ; aucun second moteur ou scheduler.

Parcours :

1. `npm run start:reader` génère une clé d'approbation de 256 bits en mémoire et l'affiche dans la console privée. Elle n'est pas distribuée par HTTP. Le démarrage ordinaire conserve les modes existants ; sans clé configurée, le transport HTTP n'est pas activé.
2. Le dashboard utilise cette clé pour demander un code à usage unique, valide 60 secondes, lié à une origine déclarée et au **transport HTTP**. Un code HTTP ne peut pas servir à ouvrir le WebSocket historique.
3. Le lecteur présente ce code à `/api/v1/connector/privileged/claim`. La revendication reste en attente : elle ne connecte pas encore le fournisseur.
4. L'utilisateur compare l'empreinte courte et confirme dans le dashboard, avec la clé locale privée.
5. Une capacité aléatoire distincte authentifie uniquement les opérations de lecture de ce canal ; stockage en mémoire, ni URL ni localStorage. Maximum absolu 10 minutes, inactivité 30 secondes, révocation possible.
6. Les observations conservent protocole 1, séquence, session opaque, projet, rectangle, pixels, horodatage de capture et ressources filtrées. ACK explicite de la dernière séquence. Après perte d'une réponse, seul le lot strictement identique est renvoyé une fois ; empreinte de contenu + séquence empêchent son application deux fois. Deux échecs ne deviennent pas un succès.

L'entrée privilégiée est **distincte** des routes de gestion. Elle accepte certains Origin d'extension, l'absence d'Origin ou une origine opaque, mais exige les capacités adaptées. Cela **n'atteste pas cryptographiquement l'origine de la page**. Les contrôles de gestion existants restent inchangés ; aucune modification du CORS général ou de la CSP du site.

Contrôles : Host IP littéral 127.0.0.1, socket distant de boucle locale, méthodes et chemins fermés, aucun proxy/URL arbitraire, absence d'Access-Control-Allow-Origin et préflight refusé, JSON strict. Claim : 2 Kio et 5/minute. Observations : 768 Kio maximum, deux enveloppes au plus et 65 536 pixels cumulés ; 25 requêtes authentifiées/s au maximum, plafond HTTP dédié 40/s avant parsing. Le client espace ses envois d'au moins 50 ms et forme des bandes de 16 384 pixels au plus. Le délai GM est borné à 8 secondes par un timer et abort propres, y compris lorsque le mode fetch de GM n'applique pas son timeout natif.

Les commandes/champs inconnus, cookies, tokenUser, achats et requêtes arbitraires sont refusés. L'identifiant local de compte sert uniquement à détecter un changement dans la page ; seul un UUID indépendant est envoyé. Aucune collecte de secrets de session du site. Les ressources absentes restent null, jamais une quantité d'énergie inventée. Le port écrivain réel et les achats restent indisponibles côté serveur et interface.

Limites de sécurité : un processus disposant des mêmes droits OS peut lire la mémoire, l'environnement, la console ou un fichier privé ; ce canal n'est pas un sandbox système. La clé d'approbation protège le nouveau couplage même contre une simple usurpation des en-têtes de gestion, mais ne transforme pas toute l'API locale historique en serveur multi-utilisateur authentifié. Les données d'une page modifiée peuvent être mensongères. Le périmètre demeure local et de confiance, à réexaminer avant une future fonction d'écriture réelle.

## 5. Validation réelle confirmée par l'utilisateur

Les interactions ont été effectuées manuellement par l'utilisateur dans son navigateur ; l'agent a consulté le récepteur local et conservé des relevés sans code ni clé. Aucune automatisation de son compte ou du site.

| Cas | Résultat réel |
|---|---|
| Panneau / version | 0.2.0 initial, puis 0.2.1 et **0.2.2** de diagnostic |
| CSP | WebSocket de page toujours interdit ; transport GM HTTP couplé et approuvé sans modifier la CSP |
| Contrat de couche | base-only-8367389, couche de base reconnue |
| Modèle | PNG asymétrique 8 × 5, 40 pixels, 38 cibles opaques et 2 transparentes |
| Région transparente chargée | 40 valeurs connues, dont 40 transparentes ; aucune inconnue ; ACK 124 ms |
| Région déjà colorée | 40 valeurs connues opaques, aucune inconnue ; pixel sondé #bd637d ; ACK 126 ms |
| Progression immédiate | 0 correct, 38 incorrects, 0 inconnu, cohérent avec des couleurs présentes différentes du modèle cible |
| Identité / orientation | Utilisateur : bon modèle, absence d'inversion confirmée ; positions natives transmises et visibles |
| Ressources | Énergie, capacité et monnaie reçues ; avertissement anciennes ou non datées visible, sans affirmer leur actualité |
| Déconnexion / reconnexion / révocation | Toutes explicitement confirmées par l'utilisateur ; observation post-révocation refusée, dashboard déconnecté |
| Placement / achat | Aucun essai ni aucune opération réelle |

### Pourquoi les 38 pixels redevenaient inconnus

Le lecteur extrayait bien 40 valeurs connues. Le relevé du serveur montre **0 / 38 / 0** dès la liaison, puis ce même état jusqu'à **30 000 ms** après la capture. Ensuite les données expirent et les cibles redeviennent inconnues. Le couplage reste actif grâce aux heartbeats ; ceux-ci ne capturent pas de nouveaux pixels. Les copies de texte tardives masquaient cette fenêtre.

Le correctif ajoute `captureAgeMs` et `captureExpired` au statut, un message explicite d'expiration et le libellé « Dernière capture reçue ». Aucun délai de fraîcheur n'a été allongé et aucune date de bitmap n'a été inventée. Les messages du lecteur indiquent aussi le nombre de valeurs extraites et les diagnostics bitmap/lecture moteur. La classification des pixels et la politique de fraîcheur sont conservées.

Preuves privées : `test-logs/phase2c/VALIDATION-REELLE-CONFIRMEE.json`, `reception-temps-reel.json`, versions initiales/diagnostics et journaux de recette. Les positions réelles et données de compte ne sont pas recopiées dans ce rapport destiné au dépôt. La version exacte du navigateur/Tampermonkey n'a pas été relevée de nouveau ; une compatibilité universelle n'est pas revendiquée.

## 6. Tests et performances

| Contrôle | Résultat |
|---|---|
| `npm run check:logged` | **869 tests réussis, 1 facultatif ignoré**, code 0 |
| Jest | 171 tests / 19 suites |
| Vitest | adapters-node 66, core 386 (+1 ignoré), engine-service 195, simulator 51 |
| Lint / TypeScript | Aucune erreur ; 47 avertissements backend hérités, frontend/packages sans avertissement |
| `npm run build` | Succès ; avertissement Vite hérité sur NODE_ENV, non bloquant |
| Sécurité HTTP réelle de boucle locale | 9 scénarios : ancien chemin de lecteur réel interdit, clé privée, approbation, Origin dédié, refus CORS/formulaire/non authentifié, schémas et taille, ACK identiques, révocation, grands lots |
| WebSocket factice historique | Protocole et reprises maintenus dans les tests et recettes ; aucun remplacement par un second scheduler |
| Edge / Firefox | Recettes complètes locales réussies, aucune erreur de page ni requête externe ; CSP effectivement reproduite |

Journaux finaux : `test-logs/2026-11-17T01-01-46-437Z-check.log`, `2026-11-17T01-07-56-350Z-build.log`, `test-logs/phase2c/{edge-final,firefox-complete}/`, `privileged-http-final.log`. Les noms horodatés des journaux sont en UTC ; la recette est datée du 17 novembre en heure locale.

Les tests couvrent changement de session/modèle/position, régions inconnues, alpha partiel, bitmap fermé ou taille incompatible, état de couche ambigu, réponse perdue et retransmission identique, interruption, expiration et révocation. Les tests existants de crash/journal/réconciliation du simulateur et du fournisseur factice restent verts. Les nouveaux tests de lecteur reprennent les cas pertinents du client WebSocket remplacé, avec séparation calculs/transport.

Les recettes de navigateur reproduisent une page locale sous l'origine de fixture GeoPixels, entièrement satisfaite par interception locale, **sans contacter le service**. L'API GM y est simulée par Node. Elles ne constituent pas une installation de Tampermonkey réel sous Edge et Firefox ; la validation utilisateur est décrite séparément ci-dessus. Un premier contrôle Firefox traitait mal l'exception synchrone de la sonde WebSocket ; la recette vérifie désormais l'événement CSP réellement reçu, sans désactiver CSP ni augmenter les timeouts.

Mesures, non benchmarks de production :

| Parcours | Mesure |
|---|---|
| ACK réel utilisateur, 40 valeurs | 124–127 ms |
| ACK HTTP local sur fixture navigateur | Environ 4–7 ms |
| Latence dashboard local après capture, Edge | Environ 866 ms, inclut polling et rendu |
| Même mesure Firefox | Environ 1 403 ms |
| 64 × 64 synthétique, transport GM simulé réel HTTP | 4 096 valeurs, 1 lot, environ 49 ms |
| 595 × 894 synthétique | 531 930 valeurs, 34 lots, environ 1,70 s |
| 2000 × 2000 synthétique | 4 000 000 valeurs, 250 lots, environ 12,50 s |

Ces trois dernières mesures incluent sérialisation, cadence et HTTP local, avec données inconnues synthétiques. Elles n'incluent pas le décodage d'une immense carte réelle, ni un placement. La limite reste 2000 × 2000 ; le cache peut être incomplet et le décodage répété entre bandes. Le détail brut figure dans `privileged-http-final.log` et les fichiers `http-metrics.json`.

La dernière revue a aussi fermé un contournement possible par l'ancien `POST /connector/pair` en mode read-only : il ne peut plus distribuer de code de lecteur réel sans le parcours HTTP approuvé. Le WebSocket du fournisseur local-fake reste opérationnel, vérifié séparément.

Une première passe complète a détecté l'ancienne assertion d'assemblage du userscript (deux sources contre quatre désormais) ; le test a été adapté au générateur, en ajoutant les contrôles de permissions et de syntaxe. Cette erreur n'a pas été masquée par un timeout ou un test ignoré.

## 7. Clone neuf et restauration applicative

Le code applicatif final est au commit **a79c15f8b85e5aa18846cad2355cf242f39c62ce**. Clone indépendant `--no-hardlinks`, sans alternates, dans un dossier temporaire neuf. Les **304 fichiers / 32 096 393 octets** de la sauvegarde applicative ont été restaurés séparément, tous vérifiés SHA-256 avant installation. Aucun node_modules ou build de développement n'a été copié.

`npm run setup:windows` a réussi sous Node **22.23.2** / npm **10.9.8** : installation depuis les lockfiles dans un cache npm temporaire, scripts désactivés, binaire canvas chargé et archive précompilée vérifiée, build, configuration existante conservée, démarrage API de contrôle et arrêt. Le lanceur `start.bat`, invoqué via `cmd /d /c` avec GEOPLACER_SETUP_ONLY=1, confirme l'installation complète ; aucun Ctrl+C physique n'est prétendu.

Une seconde vérification a ouvert **les données réellement restaurées**, retrouvé leur unique modèle et relu son image, avec le moteur arrêté et le lecteur HTTP désactivé faute de clé privée. Le processus était instrumenté pour refuser les accès aux dossiers Code d'origine : zéro accès détecté. Arrêt gracieux IPC, code 0. Le premier essai de ce garde-fou avait une erreur d'échappement dans le script de test, corrigée sans modification applicative ni augmentation de délai ; un lancement en contexte restreint avait également échoué avant création du processus enfant, puis réussi avec les permissions nécessaires.

Depuis ce clone : recette complète **Edge** et recette **HTTP Firefox** réussies. La recette complète Firefox a aussi réussi sur le dossier de développement. La fixture PNG est bien fournie par Git, sans dépendre du fichier privé créé en Phase 2B.

Preuves : `clone.json`, `clone.log`, `clone-setup.log`, `clone-final-start-bat.log`, `restauration-applicative.json`, `restauration-applicative.log`, `clone-final-edge/` et `clone-final-firefox/` sous `test-logs/phase2c/`.

## 8. Sauvegardes externes et preuves de restauration

Dossier créé : `D:\Téléchargements\Code\GeoPlacer-sauvegardes\2026-11-16-phase2c-avant-transport\`. Le nom correspond au début de la phase ; la clôture est datée du 17. Aucune instance du serveur GeoPlacer n'utilisait les données principales avant leur copie à froid. Le récepteur de recette a ensuite utilisé un profil séparé.

| Élément | Vérification |
|---|---|
| `GeoPlacer-avant-phase2c.bundle` | Toutes références et branches au départ, nouveau nom de branche inclus ; SHA-256 `5fb955cf3d1dc1f14ec15495b9b1f2011476206bc1e4b6a84d4949ff5eba14f4` |
| `wip-objects/all-objects-before-phase2b.pack` | Copie exacte du pack 4 611 objets ; SHA-256 `5847a9dd2e2c91c44852e100f3cc953b71a5297a81936333e246c27325afb939` |
| Manifestes et références | Copies vérifiées de refs-initial, unreferenced-commits, empreinte et comptes rendus de restauration ; références courantes sauvegardées séparément |
| Données applicatives privées | `.env`, configuration, modèles, journaux, checkpoints, simulateur, données du connecteur, sauvegardes et preuves ignorées pertinentes ; 304 fichiers, empreintes identiques après copie et restauration |
| Générés exclus | node_modules, dist et caches de compilation reconstruisibles ; ils ne remplacent pas une sauvegarde de données |
| Restauration Git | Bundle cloné en miroir indépendant ; pack injecté dans un autre dépôt nu vide, références recréées ; fsck réussis, pas d'alternates |

Quatre commits WIP retrouvés explicitement :

- `938fe05710b2ed300cb6ef2bd7911c9964fda8cf`
- `745de607b7f8dd041f665af2db326b292a32ebce`
- `52f32f4b7011631ae809342b4e34219713c5223f`
- `1eb4d4ebafac7709cc4cb592d39f12286547cd80`

Un utilitaire privé `restaurer-wip.mjs` et `RECUPERATION.md` accompagnent la copie externe. L'utilitaire a été exécuté dans un nouveau dépôt temporaire : pack vérifié, quatre références `refs/recovery/wip-*` créées uniquement dans ce dépôt de récupération, fsck réussi, aucun alternates. Aucune de ces références n'a été créée dans GeoPlacer.

Le bundle seul ne garantit pas leur conservation : conserver le pack et ses références avec lui. Les sauvegardes privées ne sont pas commitées. Les codes de couplage et sessions en mémoire ne sont pas restaurés. Un bundle du commit documentaire final sera fourni après ce dernier commit, avec son manifeste et une restauration indépendante, dans un nouveau dossier daté de sauvegardes ; son empreinte accompagne le compte rendu final.

Les copies restent sur le même disque : protection contre un nettoyage accidentel, pas contre la perte du disque. Conserver les jalons vérifiés et une copie sur autre support avant toute suppression future. Aucun git gc/prune, aucune rotation ni suppression de sauvegarde.

## 9. Copies historiques réalisées

Destination : `D:\Téléchargements\Code\Archives-Projets\`. Chemins absolus vérifiés, destinations absentes avant copie, liens/jonctions refusés, fichiers cachés inclus, nombre/taille/SHA-256 comparés. Aucun ancien script exécuté.

| Original conservé | Copie | Fichiers | Octets | SHA-256 du manifeste |
|---|---|---:|---:|---|
| GeoPlacer-phase0 | Archives-Projets/GeoPlacer-phase0 | 18 | 531 897 | `20b731a9e61cc196cce6d1399c1e8655f422bb0d76a880ecd03d3c3d212cbe60` |
| GeoPlacer-phase1a | Archives-Projets/GeoPlacer-phase1a | 32 | 99 498 | `89ad475b700f2d1966f9969c40abd3d5ce073a3a2bdcd3634729aaf599f9c14d` |

Seuls ces **deux originaux** sont candidats à un retrait lors d'une intervention ultérieure, après accord explicite et recontrôle des copies. Le gain de place est d'environ 0,6 Mo ; l'objectif est le rangement. GeoPlacer, GeoPlacer-Audit, GhostPixelBot-FR, les sauvegardes et les copies d'Archives-Projets ne sont pas proposés à suppression ici.

## 10. État Git, commits et rangement futur

Les six commits applicatifs/tests sont séparés :

- `ea50221` — canal HTTP, clé d'approbation et protocole de sécurité.
- `4782efd` — contrats de couche vérifiés.
- `87bfd66` — transport GM, lecteur et diagnostics.
- `06f9517` — interface d'approbation et expiration des captures.
- `24c214a` — recettes CSP, grands lots et fixture reproductible.
- `a79c15f` — fermeture de la distribution historique des codes de lecteurs réels WebSocket, avec régression dédiée.

Le présent rapport, le guide, le README et les notices de modifications sont enregistrés dans un commit documentaire distinct. La liste définitive s'obtient par `git log 54add74..feat/phase2c-connector-transport --oneline` ; aucun historique ancien n'est réécrit.

Main reste `46877e120f9e7bc721084fdf88a9ae8f006cb117`, la RC reste `fe392266a0605349f227e005a5e62904903b531f`, la branche 2B reste `54add74`. Les 20 branches locales antérieures sont conservées ; la 21e est la branche active 2C. Aucun tag ni remote changé, aucune branche distante modifiée. La RC ZIP fe39226 est conservée et ne doit pas être présentée comme contenant le lecteur 2C.

Conserver activement main, la RC et le portage 2C ; conserver les phases 2A et 2B comme références historiques récentes. Après publication autorisée d'une référence durable contenant leur histoire et restauration de sauvegarde vérifiée, candidates à archivage/suppression future :

- `backup/avant-reecriture-email`, `feat/phase1a-fondation`.
- `feat/phase1b0-workspace` jusqu'à `feat/phase1b10-demo-hardening` (toutes les onze branches, noms exacts dans le plan 2B).
- `feat/phase1c0-release-candidate`, `feat/geopixels-ghost-export`, `release/6.0.0-rc.1`.
- Les cinq branches de phases publiées uniquement après contrôle des PR/liens et conservation distante effective de leurs commits.

Leurs pointes sont ancêtres de la RC ou de la branche active selon le [plan vérifié 2B](PLAN-NETTOYAGE-GIT-DOSSIERS.md). Les références de récupération et les WIP ne doivent pas être éliminés parce qu'ils paraissent anciens. Aucun nom n'a été supprimé ici.

Main suit toujours upstream/main. Correction **future, non exécutée**, après validation de la promotion : `git branch --set-upstream-to=origin/main main`. L'avance rapide de main vers la RC reste possible dans l'état contrôlé ; ne pas lancer git pull sur main ni le promouvoir automatiquement vers un portage expérimental. Les contrôles et commandes de promotion/suppression restent soumis au plan 2B et à une autorisation nouvelle.

## 11. Limites et suite

- Pas de chargement global de carte ; lecture manuelle, cache local de fraîcheur non démontrée, capture retirée après 30 secondes. Les timestamps de curseur de synchronisation ne deviennent pas des dates.
- Le changement de position/modèle/palette/session détecté interrompt la liaison ; nouveau couplage et liaison explicite. La continuité automatique fera l'objet d'un travail dédié.
- Les couleurs/filtres natifs identifient une génération du projet, mais ne remplacent pas les paramètres du modèle local : l'utilisateur doit vérifier l'image et les filtres avant liaison.
- Contrat ancien vérifié réellement ; variantes Event Layers et erreurs couvertes localement, sans certification d'un déploiement futur. Tampermonkey réel sous Firefox/Edge n'a pas été installé par l'agent.
- Les ressources peuvent être observées sans être fraîches. Les politiques et coûts restent factices ; aucune dépense réelle, aucun ETA fondé sur une énergie inventée.
- Aucun exécuteur réel de placement, aucune authentification transférée. Le scheduler, TemplateManager, WorkPlanner, AttemptManager/Journal, ressources, progression, sauvegardes et API existants sont conservés.

Priorités suivantes : versionner de nouveaux contrats quand ils sont prouvés, améliorer couverture/fraîcheur et surveillance des changements, relier les priorités couleur/zones et projets multiples au scheduler existant, afficher historique et ETA avec leurs incertitudes. Toute future écriture doit garder intention durable, résultat validé et réconciliation sans renvoi aveugle ; toute dépense réelle doit rester confirmée explicitement lors des premiers essais.

Aucune publication ou opération destructive n'est autorisée par ce rapport. Après lecture, les décisions restantes concernent la conservation sur autre support, les suppressions nommées éventuelles, la promotion de main et une publication future distincte.
