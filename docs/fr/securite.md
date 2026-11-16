# Sécurité du serveur local

## Modèle de menace

Le serveur tourne sur la machine de l'utilisateur. En V1, il ne détient
que des données de simulation (modèles, toile simulée, réglages) ; le code
hérité pouvait détenir des cookies de session de comptes réels, d'où les
protections ci-dessous. Deux
catégories d'attaquants sont prises en compte :

1. **Une page web ouverte dans le navigateur de l'utilisateur.** Elle peut
   envoyer des requêtes vers `127.0.0.1` (CSRF), tenter un DNS rebinding pour
   lire les réponses, ou ouvrir un WebSocket.
2. **Une machine du réseau local**, si le serveur écoute sur toutes les
   interfaces.

Un logiciel malveillant déjà présent sur la machine n'est pas couvert : il
peut lire directement les fichiers de `data/`.

## Protections en place (Phase 1A)

| Protection | Mise en œuvre | Code |
|---|---|---|
| Écoute locale par défaut | `HOST` validé, `127.0.0.1` si absent ou invalide | `src/config/network.ts` |
| Anti DNS rebinding | Seuls les en-têtes `Host` désignant cette machine sont acceptés (comparaison sur le nom, pas sur le port) | `src/middleware/local-access.ts` |
| Anti requêtes intersites | `Origin` vérifiée (motifs ancrés et échappés) ; sans `Origin`, refus si `Sec-Fetch-Site: cross-site` | idem |
| WebSocket | Même contrôle à la poignée de main | idem + `src/server.ts` |
| CORS | En-têtes accordés uniquement aux origines autorisées ; un refus donne un 403, pas une 500 | `src/server.ts` |
| Limiteur de débit | Toutes les routes, avant l'analyse du JSON | `src/server.ts` |
| Taille des requêtes | 12 Mo par défaut ; un dépassement donne un 413 | `src/server.ts`, `src/middleware/error-handler.ts` |
| Validation | Zod 4.6.7, collections bornées, matrices et cookies validés avec arrêt au premier élément invalide (GHSA-mrhx-c7xc-m3w5) | `src/middleware/validation.ts` |
| Secrets dans l'API | `GET /users` ne renvoie jamais les cookies (`hasCookies` à la place) | `src/routes/users.ts`, `src/utils/redact.ts` |
| Secrets dans les logs | Format Winston qui masque cookies, jetons, en-têtes et JWT avant tout transport (fichiers, console, WebSocket) | `src/utils/log-redaction.ts` |

Toutes les fonctions de décision sont pures et couvertes par des tests
(`src/__tests__/`). Un test de démarrage réel a vérifié 15 cas d'attaque
(Host forgé, origine étrangère ou trompeuse, requête intersite, WebSocket
étranger, limiteur de débit).

## Isolation du code hérité (Phase 1B.10)

GeoPlacer V1 est une **simulation locale**. Le code hérité de Wplacer
(comptes réels, ancien moteur de dessin, jetons anti-bot, proxys) reste
dans le dépôt pour la traçabilité du fork, mais il est **neutralisé par
deux verrous indépendants**, côté serveur et pas seulement dans
l'interface :

