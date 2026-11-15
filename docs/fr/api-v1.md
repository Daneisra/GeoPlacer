# API `/api/v1` du moteur (Phase 1B.9)

La V1 de GeoPlacer est un **environnement de simulation local**. Ces routes
pilotent le nouveau moteur sur la toile simulée locale. Elles ne parlent à
aucun service réel et ne manipulent ni compte, ni session, ni jeton.

Les routes héritées (`/users`, `/templates`, `/settings`…) sont inchangées,
toujours montées à la racine, et ne concernent pas le nouveau moteur.

## 1. Protections

Toutes les routes passent par les protections de la Phase 1A
(`src/app-base.ts`) :

- écoute sur `127.0.0.1` par défaut ;
- contrôle de l'en-tête `Host`, contre le rebinding DNS ;
- contrôle de l'en-tête `Origin`, contre les requêtes intersites ;
- limiteur de débit (300 requêtes par minute par défaut) ;
- taille maximale du corps JSON.

En plus, sous `/api/v1` :

| Règle | Réponse |
|---|---|
| Origine d'une extension de navigateur (`chrome-extension://…`), pourtant acceptée par les routes héritées | 403 `FORBIDDEN_ORIGIN` |
| Requête qui modifie l'état (`POST`, `PUT`, `PATCH`, `DELETE`) sans `Content-Type: application/json` : un formulaire HTML intersite ne peut pas l'envoyer sans requête préalable | 415 `JSON_REQUIRED` |
| Corps ou paramètres hors schéma Zod strict : champ inconnu, type faux, taille dépassée | 400 `INVALID_REQUEST`, avec au plus 10 problèmes détaillés |
| Route inconnue sous `/api/v1` | 404 `NOT_FOUND` en JSON, jamais l'interface |
| Erreur interne | 500 `INTERNAL_ERROR`, sans pile ni chemin (le détail reste dans le journal du serveur) |

Aucune route n'expose de secret. Les réponses portent
`Cache-Control: no-store`.

## 2. Format des erreurs

```json
{ "error": { "code": "ENGINE_BUSY", "message": "changing the template is refused while the simulation runs: stop it first" } }
```

Le `code` est stable : l'interface s'appuie dessus. Le message est lisible
mais peut évoluer.

