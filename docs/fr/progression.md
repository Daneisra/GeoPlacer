# Progression et estimation du temps restant

État : **Phase 1B.4**. Le calculateur de progression (`ProgressCalculator`)
et l'estimateur de temps restant (`EtaEstimator`) sont implémentés dans
`@geoplacer/core` (`src/progress/`). Ils sont purs : ni ordonnanceur, ni
fichier, ni réseau, ni service externe. Ils fonctionnent sur des données
locales, simulées ou importées.

Avant cette phase, aucun instantané de toile n'existait : seul le contrat
`CanvasSnapshot` était défini. La Phase 1B.4 ajoute `createArraySnapshot`,
un instantané en mémoire, pur et validé. Le simulateur (Phase 1B.7) et un
futur import d'image produiront des instantanés de cette forme.

## 1. Utilisation

```ts
import { computeProgress, createArraySnapshot, estimateEta } from '@geoplacer/core';

const instantane = createArraySnapshot({
  rect, coordinateSystem, source: 'imported-snapshot', observedAt, pixels, // Int32Array
});
const progression = computeProgress(modele, instantane, maintenant, {
  freshness: { 'imported-snapshot': { maxAgeMs: 10 * 60_000 } },          // politique par source
});
const eta = estimateEta(progression, agents, {
  energyPerPixel: 1, msPerPixel: 0, minCoveragePercent: 95,
}, maintenant);
```

## 2. Progression

### États d'un pixel

Seuls comptent les pixels **éligibles** : non transparents dans le
modèle et dans les limites de la toile quand elles sont connues. Les
autres sont comptés à part (`excluded.transparent`,
`excluded.outsideCanvas`).

| État | Condition |
|---|---|
| Correct | l'instantané a la couleur attendue |
| Incorrect : autre couleur (`wrongColor`) | l'instantané a une autre couleur 24 bits |
| Incorrect : manquant (`missing`) | le pixel de la toile est vide (`TRANSPARENT`) |
| Inconnu (`unknown`) | hors de l'instantané, `UNKNOWN`, ou valeur invalide |

- Une **valeur invalide** (`NaN`, fraction, hors de 24 bits, négatif autre
  que les sentinelles) est comptée inconnue, et aussi dans
  `invalidObservations`.
- Un pixel inconnu n'est **jamais** compté correct.

### Statistiques

| Champ | Définition |
|---|---|
| `total` | pixels éligibles |
| `correct`, `incorrect`, `wrongColor`, `missing`, `unknown` | compteurs : `total = correct + incorrect + unknown` ; `incorrect = wrongColor + missing` |
| `conformityPercent` | `correct / total × 100` |
| `coveragePercent` | `(correct + incorrect) / total × 100` : part des pixels éligibles réellement observés |
| `completion` | `complete` (tout observé et correct), `incomplete` (au moins un incorrect connu), `undetermined` (aucun incorrect connu, mais des inconnus), `no-eligible-pixels` |
| `byColor` | mêmes compteurs par couleur attendue, couleurs triées par valeur RVB croissante |
| `basis` | source, nature, date d'observation et fraîcheur de l'instantané |
| `computedAt` | heure du calcul |

**Aucun pixel éligible** (image entièrement transparente, ou modèle
entièrement hors toile) : `completion: 'no-eligible-pixels'`, pourcentages
`null`. Aucune division par zéro.

Les invariants sont vérifiés par des tests de propriété (150 cas
aléatoires) contre une implémentation naïve indépendante.

### Méthode de calcul

- Un seul parcours de la région éligible, dans l'ordre de l'image.
- Pour chaque pixel, la position sur la toile est calculée par la
  projection de la Phase 1B.1 (axe y montant ou descendant).
- La valeur est lue par `snapshot.get`, avec un seul objet point réutilisé.
- Les compteurs sont dans un `Float64Array` (5 compteurs par couleur).
  Aucun objet n'est créé par pixel.
- Le résultat **ne dépend que** du modèle (image, placement, repère) et de
  l'instantané : ni la stratégie, ni la graine, ni l'ordre, ni les agents
  ne font partie des entrées.

**Repère explicite** : l'instantané déclare son repère
(`coordinateSystem`). S'il diffère de celui du modèle, le calcul est
refusé (`COORDINATE_SYSTEM_MISMATCH`) : la conversion doit être faite
explicitement avant.

