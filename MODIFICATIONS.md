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
