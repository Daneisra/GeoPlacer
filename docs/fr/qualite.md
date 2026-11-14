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

## Tests des paquets (Phase 1B.1 : Vitest, 8 fichiers, 83 tests + 1 exhaustif optionnel)

| Paquet | Fichier | Objet |
|---|---|---|
| core | `constants.test.ts` | Valeurs des constantes (un seul agent, sentinelles, versions) |
| core | `contracts.types.test.ts` | Garanties de types : lecture seule sans `writer`, ordonnanceur limité aux fournisseurs inscriptibles, identifiants et couleurs nominaux, métadonnées PNG + JSON |
| core | `architecture.test.ts` | Aucun import externe ni Node/DOM ; couches sans cycle ; aucun algorithme dans les contrats |
| core | `package.test.ts` | Point d'entrée |
| core | `geometry.test.ts` | Projection (1×1, non carrée, négatifs, origine non nulle, Y inversé), limites et placement partiel, allers-retours, entrées invalides, conversion de repère |
| core | `color.test.ts` | RVB et hexadécimal, alpha, noir ≠ transparent, OKLab (références d'Ottosson, gris, aller-retour), distances (métrique, espace euclidien) |
| core | `palette.test.ts` | Plus proche couleur, règle d'égalité, doublons, chemin rapide = chemin générique, quantification déterministe, palettes par agent, couleurs absentes |

Test exhaustif facultatif (aller-retour OKLab des 16,7 M couleurs, environ
10 s) : `$env:GEOPLACER_EXHAUSTIVE="1"; npm run test --workspace=packages/core`.

Benchmarks : `npm run bench:core` (résultats dans
[geometrie-couleurs.md](geometrie-couleurs.md) § 4).
| simulator | `package.test.ts` | Résolution de `@geoplacer/core` (valeurs et types) |

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
