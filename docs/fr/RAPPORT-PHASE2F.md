# Phase 2F — essai unique de placement

Base : `6792de96dc66220af9686fa88c1f3a007875dbbf`. Branche locale : `feat/phase2f-single-pixel-writer`. GeoPlacer conserve la version `6.0.0-rc.1` ; le userscript passe à **0.5.0** pour identifier explicitement son nouveau port écrivain. Aucun placement ni achat réel exécuté pendant ce développement.

## Contrats examinés

Lecture ciblée, sans nouvel audit général :

- [GeoPixelsFront `74783afc5b7e3064a43eed20b0f6638007853324`](https://github.com/AntCDev/GeoPixelsFront/blob/74783afc5b7e3064a43eed20b0f6638007853324/wwwroot/js/index.js#L1527) : `placePixels`, `HexToInt`, chargement de `data.colors`, calcul et consommation de l'énergie ; version du 16 novembre 2026.
- [Contrat de production historique `83673896886c016a3d23bd46a2309570194a19da`](https://github.com/AntCDev/GeoPixelsFront/blob/83673896886c016a3d23bd46a2309570194a19da/wwwroot/js/index.js) : même corps d'écriture sur la couche de base ; version du 9 novembre 2026. Les empreintes déjà vérifiées par le lecteur restent utilisées.
- [GeoPixelsBotClean `756472d3ac90f1b72c5fc8354aa6e89b53b7ac85`](https://github.com/Fox3225/GeoPixelsBotClean/blob/756472d3ac90f1b72c5fc8354aa6e89b53b7ac85/ghostpixel-bot-clean.user.js#L358) : pont de placement et appel direct, version du 25 septembre 2026. Aucun transfert d'authentification au moniteur, achat, interception de session ou retry repris.

Le contrat retenu est `POST /PlacePixels`, sur l'origine GeoPixels courante, corps `{Token, Subject, UserId, Pixels:[{GridX, GridY, Color}]}`. La couleur est un entier RGB ; Y natif croît vers le haut. Succès uniquement si HTTP réussi **et** texte exactement `Ok`. Aucune idempotence serveur démontrée : aucune promesse « exactement une fois ». Les couches événementielles restent exclues. Les licences et attributions du projet sont conservées ; l'implémentation repose sur ces contrats, sans importer de moteur tiers.

## Fonctionnement obtenu

`SinglePixelWriter` (`packages/engine-service/src/geopixels/single-pixel-writer.ts`) réutilise WorkPlanner, ResourceManager et AttemptManager/Journal. C'est un coordinateur ponctuel, sans boucle de peinture ni second scheduler. Le fournisseur factice et le simulateur existants restent disponibles.

1. **Préparer** : un pixel connu incorrect du modèle lié, dans l'ordre de sa stratégie ; inconnus et transparence du modèle exclus. Intention, destination et réservation sont durables avant toute autorisation.
2. **Autoriser** : le dashboard exige la clé privée locale, une case explicite et la destination exacte. L'autorisation expire après 30 secondes, sans prolongation ; une préparation expirée peut être annulée puis refaite volontairement.
3. **Exécuter** : fournisseur factice via son port existant ; essai réel via une récupération HTTP unique dans le navigateur. `started` est journalisé **avant** livraison. Un clic physique puis une boîte de confirmation du pixel sont encore nécessaires dans Tampermonkey.
4. **Résultat** : seuls `confirmed`, `not-sent` ou `uncertain` traversent le canal local, avec l'identifiant d'opération. Une réponse tardive ne ferme pas une opération déjà arrêtée ou incertaine.
5. **Réconcilier** : après interruption, conserver la réservation ; exiger une observation source datée postérieure. Le cache réel actuellement non daté ne permet pas de lever cette incertitude. Un résultat observé n'attribue pas le placement à GeoPlacer.
6. **Progression** : calculée par le lecteur et les composants existants ; une réponse `Ok` ne recolore pas artificiellement la toile ou le cache local.

Le domaine durable séparé `providers/geopixels-writer/journal/` utilise les adaptateurs existants ; `connector-writer-intent.json` conserve l'identité sans permission ni secret. La sauvegarde applicative retire d’abord toute autorisation, attend le journal, inclut ces fichiers et diagnostique ce journal. Au redémarrage, aucune autorisation ni commande n'est restaurée ; une intention commencée devient incertaine. Le nouveau `AttemptManager.interrupt` conserve immédiatement cette réservation.

Le ResourceManager réserve **une autorisation locale**, sans estimer l'énergie du compte ni alimenter son ETA. Avant l'envoi, le navigateur exige une session présente, `currentEnergy >= 1`, la couleur dans `userData.colors`, une file native vide et aucun placement natif en cours. GeoPixels reste l'autorité d'acceptation.


## Sécurité et limites

Le couplage approuvé, la capacité éphémère, l'expiration absolue et la révocation sont conservés. Les routes sont strictes, sans proxy, URL arbitraire ou achat. La clé privée est exigée côté dashboard ; le canal n'atteste pas cryptographiquement l'origine de la page.

Le port navigateur est séparé du lecteur : `fetch` de même origine, sans redirection ni retry. Token, sujet et identifiant de compte restent dans le navigateur ; seuls identifiant d'opération et résultat normalisé rejoignent GeoPlacer. Un registre sessionStorage précède l'appel ; son échec interdit l'envoi. Un seul appel réel est permis par chargement de page.


**Arrêt immédiat** retire une préparation ou conserve un envoi commencé en état incertain. Il ne peut pas annuler rétroactivement une requête déjà reçue par GeoPixels. Déconnecter le lecteur interrompt aussi son appel navigateur. Le dialogue de confirmation et le contrôle local final réduisent la fenêtre entre autorisation et envoi sans promettre d'annulation atomique à travers le réseau.

Le lecteur passif 0.4.0 reste compatible avec les observations, mais ne sait pas exécuter cet essai. Le lecteur 0.5.0 et les variables de session du port écrivain restent **à valider dans Tampermonkey sur le vrai site**. L'estimation locale `currentEnergy` peut être ancienne ; aucun refus ou résultat ambigu du service n'est traité comme un succès. Aucun dessin autonome, achat, multi-agent ou file de placements réels n'est ajouté. Pendant une intention ouverte, les changements de source, de modèle et de position restent bloqués ; une incertitude réelle non résolue impose de conserver ce profil pour diagnostic. La simulation reste utilisable dans un profil distinct.

## Validation locale

| Vérification | Résultat |
|---|---|
| `npm.cmd run check:logged` | Vert : 954 tests réussis, 1 facultatif ignoré ; types et lints inclus |
| Tests finaux écrivain | 29 réussis, dont le cas supplémentaire interdisant une réconciliation réelle depuis le fournisseur simulé |
| HTTP local de bout en bout | 8 scénarios, inclus dans Jest : préparation, approbation, livraison unique, exécution navigateur factice, progression, réponse perdue, arrêt, révocation |
| Build et syntaxe userscript | Verts, version 0.5.0 générée de façon déterministe |
| Edge et Firefox Playwright | Verts : fournisseur factice, lecteur régional, vrai formulaire et confirmation navigateur ; appel site remplacé par un stub, aucune requête externe |
| Reprise | Sortie réelle d'un processus après journalisation `started`, reprise incertaine sans renvoi ; sauvegarde/restauration indépendante du domaine écrivain vérifiée |

Les tests ciblés recouvrent principalement le contrôle complet : ne pas additionner les deux nombres. Les 51 tests du simulateur sont verts. Les contrôles conservent 47 avertissements ESLint `any` dans le backend hérité et l'avertissement Vite sur `NODE_ENV`, sans échec. Aucun changement de dépendances ou d'installation : pas de clone neuf supplémentaire.

Journaux locaux ignorés par Git : `test-logs/2026-11-17T23-36-01-369Z-check.log`, `test-logs/phase2f-final-writer-tests.log`, `test-logs/2026-11-17T23-47-36-397Z-build.log`, `test-logs/phase2f-edge.log`, `test-logs/phase2f-firefox.log`. Captures et métriques sous `test-logs/phase2f/{edge,firefox}/` ; ce sont des pages **factices**, pas une validation Tampermonkey ou du service réel.

Un commit local regroupe cette intégration et sa documentation sur la branche 2F. `main` reste à `cb6521dd1890839ce50f3c0a6cae127451fc71da` ; aucune publication, suppression, modification de remote, création de tag ou release. Relecture des fichiers et recherche de signatures de secrets : aucun secret réel ni donnée applicative inclus.

## Prochain essai utilisateur — un pixel, après accord

1. Garder tous les autres bots arrêtés, sauvegarder le fantôme et sa position. Ne pas placer manuellement ni déplacer le fantôme pendant l’essai. Lancer `npm.cmd run start:reader` après build ; ouvrir directement l'adresse locale, saisir la clé uniquement dans le dashboard.
2. Installer **0.5.0**, désactiver les anciens lecteurs, recharger GeoPixels, coupler et comparer l'empreinte. Observer un petit fantôme puis lier explicitement le bon modèle. Garder la surveillance en pause pour examiner tranquillement la destination.
3. Cliquer uniquement **Préparer un pixel**. Relever le modèle, l'origine exacte du site, la couche de base, X/Y natifs, la couleur et l'état du cache. **Ne pas cocher l'autorisation ni cliquer sur le bouton d'essai navigateur avant votre accord explicite sur ces éléments.**
4. Après cet accord, préparer à nouveau si la réservation a expiré ; vérifier que la destination est strictement la même. Cocher l'autorisation et confirmer dans le dashboard, puis cliquer « Examiner le pixel préparé » dans Tampermonkey et contrôler une dernière fois la boîte de confirmation.
5. En cas de `Ok`, vérifier la couleur dans l'interface native, observer de nouveau et distinguer résultat de l'opération et progression mesurée. Ne pas déclencher de rafraîchissement automatique de tuiles.
6. En cas de réponse absente, refus non confirmé ou arrêt : **aucun renvoi**. Conserver l'intention incertaine et ses journaux ; le cache non daté ne suffit pas à la réconciliation. Arrêter l'essai, révoquer le canal et transmettre seulement les états, sans clé ni données de compte.

Suite prioritaire après cet essai : disposer d'une preuve de fraîcheur exploitable pour réconcilier les résultats réels ambigus, avant d'envisager une boucle d'écriture. Ce rapport ne valide aucun placement réel.
