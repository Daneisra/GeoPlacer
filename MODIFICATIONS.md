# Modifications (GNU AGPL v3, section 5a)

GeoPlacer est une version modifiée de **wplacer** (`Arknight38/wplacer-dev`,
commit `46877e120f9e7bc721084fdf88a9ae8f006cb117`), œuvre de JinxTheCatto,
luluwaffless, Arknight38 et de leurs contributeurs, distribuée sous
GNU AGPL v3 (`LICENSE`). Les modifications sont distribuées sous la même
licence. L'historique Git complet du projet d'origine est conservé.

## 2026-11-13 — Phase 1A : fondation et sécurité

- Lockfiles backend et frontend versionnés ; Node ≥ 22.12 exigé ; télémétrie
  Scarf désactivée.
- Test `expirationDate` corrigé ; erreurs ESLint du backend corrigées.
- Écoute sur `127.0.0.1` par défaut, `HOST` validé (`src/config/network.ts`).
- Contrôles Host, Origin, Sec-Fetch-Site et WebSocket
  (`src/middleware/local-access.ts`).
- Limiteur de débit appliqué à toutes les routes.
- Cookies retirés de `GET /users` ; masquage des secrets dans les logs
  (`src/utils/redact.ts`, `src/utils/log-redaction.ts`).
- Limite JSON de 12 Mo ; erreurs client 4xx correctement renvoyées.
- `/settings` : validation (bornes alignées sur l'interface), état partagé, sauvegarde réelle
  (`src/config/settings-update.ts`, `src/config/default-settings.ts`) ;
  frontend en `PUT`, option « Random Color » retirée.
- Écritures atomiques et récupération des fichiers corrompus
  (`src/utils/json-store.ts`).
- Migration vers Zod 4.6.7 et collections bornées.
- `start.bat` : installation des deux projets par le chemin vérifié.
- Documentation française (`docs/fr/`, `docs/decisions/`).

## 2026-11-14 — Phase 1B.0 : espace de travail du nouveau moteur

- `.env` retiré du suivi Git (fichier local conservé), `.env.*` ignorés sauf
  les exemples, démarrage possible sans `.env` (`--env-file-if-exists`),
  `.env` généré par `start.bat` depuis `.env.example`.
- Lecture centralisée et validée de la configuration
  (`src/config/server-config.ts`).
- `@types/node` aligné sur Node 22.
- Espaces de travail npm `packages/core` et `packages/simulator`,
  configuration TypeScript stricte (`tsconfig.base.json`), Vitest 5.1.0.
- Contrats du moteur, sans algorithme (`packages/core/src/contracts`).
- Documentation : architecture, ADR 0002 accepté avec ajustements,
  commandes Windows, qualité.
