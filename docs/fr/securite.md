# Sécurité du serveur local

## Modèle de menace

Le serveur de gestion tourne sur la machine de l'utilisateur et détient des
données sensibles (cookies de session des comptes, modèles, paramètres). Deux
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
  `impit`, injections Turnstile et pawtect, proxys) : toujours présent, hors
  périmètre GeoPlacer. Sa suppression fera l'objet de commits séparés et
  justifiés.
- **Le code hérité reste un client Wplace fonctionnel** (keep-alive horaire
  des comptes, vérifications de statut). Ne pas ajouter de compte tant que
  ce code n'est pas retiré.
- **`GET /sign-request`** (mécanique de signature anti-bot héritée) renvoie
  le corps d'une requête de placement en attente, qui peut contenir un jeton
  Turnstile. Route protégée par les contrôles Host/Origin, à retirer avec
  l'extension.
- **Routes sans validation de corps** : `/templates/import`,
  `PUT /template/:id`, ordre des couleurs, overlay, `/bridge`, `/t`. À
  vérifier en particulier : le décodeur de codes de partage (RLE), dont la
  sortie peut dépasser la limite d'entrée de 12 Mo.
- **`.env` est versionné** bien que listé dans `.gitignore`. Tout secret
  qui y serait ajouté apparaîtrait dans Git. Ne pas y mettre de secret ; le
  retirer du suivi demandera une étape de copie depuis `.env.example`.
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