### Provenance et fraîcheur

| `source` | `kind` | Sens |
|---|---|---|
| `simulated` | `simulation` | résultat d'une simulation locale |
| `imported-snapshot` | `imported-observation` | observation importée, valable à `observedAt` |

Aucun lecteur de toile en temps réel n'existe en V1 : un résultat n'est
jamais présenté comme une lecture en direct.

**Fraîcheur** : une politique `maxAgeMs` est configurée **par source**. Il
n'existe aucun seuil par défaut commun à toutes les sources.

| `freshness.status` | Condition |
|---|---|
| `fresh` | âge ≤ `maxAgeMs` de la source |
| `stale` | âge > `maxAgeMs` |
| `unchecked` | aucune politique pour cette source |
| `future` | `observedAt` postérieur à `now` (horloges incohérentes) |

Les zones que l'instantané ne couvre pas restent **inconnues**.

## 3. Estimation du temps restant (ETA)

Le résultat est toujours une **estimation théorique** (`kind:
'theoretical-estimate'`), jamais une mesure de performance. Il est
déterministe, en arithmétique entière, et se teste avec une horloge
virtuelle : `now` est un paramètre, rien n'attend réellement.

### Hypothèses

Elles sont renvoyées avec chaque résultat (`assumptions`) :

1. Estimation théorique sous ces hypothèses, pas une mesure.
2. **Travail** = pixels incorrects connus + pixels **inconnus**, supposés
   à repeindre (pessimiste).
3. Un agent peint un pixel à la fois, au plus un tous les `msPerPixel`
   (cadence C), et dépense `energyPerPixel` (k) par pixel.
4. **Énergie** : prévue depuis la dernière observation de l'agent, arrondie
   vers le bas et plafonnée à `maxEnergy`. La régénération pendant la
   rafale initiale, les pauses et l'attente est ignorée (pessimiste).
5. **Rythme** : l'agent peint d'abord B = ⌊E / k⌋ pixels avec son énergie,
   puis un pixel tous les D = max(C, k × R), où R est son intervalle de
   régénération. Le premier pixel après la rafale peut attendre au plus
   min(C, k × R) de plus, car la phase de régénération est inconnue.
6. **Répartition** : le travail est réparti entre agents de la meilleure
   façon possible, dans le respect de leurs palettes. C'est la seule
   hypothèse **optimiste** ; elle est exacte avec un seul agent, le cas de
   la V1.
7. Aucune écriture refusée, aucune modification par un tiers, aucune
   panne (optimiste).
8. Personne ne peint pendant les pauses configurées. Un agent commence à
   `availableFrom`.

Les agents ont chacun leurs ressources : énergie, maximum, régénération,
palette, disponibilité.

### Calcul

- **Capacité d'un agent** : nombre de pixels qu'il peut terminer avant
  une date donnée, en temps réel d'horloge, compte tenu de sa
  disponibilité, des pauses, de sa rafale puis de son rythme.
- **Durée** : la plus petite durée T telle que les capacités couvrent le
  travail de chaque couleur, avec des agents qui l'ont débloquée. Elle est
  vérifiée par un flot maximal couleurs → agents et trouvée par
  dichotomie.
- La répartition obtenue est renvoyée (`assignments`).

**Vérifications** :
- l'estimation n'est jamais inférieure à une simulation milliseconde par
  milliseconde d'un agent, avec régénération continue (20 graines × 600
  cas). Elle lui est égale quand l'énergie initiale couvre tout le travail ;
- elle est monotone : plus de travail, une pause ou moins d'énergie ne la
  raccourcissent jamais, et un agent de plus ne l'allonge jamais.

Cette simulation a révélé deux défauts du premier modèle, corrigés avant
le commit :
- l'attente de l'énergie avant le premier pixel après la rafale ;
- une rafale instantanée placée pendant une pause.

### Résultat nul et raisons

L'ETA vaut **0** quand il ne reste aucun travail : modèle entièrement
observé et conforme, ou aucun pixel éligible. C'est vrai même sans
agent, et la vérification de fraîcheur et de couverture passe d'abord.
Sinon, `durationMs` vaut `null` avec les raisons (`unavailable`), sans
valeur arbitraire de remplacement.

