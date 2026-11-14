# ADR 0003 : migration des routes de l'API vers `/api/v1/`

- **Date** : 14/11/2026
- **Statut** : **proposé** (plan seulement, aucune route modifiée ; inventaire complété et repli `GET`/`HEAD` validé en phase 1B.2)
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

## 2. Inventaire des routes et des appelants

Inventaire complété en phase 1B.2 (recherche dans `src/routes`,
`frontend/src` et toute l'extension `LOAD_UNPACKED` : arrière-plan,
popup, scripts de contenu, scripts injectés, page hors écran). L'extension
construit ses URL avec `getServerUrl(chemin)` (`http://<hôte>:<port><chemin>`,
`background/modules/core.js`) ; la popup, les scripts injectés et les
scripts de contenu n'appellent jamais le serveur directement : ils passent
par des messages vers l'arrière-plan.

### 2.1 Routes HTTP

| Méthode et route | Fichier serveur | Frontend | Extension héritée | Remarque |
|---|---|---|---|---|
| `GET /settings` | `routes/settings.ts` | `Settings.tsx`, `useServerStatus.ts` | — | collision F13 |
| `PUT /settings` | `routes/settings.ts` | `Settings.tsx`, `useSettings.ts` | — | |
| `GET /users` | `routes/users.ts` | `ManageUsers.tsx`, `AddTemplate.tsx` | — | collision F13 |
| `POST /user` | `routes/users.ts` | `ManageUsers.tsx`, `useUsers.ts` | `user-management.js` (envoi du cookie) | |
| `DELETE /user/:id` | `routes/users.ts` | `ManageUsers.tsx`, `useUsers.ts` | — | |
| `GET /user/status/:id`, `POST /users/status` | `routes/users.ts` | — | — | aucun appelant |
| `GET /templates` | `routes/templates.ts` | `ManageTemplates.tsx` | — | collision F13 |
| `POST /template` | `routes/templates.ts` | `AddTemplate.tsx` | — | |
| `DELETE /template/:id` | `routes/templates.ts` | `ManageTemplates.tsx` | — | |
| `PUT /template/:id`, `PUT /template/edit/:id`, `POST /templates/import` | `routes/templates.ts` | — | — | aucun appelant |
| `POST /template/:id/start` / `stop` | **absentes** | `ManageTemplates.tsx` | — | F12 |
| `POST /templates/start-all` / `stop-all` | **absentes** | `ManageTemplates.tsx` | — | F12 |
| `GET /overlay/coords` | `routes/overlay.ts` | `AddTemplate.tsx` | — | |
| `POST /overlay/coords` | `routes/overlay.ts` | — | `event-listeners.js` (arrière-plan) | coordonnées relevées sur la page |
| `GET /token-needed` | `routes/tokens.ts` | — | `token-refresh.js` | jeton anti-bot hérité, hors périmètre |
| `POST /t` | `routes/tokens.ts` | — | `event-listeners.js` (arrière-plan) | jeton anti-bot hérité, hors périmètre |
| `GET /logs` | `routes/logs.ts` | — | — | collision F13 ; les journaux passent par le WebSocket |
| `GET /errors` | `routes/logs.ts` | — | — | aucun appelant |
| `GET /palette` | `routes/palette.ts` | — | — | aucun appelant |
| `GET /color-ordering`, `GET`/`PUT /color-ordering/global`, `GET`/`PUT`/`DELETE /color-ordering/template/:templateId` | `routes/color-ordering.ts` | — | — | aucun appelant |
| `POST /bridge`, `GET /sign-request`, `POST /sign-response`, `POST /bot/activate` / `deactivate` | `routes/bridge.ts` | — | — | code anti-bot hérité, hors périmètre |
| `POST /reload-proxies` | `routes/proxy.ts` | — | — | rotation de proxys héritée, hors périmètre |
| `/api-docs` (Swagger) | `server.ts` | — | — | déjà hors de la racine applicative |

### 2.2 WebSocket (racine, même port que l'API)

| Message | Émetteur | Destinataire | Traité ? |
|---|---|---|---|
| `{type: 'logs'}` | frontend (`LogsViewer`, `useLogs`), extension (`websocket.js`) | serveur | oui : abonnement aux journaux |
| `{type: 'errors'}` | frontend (`LogsViewer`, `useLogs`) | serveur | oui : abonnement aux erreurs |
| `{type: 'system', message}` | serveur | clients abonnés | affiché |
| `{type: 'log', level, message}` | serveur (`utils/logger.ts`) | clients abonnés | affiché |
| `{type: 'bot-activate'}`, `{type: 'bot-deactivate'}` | serveur (`routes/bridge.ts`, `routes/templates.ts`) | extension | oui (code hérité, hors périmètre) |
| `{type: 'token-needed', needed}` | **jamais émis** par le serveur | extension | écouté mais mort (le jeton passe par `GET /token-needed`) |

Adresses : le frontend se connecte à `ws(s)://<hôte>:3000` (port fixé),
l'extension à `ws://<hôte>:<port réglé>`.

### 2.3 Repli de l'interface (décision validée)

Validé en phase 1B.2 : seul un `GET` ou un `HEAD` hors des préfixes
`/api`, `/ws` et `/api-docs` reçoit l'interface (ou le message 503
« interface non compilée »). Les autres méthodes, et tout chemin inconnu
sous `/api/`, reçoivent le vrai 404 JSON. Les routes héritées montées à la
racine sont résolues avant le repli : le repli ne masque aucune route
existante. Une fois les routes déplacées sous `/api/v1`, une route d'API
inconnue reste donc un 404, jamais une page HTML.

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
| **M3 bis** | WebSocket : supprimer l'écoute du message mort `token-needed` côté extension seulement si l'extension est conservée ; sinon rien. Les messages `bot-activate`/`bot-deactivate` restent hors du nouveau moteur. | — |
| **M4** | Supprimer les routes racine une fois le frontend migré **et** l'extension héritée retirée ou migrée. Commit séparé, justifié. | fin de la compatibilité |

### Routes sans appelant

Les routes sans appelant (`/palette`, `/color-ordering/*`, `/errors`,
`/user/status/:id`, `/users/status`, `PUT /template/:id`,
`PUT /template/edit/:id`, `/templates/import`) sont migrées comme les
autres en M1 (parité), puis réévaluées : elles seront remplacées par l'API
du nouveau gestionnaire de modèles (phase 1B.2) plutôt que conservées. Les
routes anti-bot et de proxys (`/t`, `/token-needed`, `/bridge`,
`/sign-*`, `/bot/*`, `/reload-proxies`) ne sont **pas** migrées : elles
sont hors périmètre de GeoPlacer et seront retirées avec l'extension
héritée.

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
