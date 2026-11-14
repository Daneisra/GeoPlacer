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

## Tests des paquets (Phase 1B.5 : Vitest, 23 fichiers, 302 tests + 1 exhaustif optionnel)

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
| adapters-node | `adapters.test.ts` | Même suite de conformité sur le stockage fichiers ; décodage pngjs (palette + tRNS, gris 1/16 bits, entrelacé…) ; disposition des fichiers ; fichiers modifiés sur disque ; réparation sur disque (octets corrompus conservés) ; chemins refusés ; arrêt brutal d'un processus réel ; verrou du répertoire (un processus ; deux processus indépendants ; quatre lancés en même temps ; les deux mécanismes) ; dépendances du paquet |
| simulator | `package.test.ts` | Résolution de `@geoplacer/core` (valeurs et types) |

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
  ([strategies.md](strategies.md) § 4).

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