1. **Routes refusées** (`src/middleware/legacy-guard.ts`), avant leur
   traitement, avec une réponse stable : `410` et
   `{ "error": "Désactivé dans GeoPlacer V1 …", "code": "LEGACY_DISABLED" }`.
   Le refus ne dépend ni de la casse, ni d'une barre finale, et `HEAD`
   est traité comme `GET`.

   | Route | Fonction héritée |
   |---|---|
   | `POST /user`, `GET /user/status/:id`, `POST /users/status` | Connexion et vérification de comptes réels |
   | `POST /template`, `POST /templates/import`, `PUT /template/edit/:id` | Modèles de l'ancien moteur |
   | `PUT /template/:id` (sauf `{"running": false}` : l'arrêt reste permis) | Démarrage de l'ancien moteur |
   | `GET /token-needed`, `POST /t`, `GET /sign-request`, `POST /sign-response` | Jetons et signatures anti-bot |
   | `POST /bridge` | Pont de l'extension héritée |
   | `POST /bot/activate`, `POST /bot/deactivate` | Activation de l'ancien moteur |
   | `POST /reload-proxies` | Proxys |

2. **Client réseau hérité fermé** (`src/services/http-client.ts`) :
   `initialize`, `fetch` et `switchUser` lèvent
   `LegacyNetworkDisabledError` avant tout accès au réseau. Même une route
   oubliée par le premier verrou ne peut rien envoyer.

En plus :
- le **keep-alive** horaire des comptes n'est jamais planifié ;
  `LEGACY_KEEPALIVE=1` est ignoré, avec un avertissement au démarrage ;
- les pages « Users », « Templates » et « Add template » ne sont plus dans
  le menu ; leur adresse directe affiche « Désactivé dans GeoPlacer V1 » ;
- restent disponibles les fonctions héritées **purement locales** :
  liste et suppression des comptes et modèles hérités déjà enregistrés,
  paramètres, journaux, palette, ordre des couleurs, coordonnées de
  superposition.

Les protections Host, Origin, CORS, le limiteur de débit et la taille
maximale des requêtes sont **inchangés** : le verrou est monté après
elles.

### Vérifications (Phase 1B.10)

| Vérification | Où |
|---|---|
| Chaque route désactivée répond 410 `LEGACY_DISABLED` sans exécuter son traitement ; contournements (casse, barre finale, `HEAD`, démarrage déguisé) refusés ; routes locales conservées | `src/__tests__/legacy-isolation.test.ts` |
| Le client réseau hérité refuse tout ; une connexion de compte héritée échoue avant le réseau ; **aucune connexion** hors de la boucle locale pendant ces tests (`net.Socket.prototype.connect` espionné, `impit` simulé) | idem |
| Contre-épreuve : sans le verrou des routes, 16 de ces tests échouent | essai manuel, non commité |
| Serveur réel : `LEGACY_KEEPALIVE=1` ignoré, `POST /user` refusé (410), écoute sur `127.0.0.1` par défaut, aucun fichier servi hors des dossiers prévus (`package.json`, `data\engine`, `sauvegardes\`, y compris par `..%2f` ou `%5c`) | `src/__tests__/server-engine.test.ts` |
| Une simulation complète, une sauvegarde et les diagnostics n'ouvrent **aucune connexion réseau** | `packages/engine-service/test/service.test.ts` |
| Origine étrangère ou d'extension refusée (HTTP et WebSocket), Host forgé refusé | `engine-api.test.ts`, `server-engine.test.ts`, `local-access.test.ts` |
| Dans le navigateur : pages héritées désactivées, démarrage hérité refusé (410), aucune requête de la page vers un autre hôte (contre-épreuve faite) | recettes Edge et Firefox (voir [recette-navigateur.md](recette-navigateur.md)) ; `npm start` et `npm run dev` sur un clone neuf |
| Tous les appels réseau sortants du code hérité passent par le client fermé (`tile-manager.ts`, `wplacer-client.ts` → `http-client.ts`) | revue du code (`src/`) |

### Fichiers

- La **sauvegarde** depuis l'API écrit uniquement dans le dossier choisi
  par le serveur (`sauvegardes\` ou `GEOPLACER_BACKUP_DIR`) : aucun chemin
  n'est accepté du client.
- La **restauration** (ligne de commande seulement) refuse tout fichier du
  manifeste dont le chemin sortirait de `donnees\` (`..`, chemin absolu).
- La **démonstration** ne s'installe que sur un projet vide et ne touche
  jamais un projet existant ; `npm run demo` utilise son propre dossier,
  `data\demo`.

## Limites connues

- **Cookies stockés en clair** dans `data/users.json` (et ses `.bak`). Un
  chiffrement local (DPAPI sous Windows) est à étudier.
- **Aucune authentification sur l'API locale.** La protection repose sur
  l'écoute locale et sur les contrôles Host/Origin. En mode réseau
  (`HOST=0.0.0.0`), toute machine du réseau local peut piloter le serveur.
- **`chrome-extension://*` est autorisé par défaut** pour l'extension
  héritée de Wplacer : toute extension du navigateur peut appeler l'API.
  L'extension sera retirée du périmètre GeoPlacer.
- **Code de contournement anti-bot hérité** (imitation de navigateur par
  `impit`, injections Turnstile et pawtect, proxys, extension
  `LOAD_UNPACKED`) : toujours présent dans le dépôt, hors périmètre
  GeoPlacer, mais **neutralisé** depuis la Phase 1B.10 (voir ci-dessus).
  Sa suppression fera l'objet de commits séparés et justifiés.
- **Comptes hérités déjà enregistrés** : `data/users.json` peut encore
  contenir des cookies d'une installation antérieure. Ils ne sont plus
  utilisés ; les supprimer avec l'API héritée (`DELETE /user/:id`) ou en
  effaçant ce fichier, serveur arrêté.
- **Routes héritées sans validation de corps** : ordre des couleurs,
  overlay. Les autres (`/templates/import`, `PUT /template/:id`,
  `/bridge`, `/t`) sont désormais refusées avant leur traitement.
- **`.env`** (résolu en Phase 1B.0) : retiré du suivi Git, ignoré avec
  les autres `.env.*` sauf les exemples, généré depuis `.env.example`. Les
  versions historiques ne contenaient aucun secret (historique non réécrit).
- **Croissance des journaux** : les requêtes bloquées sont journalisées
  avant le limiteur de débit, et les fichiers de log n'ont pas de rotation.
- **Vulnérabilités npm restantes** : aucune haute. `glob` (modérée, via
  `swagger-jsdoc`) n'est utilisé qu'au démarrage sur un motif fixe. Les
  autres touchent l'outillage de développement (Jest, typescript-eslint).

## Règles pour les contributions

- Ne jamais renvoyer un objet `User` brut dans une réponse : utiliser
  `toPublicUser()`.
- Ne jamais journaliser d'en-têtes, de cookies ni de corps de requêtes
  d'authentification. Le masquage automatique est une défense en profondeur,
  pas une autorisation.
- Toute collection reçue d'un client doit être bornée (`.max()`) ou validée
  avec arrêt anticipé.
