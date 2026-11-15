# Qualité : tests, lint et outillage

## Commandes

Deux lanceurs coexistent (Phase 1B.0) : **Jest** pour le serveur hérité
(`src/__tests__`), **Vitest** pour les nouveaux paquets (`packages/*`).
Aucune migration globale de Jest vers Vitest n'est prévue à ce stade.

```powershell
npx tsc --noEmit              # types du serveur hérité (strict)
npm run test:legacy           # Jest (identique à « npm test »)
npm run lint                  # ESLint backend
npm run typecheck:packages    # types des paquets, tests compris
npm run test:packages         # Vitest
npm run lint:packages         # ESLint des paquets
npm run test:all              # typecheck des paquets, puis Jest, puis Vitest
npm run check                 # tsc, lint, lint:packages, puis test:all (contrôle complet)
cd frontend; npx eslint .; npm run build
```

## Tests des paquets (Phase 1B.7 : Vitest, 33 fichiers, 423 tests + 1 exhaustif optionnel)

| Paquet | Fichier | Objet |
|---|---|---|
| core | `constants.test.ts` | Valeurs des constantes (un seul agent, sentinelles, versions) |
| core | `contracts.types.test.ts` | Garanties de types : lecture seule sans `writer`, ordonnanceur limité aux fournisseurs inscriptibles, identifiants et couleurs nominaux, manifeste et gestionnaire de modèles |
| core | `architecture.test.ts` | Aucun import externe ni Node/DOM ; couches sans cycle ; aucun algorithme dans les contrats |
| core | `package.test.ts` | Point d'entrée |
| core | `geometry.test.ts` | Projection (1×1, non carrée, négatifs, origine non nulle, Y inversé), limites et placement partiel, allers-retours, entrées invalides, conversion de repère |
| core | `color.test.ts` | RVB et hexadécimal, alpha, noir ≠ transparent, OKLab (références d'Ottosson, gris, aller-retour), distances (métrique, espace euclidien) |
| core | `palette.test.ts` | Plus proche couleur, règle d'égalité, doublons, chemin rapide = chemin générique, quantification déterministe, palettes par agent, couleurs absentes |
| core | `template-validation.test.ts` | En-tête PNG (types, profondeurs, CRC, tronqué), limites avant décodage (bombe PNG), identifiants et noms, pixels canoniques, quantification par défaut |
| core | `template-manifest.test.ts` | Manifeste : aller-retour stable, `extensions` conservées et validées (noms, profondeur, taille, clés interdites), graine et `colorOrder` validés, schéma plus récent refusé, 41 manifestes malformés refusés ; règles de révision |
| core | `template-manager.test.ts` | Création, PNG invalide ou corrompu, dimensions excessives, image entièrement transparente ou opaque, seuil alpha, déterminisme, révisions, réglages sans révision, restauration, concurrence, conflit, empreinte fausse, récupération, manifeste malformé ou étranger, projets, duplication, suppression ; listage isolé (manifeste illisible, schéma plus récent, erreur de lecture, sans fuite de contenu) ; réparation (diagnostic, application, manifeste absent, refus) ; avertissement de placement partiel |
| core | `template-storage.test.ts` | Suite de conformité sur le stockage mémoire (panne injectée à chaque appel, réparation comprise ; `replaceManifest`) |
| core | `strategy-directional.test.ts` | Ordres exacts des 4 stratégies directionnelles, 1 × 1, images transparentes, taille des lots, région éligible (y descendant ou ascendant), placement et Y inversé, entrées invalides |
| core | `strategy-center-random.test.ts` | PCG32 : vecteurs de référence et implémentation BigInt indépendante ; centre (côtés pairs et impairs, trous, tri exact sur images aléatoires, centre de l'image et non de la région) ; aléatoire (permutation, graine, ordre figé de la version 1, répartition) |
| core | `strategy-color-outline.test.ts` | Couleur par couleur (fréquences, égalités, `colorOrder`, couleurs absentes, comptage sur l'image entière) ; contours (carré plein, trou, autre couleur, formes fines, définition vérifiée sur images aléatoires) |
| core | `progress.test.ts` | Progression : modèle entièrement correct, incorrect (autre couleur, vide), partiel, pixels inconnus, valeurs invalides, aucun pixel éligible, 1 × 1, non carré, axe y montant, repère différent refusé, placement partiel, coordonnées proches de 2^53, provenance et fraîcheur, entrées invalides ; propriétés contre une implémentation naïve (150 cas) ; indépendance de la stratégie |
| core | `eta.test.ts` | ETA : 0 pour un modèle terminé (même sans agent), absence d'agent, couleur indisponible, énergie insuffisante, observation incomplète ou ancienne, paramètres invalides, dépassement ; énergie nulle, régénération, cadence, disponibilité, pauses, plusieurs agents ; borne contre une simulation milliseconde par milliseconde ; monotonie |
| core | `resources-model.test.ts` | Règles : jeu complet accepté, 22 règles invalides refusées, capacité et intervalle par niveau ; observations valides et 16 invalides ; état : invariants, sérialisation canonique, nature exigée, règles différentes refusées |
| core | `resources-energy.test.ts` | Régénération partielle et longue durée, composition (400 cas), attentes exactes, dépenses, améliorations simulées, monnaie et plafonds ; gestionnaire : observation seule acceptée (`@ts-expect-error`), états séparés, doublons, ordre, absorption, contradictions, report de phase, agents séparés ; propriétés (150 séquences) ; chemin rapide = rejeu |
| core | `eta-equivalence.test.ts` | ETA identique à la version 1B.4 figée sur 2 000 cas aléatoires |
| core | `upgrades.test.ts` | Améliorations possibles et impossibles, effets, ETA avant / après, couleur rendant l'estimation possible, bénéfice nul non recommandé, autres agents, instantané périmé, déterminisme, comparaison exacte, confirmation, application unique, propriétés |
| core | `strategy-properties.test.ts` | Propriétés des 8 stratégies sur images aléatoires : chaque pixel peignable exactement une fois, jamais un transparent, déterminisme, taille des lots, région = ordre filtré, placement et sens de l'axe y ; intégration avec le gestionnaire de modèles |
| core | `strategy-keys.test.ts` | Clés de classement (1B.6) : trier par clé redonne exactement l'ordre validé de chaque stratégie (régions, graines, `colorOrder`) ; table des rangs de l'aléatoire |
| core | `order-cache.test.ts` | Cache de l'ordre aléatoire : aller-retour, clé différente refusée, longueur, SHA-256, permutation invalide, en-tête illisible ; régénération et réécriture au mieux, problème signalé ; magasin en panne |
| core | `work-planner.test.ts` | `WorkPlanner` : modèle correct, partiellement incorrect, presque terminé ; pixels inconnus (deux politiques), couleurs indisponibles, points en cours, budget et attente, refus (instantané périmé ou futur, repère, ressources périmées ou incertaines, agent indisponible) ; nouvelle révision ; propriété « premiers k de l'ordre filtré » (160 cas, 8 stratégies) ; cache = sans cache |
| core | `attempts.test.ts` | `AttemptManager` : succès, échec, annulation, bail déjà réservé, doublons, énergie insuffisante, couleur ou agent indisponible, duplication concurrente, bail expiré, changement de révision, résultat inconnu, réponse perdue, écriture refusée puis replanifiée, réconciliation (lecture trop ancienne refusée), pixel redevenu incorrect, reprise après interruption, reprise idempotente, registre des dépenses perdu, observation rapportée sans double consommation, journal corrompu, fin déchirée, événements incohérents, injection de fautes à chaque écriture du journal, machine d'états complète ; propriétés : trois agents simulés sur une toile locale, actions entrelacées (baux concurrents, chevauchements, fautes, crashs, expirations) |
| core | `journal-codec.test.ts` | Format des lignes : aller-retour ASCII, somme valide sur un contenu invalide, version inconnue ; propriétés : coupure à chaque octet, octet altéré jamais lu comme un événement |
| adapters-node | `adapters.test.ts` | Même suite de conformité sur le stockage fichiers ; décodage pngjs (palette + tRNS, gris 1/16 bits, entrelacé…) ; disposition des fichiers ; fichiers modifiés sur disque ; réparation sur disque (octets corrompus conservés) ; chemins refusés ; arrêt brutal d'un processus réel ; numéros jamais réutilisés malgré arrêts, corruption et réparations interrompues (1B.6) ; réservations sur disque ; cache d'ordre sur disque ; journal et historique sur disque (fin déchirée mise de côté, dommage conservé, ajout échoué après une ligne partielle), processus réels tués pendant les ajouts au journal ; verrou du répertoire (un processus ; deux processus indépendants ; quatre lancés en même temps ; les deux mécanismes) ; dépendances du paquet |
| core | `journal-state.test.ts` | Phase 1B.7 : reconstruction depuis le journal complet (A) égale à la reconstruction depuis le checkpoint et les événements postérieurs (B), sur 25 scénarios et plus de 50 compactages avec crashs ; gestionnaires repris sur un journal compacté et sur un journal complet identiques ; tentatives ouvertes conservées par le compactage ; purge des résumés sans perte d'incertitude ; journal endommagé (lecture de la toile exigée, compactage refusé) ; checkpoint réparé |
| adapters-node | `journal.test.ts` | Générations et compactage sur disque, équivalence avec le rejeu complet, rétention, lecture du journal de la 1B.6, pointeur absent ou illisible, repli de checkpoint, séquence manquante ; injection de fautes avant et après chaque opération du compactage ; fin déchirée, ajout échoué ; rotation de l'historique ; processus réels arrêtés à 10 étapes nommées |
| adapters-node | `journal-tool.test.ts` | Diagnostic en lecture seule (empreinte du répertoire inchangée, aucun contenu ni chemin exposé) ; réparation (plan, identifiant, sauvegarde vérifiée, trace, préservation, fin déchirée, pointeur absent, checkpoint inutilisable, journal modifié après le plan) ; injection de fautes à chaque opération de la réparation ; ligne de commande |
| simulator | `package.test.ts` | Résolution de `@geoplacer/core` (valeurs et types) |
| simulator | `canvas.test.ts` | Fournisseur de toile simulé : contrats, lecture (limites, repère, `readRow`, copie datée), écriture (ordre des refus, énergie des règles du core, régénération), idempotence, pannes déterministes, acteurs externes |
| simulator | `reconciliation.test.ts` | Les dix scénarios de réconciliation avec l'`AttemptManager`, le repère y vers le haut, le déterminisme |

Test exhaustif facultatif (aller-retour OKLab des 16,7 M couleurs, environ
10 s) : `$env:GEOPLACER_EXHAUSTIVE="1"; npm run test --workspace=packages/core`.

Benchmarks :
- `npm run bench:core` : résultats dans
  [geometrie-couleurs.md](geometrie-couleurs.md) § 4 ;
- `npm run bench:templates` : résultats dans [modeles.md](modeles.md) § 6 ;
- `npm run bench:strategies` : résultats dans [strategies.md](strategies.md) § 3 ;
- `npm run bench:color-by-color` : avant et après l'optimisation de la 1B.4,
  avec vérification de l'ordre ([strategies.md](strategies.md) § 3) ;
- `npm run bench:progress` : progression et ETA
  ([progression.md](progression.md) § 4) ;
- `npm run bench:resources` : ressources, ETA, planificateur
  ([ressources.md](ressources.md) § 6) ;
- `npm run bench:snapshot-read` : lecture par ligne contre lecture par
  pixel ([progression.md](progression.md) § 5) ;
- `npm run bench:order-cache` : cache d'ordre sur disque
  ([strategies.md](strategies.md) § 4) ;
- `npm run bench:reservations` : réservations de numéros
  ([modeles.md](modeles.md)) ;
- `npm run bench:planner-focus` : couleur par couleur et contours d'abord,
  médiane, p95, maximum, A/B dans un même processus
  ([planification.md](planification.md) § 8) ;
- `npm run journal:diagnose`, `npm run journal:repair` : outil local du
  journal ([journal.md](journal.md) § 6) ;
- `npm run bench:planner` : `WorkPlanner` en 1000², 2000², 4096²
  ([planification.md](planification.md) § 8) ;
- `npm run bench:journal` : coût du journal et de la reprise, avant et
  après compactage ([journal.md](journal.md) § 8).

Simulation de l'ETA sur d'autres graines :
`$env:GEOPLACER_ETA_SEED="5"; npx vitest run --root packages/core test/eta.test.ts`.

Mutation vérifiée en 1B.2 : publier le manifeste **avant** d'écrire les
blobs fait échouer la suite de conformité (scénario « nouvelle source »).

Mutations vérifiées en 1B.3 : calculer le centre sur la région au lieu de
l'image, ou compter les couleurs sur la région, fait échouer les tests de
propriétés (région = ordre filtré, placement).

Délais : trois calculs purs de 1 à 3 s ont un délai explicite de 30 s. Un
passage complet avait échoué une fois sur 2 fichiers, sans détail
conservé ; les passages suivants ont réussi. **La cause n'est pas
établie** : le dépassement du délai de 5 s sous charge reste une
hypothèse, et l'augmentation du délai n'en est pas une preuve.

**Journaux complets** (Phase 1B.4) : `npm run check:logged` et
`npm run test:packages:logged` enregistrent toute la sortie (avec la date,
le commit et la version de Node) dans `test-logs/<date>-<script>.log`,
réussite comme échec, en conservant le code de sortie
(`scripts/run-logged.mjs`). Le dossier est ignoré par Git. À utiliser pour
les contrôles complets, afin qu'un échec intermittent puisse être examiné.

Phase 1B.5 :
- mutation vérifiée : ne plus conserver la progression partielle de
  régénération fait échouer six tests ;
- tous les échecs rencontrés pendant la phase ont leur journal complet
  conservé, même quand la relance réussissait (erreurs de rédaction de
  tests, et trois défauts réels : deux bornes de l'ETA et le registre
  cubique).

Phase 1B.6, mutations vérifiées (chacune fait échouer au moins un test) :
- numéroter d'après le manifeste seul (sans les réservations) : suite de
  conformité et test en processus réels ;
- `nextBatch` qui ignore les points en cours (3 tests) ou qui inverse la
  comparaison du tas (propriété) ;
- parcours inversé des lignes qui saute une ligne (propriété) ;
- gestionnaire sans sérialisation (duplication concurrente) ;
- bail sans refus `OVERLAP`, ou planificateur sans exclusion des points en
  cours (test de propriétés multi-agents) ;
- journal fichier qui garde son descripteur après un ajout échoué ;
- reprise qui libère les baux malgré un journal endommagé (2 tests) ;
- incertitude non reconstruite à la reprise, lecture de réconciliation
  antérieure à l'envoi en réconciliation (2 tests), dépense enregistrée en
  plus de l'observation rapportée.

Phase 1B.7, mutations vérifiées (chacune fait échouer au moins un test) :
- reprise depuis un checkpoint sans `lastSpendAt` (3 tests) ; `lastSpendAt`
  non mis à jour à la clôture (1 test) ;
- carte des contours fausse sur la première colonne (propriété des clés) ;
- interface d'origine contre le contrat de routes (4 appels inexistants
  détectés).

Phase 1B.7, échecs rencontrés (journaux complets conservés hors du
dépôt) :
- **Deux défauts réels**, trouvés par les tests et corrigés :
  - lors du tout premier compactage, un arrêt après la création du
    checkpoint laissait des fichiers de génération sans pointeur, et la
    reprise refusait de démarrer. Correction : un pointeur est écrit avant
    tout fichier de génération (trouvé par les processus arrêtés aux
    étapes nommées) ;
  - une panne d'entrée-sortie pendant la réparation faisait reconstruire
    l'état depuis les seuls événements, ce qui perdait les tentatives
    ouvertes du checkpoint. Correction : le repli est limité au cas annoncé
    par le plan (trouvé par l'injection de fautes dans la réparation).
- **Une faiblesse corrigée** : un `catch` trop large dans l'empreinte des
  fichiers avalait une panne injectée et produisait une trace incomplète.
- **Erreurs de rédaction des tests**, corrigées :
  - fin déchirée vérifiée sans ajout préalable ;
  - attente fausse sur le nombre de segments lus par l'historique ;
  - horloge d'un deuxième harnais antérieure à la dernière dépense ;
  - lecture du fichier de verrou (EBUSY) ;
  - attente de 6 tentatives au lieu de 7 (la ligne endommagée était une
    clôture) ;
  - message attendu de `PLAN_CHANGED`.
- **Script de recette** : la première exécution est restée bloquée,
  faute d'arrêter le serveur après une erreur, à cause d'un sélecteur
  ambigu. Le script nettoie maintenant tout en sortie.
- **Avertissement** « FileHandle fermé par le ramasse-miettes » : des tests
  ne fermaient pas leurs journaux. Corrigé.
- **Délai de la duplication interrompue** (cause toujours non établie) : le
  test enregistre maintenant la durée de chaque itération lente, pour
  qu'une récidive laisse des données. Pas de récidive pendant la 1B.7.

**Lint du frontend** (`cd frontend; npx eslint .`) : 17 erreurs et
3 avertissements **hérités** (règles `react-refresh` et `no-explicit-any`).
Il est hors de `npm run check`. Les corrections de la recette n'en ajoutent
aucun : le compte est vérifié avant et après.

**Tests de processus** : le test du journal arrête l'enfant à des étapes
nommées, sans minuteur. Les tests de modèles des phases 1B.2 et 1B.5
attendent une poignée de main explicite (« ready »), puis tuent l'enfant
après un délai qui ne sert qu'à **tirer au hasard l'instant du crash**.
Aucune assertion ne dépend de ce délai, sauf « au moins une écriture sur
8 passages ».

Phase 1B.6, échecs rencontrés (journaux complets conservés hors du dépôt) :
- **test des processus tués pendant les ajouts au journal**, deux échecs :
  - sur un clone neuf : `history.log` absent ;
  - en local, une fois sur trois : `attempts.log` absent.

  **Cause établie** : l'enfant pouvait être tué avant sa première clôture,
  ou même avant son premier ajout, car le démarrage est plus lent sur un
  clone neuf. Le test supposait que ces fichiers existent toujours. Ce
  n'est pas un défaut du produit. **Correction** : l'enfant ne se déclare
  prêt qu'après 12 itérations, et un historique absent compte comme vide.
  Cinq passages consécutifs ont ensuite réussi.
- **Test de propriétés multi-agents** : dépassement du délai de 5 s dans
  la suite complète (6,7 s, contre environ 3,3 s seul). La charge est
  déterministe (graine fixe) : 30 toiles de 300 actions. Ce n'est pas un
  blocage. Délai explicite de 30 s, comme les autres calculs lourds.
- **Conformité du stockage fichiers, duplication interrompue** : délai de
  5 s atteint une fois sur un clone neuf (5,0 s). Le test prend 1,9 à
  2,2 s dans le dépôt et avait réussi sur deux clones neufs précédents.
  C'est une boucle d'injection de fautes sur disque réel, avec un fsync
  par opération. **Cause non établie** : des entrées-sorties plus lentes
  dans le dossier temporaire du clone restent une hypothèse. Délai
  explicite de 30 s pour les trois tests d'opérations interrompues ; ce
  délai ne prouve rien sur la cause.
- Deux échecs de mise au point n'ont été conservés que sous forme
  d'extraits, pas de journal complet :
  - premier passage de `attempts.test.ts` : erreurs de rédaction du test ;
  - `EPERM` de `ftruncate` sous Windows sur un descripteur en ajout,
    corrigé par un descripteur séparé.

Mutation vérifiée en 1B.4 : compter un pixel `UNKNOWN` comme correct fait
échouer deux tests de progression. Écraser la sauvegarde lors d'une
réparation fait échouer quatre tests. Deux assertions de la 1B.3 étaient
vides (elles lisaient une entrée détachée du stockage mémoire) : elles ont
été corrigées.

Les garanties de types sont vérifiées par `npm run typecheck:packages` : un
`@ts-expect-error` devenu inutile fait échouer la vérification. Deux
mutations volontaires (un `writer` ajouté au fournisseur en lecture seule ;
un import vers une couche supérieure) ont bien été détectées.

## Tests backend (Phase 1B.0 : 9 suites, 94 tests)

| Suite | Objet |
|---|---|
| `validation.test.ts` | Schémas Zod existants (dont le contrat `expirationDate`) |
| `validation-dos.test.ts` | Charges malveillantes : matrices, listes, cookies (GHSA-mrhx-c7xc-m3w5) |
| `network.test.ts` | Résolution de l'adresse d'écoute |
| `local-access.test.ts` | Host, Origin, Sec-Fetch-Site, WebSocket |
| `redact.test.ts` | Masquage des secrets, `toPublicUser` |
| `log-redaction.test.ts` | Masquage dans un vrai pipeline Winston |
| `settings-update.test.ts` | Validation, bornes alignées sur chaque contrôle de la page Paramètres, mise à jour sur place, nettoyage au chargement |
| `json-store.test.ts` | Écriture atomique, quarantaine, restauration, arrêts brutaux réels |
| `server-config.test.ts` | Configuration absente, vide, partielle ou invalide ; cohérence de `.env.example` |

Les tests n'émettent aucune requête vers un service public. Les tests de
persistance travaillent dans des dossiers temporaires du système.

Non couvert : le moteur de dessin hérité (`template-manager.ts`,
`wplacer-client.ts`), qui sera remplacé.

## Lint

- **Backend** : 0 erreur. Les avertissements restants sont des
  `no-explicit-any` hérités, à traiter au fil des modules réécrits.
- **Frontend** : 17 erreurs héritées, classées par priorité :

| Priorité | Règle | Nb | Fichiers | Nature |
|---|---|---|---|---|
| Moyenne | `react-hooks/purity` | 1 | `ManageUsers.tsx:116` | `Date.now()` pendant le rendu : le badge de suspension ne se met pas à jour seul |
| Moyenne | `react-hooks/set-state-in-effect` | 3 | `useServerStatus.ts:48`, `useSettings.ts:79`, `useUsers.ts:68` | Rendus en cascade (performance) |
| Basse | `react-hooks/immutability` | 5 | `AddTemplate.tsx:36`, `ManageTemplates.tsx:33`, `ManageUsers.tsx:22`, `Settings.tsx:26`, `useLogs.ts:55` | Fonction appelée dans un `useEffect` avant sa déclaration : faux positif à l'exécution |
| Basse | `react-refresh/only-export-components` | 3 | `ui/Button.tsx`, `ui/Toast.tsx`, `router.tsx` | Rechargement à chaud en développement uniquement |
| Basse | `no-explicit-any`, `no-unused-vars`, `no-empty-object-type` | 5 | `ui/collapsible.tsx`, `ui/Input.tsx`, `useSettings.ts`, `vite.config.ts` | Style |

Le hook `useLogs` n'est importé par aucun composant (code mort probable).

## Évaluation de Vitest (Phase 1A)

Essai réalisé dans un clone jetable, sans modifier le projet :

- Vitest 5.1.0 exige `@types/node` en ^22 ou ≥ 24. Le projet est en ^20, ce
  qui est par ailleurs incohérent avec l'exécution sous Node 22.
- Avec `globals: true`, **83 tests sur 85** passent sans modification. Les 2
  échecs viennent de `jest.fn()` (4 appels à remplacer par `vi.fn()`).
- Durée : 3,7 s avec Vitest, contre 9,5 s avec Jest.

Décision (14/11/2026), appliquée en Phase 1B.0 : Vitest 5.1.0 pour
`packages/core` et `packages/simulator` ; Jest conservé pour le code hérité ;
`@types/node` aligné sur ^22.