| Code | HTTP | Cause |
|---|---|---|
| `NO_TEMPLATE_SELECTED` | 409 | Démarrage sans modèle sélectionné |
| `TEMPLATE_NOT_FOUND` | 404 | Modèle inconnu ou illisible |
| `TEMPLATE_OUTSIDE_CANVAS` | 409 | Le modèle, à sa position, déborde de la toile simulée |
| `ENGINE_BUSY` | 409 | Changement de modèle ou de réglages, réinitialisation ou amélioration pendant que la simulation écrit ; ou un arrêt est en cours |
| `NOT_RUNNING` | 409 | Pause alors que rien ne tourne |
| `NOT_PAUSED` | 409 | Reprise alors que la simulation est arrêtée : utiliser `start` |
| `PAUSED_USE_RESUME` | 409 | Démarrage alors que la simulation est en pause |
| `COMPACTION_IN_PROGRESS` | 409 | Un compactage est déjà en cours |
| `COMPACTION_REFUSED` | 409 | Compactage refusé par le journal (journal endommagé : réparer d'abord) |
| `WORLD_UNAVAILABLE` | 409 | La toile simulée sauvegardée est endommagée ou d'une autre configuration : réinitialisation explicite nécessaire |
| `WORLD_RESET_REQUIRED` | 409 | Nouvelle taille de toile ou nouvelles règles sans `resetWorld: true` |
| `CONFIRMATION_REQUIRED` | 400 | Réinitialisation sans `"RESET"`, ou amélioration sans `confirm: true` |
| `STALE_PROPOSAL` | 409 | La proposition d'amélioration ne correspond plus à l'état de l'agent : relire `/resources` |
| `UPGRADE_REFUSED` | 409 | Amélioration impossible (monnaie, niveau maximal…) |
| `INVALID_SETTINGS`, `INVALID_TEMPLATE` | 400 | Réglage hors limites, PNG invalide |
| `ENGINE_CLOSED` | 503 | Le serveur s'arrête |

## 3. Routes

### Moteur

| Méthode et route | Corps | Effet |
|---|---|---|
| `GET /api/v1/engine/status` | — | État complet (voir § 4) |
| `POST /api/v1/engine/start` | `{}` | Démarre. **Idempotent** : déjà en cours, `changed: false`. Deux démarrages simultanés n'en font qu'un. En pause : `PAUSED_USE_RESUME` |
| `POST /api/v1/engine/pause` | `{}` | Aucune nouvelle tentative après l'opération en cours. Déjà en pause : `changed: false` |
| `POST /api/v1/engine/resume` | `{}` | Reprend. Déjà en cours : `changed: false`. À l'arrêt : `NOT_PAUSED` |
| `POST /api/v1/engine/stop` | `{ "abort"?: boolean }` | Arrête après l'écriture en cours, ou pendant celle-ci avec `abort` (l'écriture reçoit le signal d'abandon). Une tentative démarrée est réconciliée, ou signalée ouverte puis réconciliée au démarrage suivant : **jamais abandonnée**. Des arrêts simultanés partagent un seul résultat. Déjà arrêté : `changed: false` |
| `PUT /api/v1/engine/selection` | `{ "templateId" }` | Sélectionne le modèle. Refusé pendant l'exécution (`ENGINE_BUSY`) |
| `GET /api/v1/engine/progress` | — | État, modèle et statut de l'ordonnanceur |
| `GET /api/v1/engine/attempts` | — | Tentatives ouvertes (depuis le journal) et 100 dernières closes |

Les commandes répondent `{ "changed": boolean, "status": … }`.

### Modèles de la simulation

| Méthode et route | Corps | Effet |
|---|---|---|
| `GET /api/v1/templates` | — | Liste |
| `POST /api/v1/templates` | `{ name, pngBase64, x, y, strategy }` | Import : PNG de 8 Mio au plus, couleurs ramenées à la palette de démonstration. 8 stratégies possibles |
| `GET /api/v1/templates/:id` | — | Informations |
| `GET /api/v1/templates/:id/image` | — | Image quantifiée de la révision courante (base64, int32 petit-boutiste, `-1` = transparent) |
| `POST /api/v1/templates/:id/move` | `{ x, y }` | Nouvelle révision à une autre position. **Permis pendant l'exécution** : l'ordonnanceur suit la révision, annule les tentatives non démarrées et réconcilie les autres |

### Simulateur

| Méthode et route | Corps | Effet |
|---|---|---|
| `GET /api/v1/simulator/settings` | — | Réglages (toujours `simulated: true`) |
| `PUT /api/v1/simulator/settings` | `{ simulator?, agent?, run?, resetWorld? }` | À l'arrêt seulement. Taille de toile, coût, capacité ou régénération : `resetWorld: true` exigé |
| `POST /api/v1/simulator/reset` | `{ "confirm": "RESET" }` | Nouveau monde simulé vide ; l'ancien est **conservé** dans `world-reset-<date>` |
| `POST /api/v1/simulator/agent/reset` | `{}` | Remet l'agent simulé à ses ressources de départ |
| `POST /api/v1/simulator/external-edit` | `{ "count" }` | Démonstration : un « autre acteur » efface jusqu'à `count` pixels du modèle (détectés, puis repeints) |
| `GET /api/v1/simulator/canvas` | `?x&y&w&h` (les quatre, ou aucun) | Région de la toile (par défaut, la zone du modèle sélectionné) avec le numéro de séquence qu'elle inclut (voir [websocket.md](websocket.md)). 2048 × 2048 pixels au plus |

### Ressources et améliorations simulées

| Méthode et route | Corps | Effet |
|---|---|---|
| `GET /api/v1/resources` | — | Énergie, capacité, régénération, monnaie, couleurs, niveaux, et propositions de l'`UpgradePlanner` avec leur effet estimé sur le temps restant |
| `POST /api/v1/resources/upgrades` | `{ proposalId, "confirm": true }` | Applique **une** proposition au seul monde simulé local. Refusé sans confirmation, pendant une écriture, ou si l'agent a changé depuis la proposition |

Aucune dépense n'est jamais automatique.

### Journal

| Méthode et route | Corps | Effet |
|---|---|---|
| `GET /api/v1/journal/diagnosis` | — | À l'arrêt : diagnostic complet des fichiers (lecture seule, noms relatifs, aucun contenu). Pendant l'exécution : statistiques seulement, pour ne pas lire des fichiers en cours d'écriture |
| `POST /api/v1/journal/compact` | `{}` | Compacte le journal, puis écrit un checkpoint de la toile simulée. Un seul à la fois |

## 4. Statut

`GET /engine/status`, le message `hello` du WebSocket et les événements
`status` portent le même objet :

- `mode` : toujours `"simulation"` en V1 ;
- `state` (huit états de l'ordonnanceur) et `reason` ;
- `stream` et `seq` : identifiant du flux d'événements et dernier numéro de
  séquence envoyé ;
- `selection` : modèle, révision, taille, pixels peignables, stratégie,
  position ;
- `commands` : commandes permises maintenant (`start`, `pause`, `resume`,
  `stop`) ;
- `scheduler` : progression, pixels corrects, incorrects et inconnus,
  pixels restants, énergie, prochaine disponibilité, ETA, tentatives
  incertaines, erreurs récentes ;
- `world` : disponibilité, erreur, taille, génération ;
- `journal` : tentatives ouvertes, tentatives à réconcilier au démarrage,
  dommage, compactage en cours ;
- `instance` : verrou et garde de l'instance ;
- `settings` ;
- `lastActivityAt`.
