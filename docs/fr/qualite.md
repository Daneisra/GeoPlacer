# Qualité : tests, lint et outillage

## Commandes

```powershell
npx tsc --noEmit        # vérification des types (strict)
npm test                # Jest + ts-jest
npm run lint            # ESLint backend
cd frontend; npx eslint .; npm run build
```

## Tests backend (fin de Phase 1A : 8 suites, 86 tests)

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

Recommandation : adopter Vitest pour les nouveaux paquets (`packages/core`,
`packages/simulator`), garder Jest pour le code hérité pendant la
transition, puis migrer les 4 appels.
