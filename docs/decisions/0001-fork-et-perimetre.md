# ADR 0001 : fork de `wplacer-dev` et périmètre de GeoPlacer

- **Date** : 13/11/2026
- **Statut** : accepté (Phase 0 validée)

## Contexte

GeoPlacer vise à reprendre les fonctionnalités avancées de Wplacer (gestion
de modèles, progression, file de tâches, stratégies de dessin, ressources,
architecture multi-agents) pour GeoPixels.

L'audit de la Phase 0 a établi les points suivants.

- Les conditions d'utilisation de GeoPixels (mises à jour le 02/09/2026)
  interdisent :
  - l'automatisation du placement de pixels (§1(c), §2(i)), y compris par
    une extension autorisée (§1(d)) ;
  - les requêtes automatisées vers leurs serveurs (règle 12) ;
  - les comptes multiples (§1(c), règle 8).

  Il n'existe aucune API publique.
- `Arknight38/wplacer-dev` (AGPL-3.0-only, commit `46877e1`) est la seule
  base en TypeScript strict avec une interface React modulaire. Son moteur de
  dessin est en revanche incomplet :
  - contexte vide transmis aux modèles (F4) ;
  - modèles non sauvegardés (F5) ;
  - directions de dessin non implémentées (F6) ;
  - double décompte des charges (F7) ;
  - orientation des matrices incohérente entre l'interface (`data[y][x]`) et
    le moteur (`data[x][y]`) (F11).

## Décision

1. **Fork de `wplacer-dev`** en conservant l'historique et les attributions.
   L'original est configuré en `upstream`, avec le push désactivé.
2. **Aucune connexion au service réel.** Le moteur est développé et testé
   sur un simulateur local (`packages/simulator`). Une éventuelle
   intégration GeoPixels nécessitera une autorisation explicite du service.
3. **Un seul agent actif en V1** (`MAX_ACTIVE_ACCOUNTS = 1`). Les
   abstractions multi-agents ne sont exercées que sur simulateur.
4. **Le moteur de dessin hérité n'est pas réparé**, il sera remplacé
   (Phase 1B/2). Seuls l'infrastructure serveur, la sécurité, la
   persistance et l'interface sont consolidées en Phase 1A.
5. **Le code hérité de contournement anti-bot** (`LOAD_UNPACKED/injected`,
   imitation de navigateur par `impit`, proxys) est hors périmètre. Il sera
   retiré dans des commits séparés, une fois ses dépendances vérifiées.
6. **Licence** : GeoPlacer reste sous AGPL-3.0-only. Les modifications sont
   recensées dans `MODIFICATIONS.md` (AGPL §5a).

## Conséquences

- La Phase 1A ne livre aucune fonctionnalité visible côté dessin : elle
  fiabilise la base.
- Les bugs F4, F5, F6, F7, F8 et F11 restent présents dans le code hérité
  (F4 est annoté dans `src/routes/templates.ts`). Ils seront éliminés avec le
  nouveau moteur. F9 (option « Random Color » sans implémentation) a été
  corrigé en Phase 1A.
- Architecture cible :
  - `packages/core` : métier, indépendant du service cible ;
  - `packages/simulator` ;
  - `apps/server` ;
  - `apps/web`.

  Le tout reposera sur une interface `CanvasProvider` et un ordonnanceur
  multi-agents.
