# Simulateur de toile local (Phase 1B.7)

Le paquet `@geoplacer/simulator` fournit une **toile entièrement locale**,
en mémoire, derrière les contrats du moteur (`CanvasReader`,
`CanvasWriter`, `ReadWriteCanvasProvider`). Il ne parle à **aucun service
réel** et n'envoie aucune requête réseau. C'est le seul fournisseur en
écriture utilisé par les tests.

## 1. Utilisation

```ts
import { SimulatedCanvasProvider, createManualClock } from '@geoplacer/simulator';

const clock = createManualClock(1_000_000);          // horloge virtuelle
const canvas = new SimulatedCanvasProvider({
  bounds: { minX: 0, minY: 0, width: 256, height: 256 },
  coordinateSystem: { yAxis: 'down' },              // repère explicite
  rules,                                            // règles de ressources (synthétiques en test)
  clock,
  idempotentWrites: false,                          // facultatif
});
canvas.addAgent({ agent, energy: 20, unlockedColors: [red, green] });
```

## 2. Fonctions

| Fonction | Détail |
|---|---|
| Limites et repère | Rectangle de toile et repère (`yAxis` vers le haut ou vers le bas) explicites |
| Lecture d'une région | `reader.readRegion(rect)` : instantané **copié**, daté par l'horloge, avec `readRow` ; `UNKNOWN` hors des limites |
| Écriture | `writer.applyPixels(agent, writes, { attemptId })` traite les pixels dans l'ordre : hors limites → refusé, couleur non débloquée → refusé, déjà de la bonne couleur → `already-correct` (gratuit), énergie insuffisante → refusé, sinon appliqué |
| Énergie | Calculée par les **fonctions de règles du core** (`stateFromObservation`, `advance`, `consumeEnergy`) avec l'horloge injectée : le même modèle que le moteur, régénération comprise |
| Ressources rapportées | Chaque réponse contient l'observation exacte des ressources après l'écriture (`ApplyResult.resources`) |
| Idempotence | Facultative : une tentative répétée n'est pas réappliquée, et son premier résultat est renvoyé |
| Pannes déterministes | `injectFaults(...)`, consommées une par appel d'écriture, dans l'ordre : `none` (aucune panne, pour placer les suivantes), `fail-before`, `partial` (les k premiers pixels, puis échec), `answer-lost` (tout appliqué, réponse perdue), `reject` (tout refusé avec une raison), `unknown-outcomes` (appliqué, résultats inconnus), `hold` (écriture suspendue jusqu'à `releaseHeld()` ou au signal d'abandon, pixels posés avant ou après ; `forgetHeld()` simule un appelant mort) |
| Latence et disponibilité (1B.8) | `writeLatencyMs` sur l'horloge virtuelle (une réponse est datée après l'observation qui la précède) ; `setAvailability(agent, …)` ; `resourceSource()` pour l'ordonnanceur |
| Acteurs externes | `paint(point, color)`, `erase(point)` : un autre joueur modifie la toile |
| Traçabilité | `events` (chaque pixel appliqué ou modifié de l'extérieur), `appliedCount(point)`, `writeCalls` |
| Horloge virtuelle | `createManualClock` : `advance`, `set` (jamais en arrière), `sleep` sans attente réelle |

## 3. Scénarios de réconciliation testés

Le simulateur est branché sur le `WorkPlanner` et l'`AttemptManager`. Le
journal en mémoire est partagé entre « processus » : un nouveau
gestionnaire sur le même journal représente un redémarrage.

| # | Scénario | Résultat vérifié |
|---|---|---|
| 1 | Tentative entièrement réussie | Pixels appliqués ; dépense prise de l'observation rapportée (aucune dépense en double) ; plus rien à faire, couleur non débloquée signalée |
| 2 | Tentative partiellement réussie | Énergie insuffisante pour certains pixels : refusés, puis replanifiés |
| 3 | Tentative échouée | Tous refusés (débit limité) : rien de dépensé, tout replanifié |
| 4 | Interrompue avant l'application | Réconciliée `observed-incorrect`, jamais `applied` ; ressources incertaines ; replanifiée par une **nouvelle** tentative |
| 5 | Interrompue pendant l'application | Les pixels posés sont `observed-correct`, les autres replanifiés ; chaque pixel n'est appliqué qu'une fois |
| 6 | Appliquée mais réponse perdue | `observed-correct`, jamais réécrite ; énergie jamais comptée deux fois |
| 7 | Pixel modifié par un acteur après son placement | Replanifié avec le même identifiant de tâche |
| 8 | Redémarrage avant la réconciliation | Réconciliée par le nouveau processus, **jamais renvoyée** (aucun nouvel appel d'écriture) |
| 9 | Redémarrage pendant la réconciliation | Avant la journalisation : toujours à réconcilier ; après, même sans entrée d'historique : close |
| 10 | Énergie devenue incertaine | Résultats inconnus : planification et bail refusés jusqu'à une nouvelle observation |

Deux contrôles s'ajoutent : le repère y vers le haut, et le
**déterminisme** (le même script produit le même journal et la même
toile).

## 4. Limites

- Une seule toile en mémoire, sans persistance : le simulateur sert aux
  tests et aux scénarios contrôlés.
- La boucle autonome est l'ordonnanceur mono-agent de la Phase 1B.8 :
  voir [ordonnanceur.md](ordonnanceur.md).
- Les règles de ressources sont fournies par l'appelant. Celles des tests
  sont **synthétiques** et ne décrivent aucun service réel.
