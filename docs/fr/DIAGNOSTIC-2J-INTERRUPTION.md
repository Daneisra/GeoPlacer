# Diagnostic 2J — interruption après 55 cibles

18 novembre 2026, base `87bcd65`, branche `feat/phase2j-continuous-drawing`. Examen limité au canal HTTP, au contrôle d’autorisation et aux journaux concernés.

## Constat vérifié

- Lot enregistré : mode réel, zone image 20 × 20, budgets 100 pixels / 100 énergie, durée 600 s.
- Journal décodé avec `decodeJournal` : **117 entrées valides, aucune ligne corrompue, aucun fragment final**. Pour ce lot : **11 groupes terminés / 55 cibles acquittées**, trois groupes refusés (15 références), aucun groupe ouvert ou incertain. Les références refusées ne sont pas des confirmations supplémentaires.
- Première tentative démarrée à **17:36:17.641**, dernier accusé enregistré à **17:36:43.819**, dernier refus à **17:36:51.612** (heure Europe/Warsaw). Les 34 secondes entre tentatives ne donnent pas l’heure d’approbation du dessin : une attente pouvait précéder la première réservation.
- Les captures disponibles ne montrent pas de nouvelle identité de modèle/position à la fin ; elles ne permettent pas d’exclure un changement ou rechargement après la dernière capture. Leur identité de page peut rester identique entre plusieurs couplages HTTP.

**Cause exacte non récupérable dans les preuves disponibles.** L’ancien canal regroupait expiration absolue, inactivité et changement d’époque dans `HTTP reader expired or replaced`. `ControlledBatch.tick()` remplaçait ces causes par « Autorisation expirée ou contexte du navigateur modifié ». Les approbations et fermetures du couplage n’étaient pas journalisées ; son état était volatil. Le serveur était non joignable lors de l’examen. Le texte fourni par l’utilisateur (« Surveillance arrêtée. Nouveau couplage si le canal a expiré ») est une instruction commune de fermeture, pas l’erreur initiale du lecteur.

Le code confirme **deux délais distincts** : couplage de dix minutes depuis son approbation (`HTTP_LIFETIME_MS`), dessin de 600 s depuis son autorisation. Démarrer le dessin ne renouvelle pas le couplage ; celui-ci peut donc expirer avant les 600 s du dessin. C’est une explication compatible, **pas une cause rétrospectivement démontrée**. Aucun défaut d’exécution ou besoin d’allonger ces limites n’est établi.

## Correctif ciblé

- `http-channel.ts` distingue les codes d’expiration absolue, inactivité 30 s, demande non approuvée expirée, contexte modifié, canal remplacé, déconnexion et révocation. Le dernier motif et ses dates restent consultables pendant la vie du serveur.
- Le dashboard affiche séparément les secondes restantes du **couplage** et de l’**autorisation de dessin**, calculées côté serveur. Le motif précis remplace le message générique lorsque le contexte est perdu.
- `src/server.ts` journalise les événements `[connector-http]` et les changements d’état `[connector-drawing]` dans les journaux serveur existants : dates d’approbation/expiration, état, motif et compteurs. Pas de clé, capacité de canal, cookie, token du site ou corps de requête. Une panne du callback de journalisation ne bloque pas la révocation.
- Aucun changement des durées, de la planification, des placements ou des mécanismes de reprise. **Lecteur 0.9.0 inchangé.** Un arrêt par inactivité n’établit pas, à lui seul, qu’une page a été rechargée.

## Préservation et validation

Les trois fichiers examinés ont une copie de preuve dans `test-logs/phase2j-interruption/`, avec `evidence-manifest.json` (SHA-256) et `diagnostic-summary.json`. Leurs empreintes originales ont été comparées après les tests : inchangées. Ces fichiers privés restent ignorés par Git.

**37 tests Vitest ciblés réussis** : canal, motifs, absence de renouvellement silencieux, logger défaillant, continuité et restauration des 55 confirmations après perte du canal. Le scénario de reprise exige recouplage puis nouvelle approbation et n’exécute que les **45 cibles restantes**, sans doublon. Test Jest de l’API réussi (12 scénarios internes), types backend/packages/frontend et lint ciblé valides (un avertissement préexistant dans `server.ts`). Build réussi ; recette Edge locale réussie, avec compteurs et motif après révocation, sans erreur de page ni requête externe. Journaux sous `test-logs/phase2j-interruption/`. Contrôle complet, clone et benchmarks non répétés pour ce correctif ciblé.

Aucune reprise réelle n’a été déclenchée. Pour reprendre le lot conservé : serveur mis à jour, **nouveau couplage**, observation/liaison du même modèle à la même position, puis **nouvelle autorisation explicite** des cibles restantes. Aucune confirmation n’est effacée ; les anciennes autorisations ne sont pas réactivées. Aucun push, achat, tag, release ou nettoyage.
