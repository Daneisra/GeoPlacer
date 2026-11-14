# ADR 0003 : migration des routes de l'API vers `/api/v1/`

- **Date** : 14/11/2026
- **Statut** : **proposé** (plan seulement, aucune route modifiée)
- **Corrige** : F13 (collision entre les pages React et l'API) ; prépare F12

## 1. Contexte

L'API héritée est montée à la racine. En production, le serveur sert aussi
l'interface React (application monopage) depuis la même origine. Les
chemins de quatre pages sont donc **aussi** des routes de l'API : un
rafraîchissement (F5) sur ces pages renvoie du JSON ou du texte brut au lieu
de l'interface (F13).

| Page React | Route API en collision | Effet d'un F5 |
|---|---|---|
| `/logs` | `GET /logs` (fichier de log brut) | texte brut |
| `/users` | `GET /users` | JSON |
| `/templates` | `GET /templates` | JSON |
| `/settings` | `GET /settings` | JSON |

Autres constats :
- En développement, le proxy Vite ne relaie que 7 préfixes (`/users`,
  `/user`, `/templates`, `/template`, `/settings`, `/token-needed`, `/t`).
- Le WebSocket des logs vise la racine, avec un port **fixé à 3000** dans
  `LogsViewer`.
- F12 : l'interface appelle `/template/:id/start`, `/template/:id/stop`,
  `/templates/start-all` et `/templates/stop-all`, qui n'existent pas.

## 2. Inventaire (recherche textuelle dans `frontend/src` et `LOAD_UNPACKED`)

| Méthode et route | Frontend | Extension héritée | Remarque |
|---|---|---|---|
| `GET/PUT /settings` | oui | — | collision F13 |
| `GET /users` | oui | — | collision F13 |
| `POST /user`, `DELETE /user/:id` | oui | `POST /user` | |
| `GET /templates` | oui | — | collision F13 |
| `POST /template`, `DELETE /template/:id` | oui | — | |
| `PUT /template/:id`, `PUT /template/edit/:id`, `POST /templates/import` | — | — | aucun appelant trouvé |
| `POST /template/:id/start` / `stop`, `POST /templates/start-all` / `stop-all` | oui | — | **absentes du serveur** (F12) |
| `GET/POST /overlay/coords` | `GET` | `POST` | |
| `GET /token-needed`, `POST /t` | — | oui | jeton Turnstile (code anti-bot hérité) |
| `GET /logs`, `GET /errors` | — | — | collision F13 pour `/logs` |
| `GET /palette`, `/color-ordering/*` | — | — | aucun appelant trouvé |
| `GET/POST /user/status/:id`, `/users/status` | — | — | aucun appelant trouvé |
| `POST /bridge`, `GET /sign-request`, `POST /sign-response`, `POST /bot/activate` / `deactivate`, `POST /reload-proxies` | — | — | code anti-bot ou proxys hérités, hors périmètre |
| WebSocket (racine) | `LogsViewer`, `useLogs` | `websocket.js` | port 3000 fixé côté frontend |
| `/api-docs` (Swagger) | — | — | |

## 3. Cible

- Toutes les routes de l'API sous **`/api/v1/`** (par exemple
  `GET /api/v1/settings`), et le WebSocket sur **`/api/v1/ws`**.
- Tout chemin hors `/api/` sert l'interface, si elle est compilée (voir la
  décision 4 de l'ADR 0002, § 10).
- Le versionnement permettra une future `/api/v2/` sans casser les clients.

## 4. Migration progressive (un commit testé par étape)

| Étape | Contenu | Compatibilité |
|---|---|---|
| **M0** | Extraire de `server.ts` une fabrique `createApp()` sans effet de bord (aucune écoute à l'import), pour tester les routes en Jest. Aucun changement de comportement. | totale |
| **M1** | Monter chaque routeur **à la fois** sous `/api/v1` et à la racine. Les routes racine deviennent obsolètes : en-têtes `Deprecation: true` et `Link: </api/v1/...>; rel="successor-version"`, un avertissement de log par route. Une requête de **navigation** (`GET` avec `Accept: text/html`, sans `X-Requested-With`) sur un chemin de page reçoit l'interface. **F13 est corrigé dès cette étape.** | routes racine conservées pour les appels de l'API |
| **M2** | Frontend : `axios.defaults.baseURL = '/api/v1'` ; WebSocket sur `ws(s)://<hôte courant>/api/v1/ws`, ce qui supprime le port fixe ; proxy Vite réduit au seul préfixe `/api` (`ws: true`). | les routes racine restent pour l'extension |
| **M3** | F12 : sous `/api/v1`, les routes de démarrage et d'arrêt répondent **501 Not Implemented** avec un message explicite, tant que le nouveau moteur n'est pas branché. | — |
| **M4** | Supprimer les routes racine une fois le frontend migré **et** l'extension héritée retirée ou migrée. Commit séparé, justifié. | fin de la compatibilité |

## 5. Critères de validation

- Un F5 sur `/`, `/logs`, `/users`, `/templates`, `/templates/add` et
  `/settings` renvoie l'interface (200, `text/html`) : tests automatisés
  (Jest sur `createApp()`) et recette navigateur.
- Chaque route `/api/v1/*` répond comme son équivalent racine. Test de
  parité pour toutes les routes de l'inventaire.
- Pendant M1–M3, une route racine appelée en XHR répond en JSON avec les
  en-têtes d'obsolescence.
- Le WebSocket fonctionne sur `/api/v1/ws`, sur tout port.
- Les protections Host/Origin, le limiteur de débit et les limites de taille
  s'appliquent à l'identique sous `/api/v1`.
- `npm run check` reste vert ; aucune régression des 94 tests Jest.

## 6. Risques

- Le contournement par `Accept: text/html` (M1) dépend des en-têtes du
  navigateur. Il est couvert par des tests et disparaît à l'étape M4.
- Des clients non inventoriés (scripts personnels) pourraient appeler les
  routes racine. D'où la période d'obsolescence et les avertissements de
  log.