| Code | Situation |
|---|---|
| `INVALID_PARAMETERS` | paramètre ou ressource invalide : énergie négative ou non entière, régénération ≤ 0, cadence négative, couverture minimale hors de [0, 100], pause vide, agent en double, observation postérieure à `now`, instantané « future »… |
| `STALE_SNAPSHOT` | instantané trop ancien pour la politique de sa source |
| `INSUFFICIENT_OBSERVATION` | couverture inférieure à `minCoveragePercent` (paramètre obligatoire, sans valeur par défaut) |
| `NO_AGENT` | du travail reste et aucun agent n'est fourni |
| `INSUFFICIENT_ENERGY` | aucun agent ne peut accumuler l'énergie d'un pixel, ou, même sans limite de temps, les agents capables de peindre certaines couleurs ne régénèrent jamais assez d'énergie (couleurs listées) |
| `COLORS_UNAVAILABLE` | couleurs avec du travail restant qu'aucun agent capable n'a débloquées (liste des couleurs) |
| `OUT_OF_RANGE` | durée au-delà de 2^53 ms |

## 4. Performances (`npm run bench:progress`)

Windows 10, Node 22.23.2. Médiane de 5 exécutions, un processus par
taille. Instantané couvrant l'image : la moitié des pixels sont corrects,
les autres alternent couleur fausse et vide.

| Taille | Uniforme | Pixel art | Bruit (32 couleurs) | Pixel art, 50 % inconnus | Pixel art, 100 % inconnus |
|---|---|---|---|---|---|
| 1000 × 1000 | 34–38 ms | 41–55 ms | 62–71 ms | 40–57 ms | 19–24 ms |
| 2000 × 2000 | 93–108 ms | 92–96 ms | 173–182 ms | 105 ms | 71–72 ms |
| 4096 × 4096 | 316–328 ms | 312–338 ms | 644–683 ms | 311–342 ms | 256–319 ms |

Fourchettes de deux exécutions complètes.

**Coût par couleur** (bruit, 2000 × 2000) :

| Couleurs | Durée | Par pixel éligible |
|---|---|---|
| 1 | 71–75 ms | environ 20 ns |
| 32 | 173–182 ms | environ 50 ns |
| 256 | 152–158 ms | environ 44 ns |

Le surcoût vient de la recherche de la couleur dans un `Map` à chaque
changement de couleur. Il n'est pas optimisé : aucun objectif n'est fixé
pour la progression. Une table compacte comme celle de color-by-color est
possible si le besoin apparaît.

**Effet des pixels inconnus** : ils coûtent moins cher, car un pixel hors
de l'instantané n'appelle pas `get`.

**Mémoire supplémentaire** :
- les compteurs occupent 40 octets par couleur ;
- le pic mesuré du tas varie de quelques Ko à 4 Mo d'une exécution à
  l'autre, pour un même calcul, et ne dépend pas de la taille de l'image
  (même ordre de grandeur en 1000² et en 4096²). C'est l'activité du tas
  JS, pas une allocation par pixel.

**ETA** : environ 7 ms, quelle que soit la taille (32 couleurs, 3 agents
aux palettes différentes, une pause). Il ne travaille que sur les
compteurs par couleur.

## 5. Limites connues

- Une source **sans politique de fraîcheur** (`unchecked`) est acceptée
  par l'ETA quel que soit son âge : c'est à l'appelant de configurer une
  politique pour les observations importées.
- La borne « jamais inférieure à la simulation » est vérifiée pour **un
  seul agent**. Avec plusieurs agents, seule la monotonie est testée ; la
  répartition reste l'hypothèse optimiste n° 6.

- Pas de lecture en masse des instantanés : un appel `get` par pixel. Une
  lecture par ligne réduirait le coût. Elle ne sera ajoutée au contrat que
  si une mesure le justifie (1B.6 ou 1B.7).
- L'ETA ne connaît ni les refus d'écriture ni les modifications par des
  tiers. Ses hypothèses optimistes sont nommées dans le résultat.
- Les intervalles de régénération sont supposés constants. Une
  amélioration achetée en cours de route n'est pas prise en compte
  (Phase 1B.5).
