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
import { computeProgress, createArraySnapshot, estimateEta, etaAgentsFrom } from '@geoplacer/core';

const instantane = createArraySnapshot({
  rect, coordinateSystem, source: 'imported-snapshot', observedAt, pixels, // Int32Array
});
const progression = computeProgress(modele, instantane, maintenant, {
  freshness: { 'imported-snapshot': { maxAgeMs: 10 * 60_000 } },          // politique par source
});
// Phase 1B.5 : les agents viennent du ResourceManager, les paramètres portent les règles.
const eta = estimateEta(progression, etaAgentsFrom(ressources, maintenant), {
  rules: ressources.rules, msPerPixel: 0, minCoveragePercent: 95,
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

- Un seul parcours de la région éligible, ligne par ligne, par la
  **classification partagée** `scanEligibleRows` (Phase 1B.6). Le
  `WorkPlanner` utilise la même ; la progression et le planificateur ne
  peuvent donc pas diverger sur l'état d'un pixel.
- Pour chaque pixel, la position sur la toile est calculée par la
  projection de la Phase 1B.1 (axe y montant ou descendant).
- **Lecture par ligne** : si l'instantané fournit `readRow(y, x0, x1, out)`
  (facultatif, Phase 1B.6), une ligne entière est copiée d'un coup. Sinon,
  la valeur est lue par `snapshot.get`, avec un seul objet point réutilisé.
  Les deux chemins donnent les mêmes résultats (test de propriété
  d'équivalence). Il n'y a **pas de second format** : `readRow` renvoie
  exactement les valeurs de `get`.
- Les pixels hors du rectangle de l'instantané sont **inconnus** sans
  interroger l'instantané. Une valeur invalide renvoyée par `get` (NaN,
  fraction, hors 24 bits) est conservée telle quelle, puis classée
  inconnue (`invalid`), par les deux chemins.
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
| `not-evaluated` | aucune politique pour cette source : l'âge **n'est pas jugé** (`ageMs` reste indiqué) ; l'ETA ajoute l'avertissement `FRESHNESS_NOT_EVALUATED` |
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
   (cadence C), et dépense le `costPerPixel` (k) des règles par pixel.
4. **Énergie** (Phase 1B.5) : elle vient du modèle commun des ressources
   (`advance`) : pas entiers, phase inconnue comme borne basse. La
   régénération pendant la rafale initiale, les pauses et l'attente est
   ignorée (pessimiste).
5. **Rythme** (`paintingCapacity`, modèle commun) : l'agent peint d'abord
   B = ⌊E / k⌋ pixels avec son énergie, puis attend la régénération, phase
   inconnue et reste d'énergie compté nul. Avec une régénération d'une
   unité : un pixel tous les D = max(C, k × R), après une première attente
   d'au plus min(C, k × R). Avec A unités : le gain sûr par pas est
   min(A, capacité − k + 1), l'énergie étant plafonnée.
6. **Répartition** : le travail est réparti entre agents de la meilleure
   façon possible, dans le respect de leurs palettes. C'est la seule
   hypothèse **optimiste** ; elle est exacte avec un seul agent, le cas de
   la V1.
7. Aucune écriture refusée, aucune modification par un tiers, aucune
   panne (optimiste).
8. Personne ne peint pendant les pauses configurées. Un agent indisponible
   commence à la fin de son indisponibilité (jamais si elle n'a pas de
   fin).

Les agents ont chacun leur état de ressources (énergie, niveaux,
palette, disponibilité) sous les règles communes du fournisseur (voir
[ressources.md](ressources.md) § 5).

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

**Avertissements** (n'empêchent pas l'estimation, Phase 1B.5) :
`FRESHNESS_NOT_EVALUATED` (instantané sans politique de fraîcheur),
`SIMULATED_RESOURCES` (états simulés), `RESOURCE_AGE_NOT_EVALUATED` (âge des
observations de ressources non jugé, faute de `maxResourceAgeMs`).

Depuis la Phase 1B.6, une observation de ressources plus ancienne que
`maxResourceAgeMs` n'est plus un simple avertissement : l'ETA est
**indisponible** (`STALE_RESOURCES`), et n'est jamais présentée comme
fiable.

L'ETA vaut **0** quand il ne reste aucun travail : modèle entièrement
observé et conforme, ou aucun pixel éligible. C'est vrai même sans
agent, et la vérification de fraîcheur et de couverture passe d'abord.
Sinon, `durationMs` vaut `null` avec les raisons (`unavailable`), sans
valeur arbitraire de remplacement.

| Code | Situation |
|---|---|
| `INVALID_PARAMETERS` | paramètre, règles ou état de ressources invalide : règles incohérentes, état invalide, d'un autre agent, d'autres règles ou daté après `now`, cadence négative, couverture minimale hors de [0, 100], pause vide, agent en double, instantané « future »… |
| `STALE_SNAPSHOT` | instantané trop ancien pour la politique de sa source |
| `STALE_RESOURCES` | observation de ressources plus ancienne que `maxResourceAgeMs` (Phase 1B.6) |
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

- Une source **sans politique de fraîcheur** (`not-evaluated`) est encore
  acceptée par l'ETA, mais jamais présentée comme actuelle : le résultat
  porte l'avertissement `FRESHNESS_NOT_EVALUATED` et l'âge de
  l'instantané. Configurer une politique pour les observations importées
  reste à la charge de l'appelant.
- La borne « jamais inférieure à la simulation » est vérifiée pour **un
  seul agent**. Avec plusieurs agents, seule la monotonie est testée ; la
  répartition reste l'hypothèse optimiste n° 6.

- **Lecture par ligne (Phase 1B.6)** : `readRow` est implémentée, avec
  copie de la ligne, par l'instantané en tableau. Mesures dans un même
  build :

  | Taille | Image | `readRow` | `get` seul | Gain |
  |---|---|---|---|---|
  | 2000² | pixel art | 88 ms | 107 ms | ×1,22 |
  | 2000² | bruit | 169 ms | 210 ms | ×1,24 |
  | 4096² | pixel art | 351 ms | 532 ms | ×1,52 |
  | 4096² | bruit | 673 ms | 840 ms | ×1,25 |

  Le gain est plus faible que celui du prototype de la 1B.5 (vue sans
  copie). Le chemin `get` seul est un peu plus lent qu'en 1B.4, à cause de
  la classification partagée en deux passes ; ce coût est accepté pour
  garder une seule définition de l'état d'un pixel. La table de couleurs
  compacte pour le bruit n'est pas faite.
- L'ETA ne connaît ni les refus d'écriture ni les modifications par des
  tiers. Ses hypothèses optimistes sont nommées dans le résultat.
- Les intervalles de régénération sont supposés constants. Une
  amélioration achetée en cours de route n'est pas prise en compte
  (Phase 1B.5).

## 6. Progression incrémentale (Phase 1B.10)

**Constat.** Sur un modèle de 2000 × 2000, le calcul complet de la
progression représentait environ la moitié d'un cycle de l'ordonnanceur
(profil : `scanEligibleRows` 25 %, rappel de progression 20 %).

**Principe** (`packages/core/src/progress/incremental.ts`,
`createIncrementalProgress`) : le calculateur garde les valeurs observées
au cycle précédent et les compteurs par couleur. À chaque appel, il relit
les lignes éligibles de l'instantané, les compare aux valeurs précédentes,
et ne reclasse **que les pixels qui ont changé**, quelle que soit
l'origine du changement (l'agent ou un acteur extérieur) : aucune
hypothèse sur la cause, donc les modifications extérieures restent vues.

**Garde-fous** :
- une seule définition de l'état d'un pixel, `classifyValue`, partagée
  avec le calcul complet ;
- reconstruction complète à tout changement de modèle, de révision,
  d'image, de placement, de repère ou de rectangle lu, après
  `invalidate()` (restauration, nouveau monde) et tous les 100 appels ;
- **comparaison au calcul complet tous les 10 appels** : en cas d'écart,
  le résultat complet est utilisé, l'état est reconstruit et l'écart est
  compté (`stats.mismatches`) ; jamais de compteur périmé ;
- un instantané sans `readRow` utilise toujours le calcul complet ;
- chaque nouvel ordonnanceur (redémarrage, restauration) repart d'un
  calcul complet.

`SchedulerConfig.progressMode` vaut `'full'` par défaut dans le cœur ; le
service du serveur utilise `'incremental'`.

**Mesures** (`npm run bench:responsiveness -- <côté> <secondes>
full|incremental`, même machine, même build, machine calme) :

| Modèle | Mode | Premier lot | Cycle médian / p95 | Débit | HTTP médian / max | Événements `status` : écart médian / max | Boucle d'événements : attente max | Mémoire |
|---|---|---|---|---|---|---|---|---|
| 256² | complet | 0,31 s | 17 / 21 ms | 52 244 px/s | 1,5 / 13 ms | 253 / 302 ms | 37 ms | 151 Mio |
| 256² | incrémental | 0,32 s | 16 / 20 ms | 52 831 px/s | 1,6 / 14 ms | 252 / 310 ms | 48 ms | 170 Mio |
| 2000² | complet | 0,68 s | 199 / 212 ms | 4 948 px/s | 1,6 / 15 ms | 398 / 664 ms | 223 ms | 236 Mio |
| 2000² | incrémental | 0,68 s | 121 / 216 ms | 7 392 px/s | 1,6 / 15 ms | 353 / 666 ms | 369 ms | 255 Mio |
| 4096² | complet | 1,54 s | 743 / 890 ms | 1 303 px/s | 2,3 / 15 ms | 742 / 1 526 ms | 968 ms | 551 Mio |
| 4096² | incrémental | 1,78 s | 434 / 812 ms | 2 036 px/s | 1,9 / 18 ms | 434 / 1 762 ms | 1 310 ms | 560 Mio |

Import et sélection d'un modèle de 4096² : 4,4 s dans les deux modes.
Lecture d'une région de 4096² pour l'affichage (un pixel sur 2) : 46 ms,
21 Mio de JSON. Les événements `status` sont ceux que le service envoie
au WebSocket (regroupés toutes les 250 ms) ; l'écart est mesuré à
l'abonnement au service, sans le transport réseau.

**Décision : adoptée par le service.** Le bénéfice est démontré sur les
grands modèles (cycle médian −39 % à 2000², −42 % à 4096², débit +49 % et
+56 %, écart médian entre statuts réduit), sans effet sur les petits.
Contreparties mesurées :
- les cycles de vérification et de reconstruction restent aussi longs
  qu'un cycle complet (p95 proche) ;
- l'attente **maximale** de la boucle d'événements augmente (223 → 369 ms
  à 2000², 968 → 1 310 ms à 4096²), ainsi que l'écart maximal entre deux
  statuts à 4096² (1,5 → 1,8 s) : ce sont les cycles de reconstruction ;
- la latence HTTP mesurée n'en est pas affectée (médiane 1,6 à 2,3 ms,
  maximum 18 ms) ;
- mémoire : +19 Mio à 2000², +9 Mio à 4096².

Un passage sur une machine chargée (voir [qualite.md](qualite.md), Phase
1B.10) confirme l'avantage relatif dans les mêmes conditions.

**Tests** : égalité exacte avec le calcul complet à chaque pas
d'historiques aléatoires (écritures, modifications extérieures, inconnus,
valeurs invalides, lectures partielles, deux sens de l'axe Y),
reconstructions, désaccord provoqué détecté et corrigé
(`packages/core/test/progress-incremental.test.ts`) ; ordonnanceur avec
modifications extérieures : mêmes compteurs finaux dans les deux modes
(`packages/simulator/test/scheduler.test.ts`).

## 7. Réactivité : ordonnanceur coopératif (Phase 1C.0)

### Diagnostic

Mesures de la Phase 1B.10 au calme : à 4096², attente maximale de la boucle
d'événements de 1,3 s. Le banc `bench/blocking.bench.ts` horodate chaque
blocage de la boucle (battement de 2 ms) et l'attribue aux fonctions en
cours d'exécution grâce au profileur CPU de V8, lancé dans le même processus.
Il enregistre aussi les passages du ramasse-miettes et la mémoire. Constats
à 4096² (diagnostic fait sur une machine chargée à 85-97 % par un autre
logiciel : les durées sont environ deux fois celles du calme, les parts
relatives restent valables) :

- **un cycle entier était un seul bloc synchrone** : 97,7 % du temps d'un
  cycle bloquait la boucle. Les `await` du cycle se résolvent presque tous
  sans vraie attente d'E/S, et ne rendent donc pas la main ;
- **le planificateur** prenait 64 % du CPU : il reclasse tout le modèle à
  chaque cycle (`scanEligibleRows`) pour garder les meilleures clés ;
- **la progression** en prenait environ 29 % : mise à jour incrémentale
  (une copie de 64 Mio par cycle), vérification complète tous les
  10 cycles, reconstruction au démarrage (2,6 s, dont 1,1 s pour une
  `Map` consultée à chaque pixel) ;
- lecture de la toile (copie) : environ 40 ms par cycle ; ETA,
  événements, journal et toile durable : moins de 2 % ;
- ramasse-miettes : moins de 1 %, pauses inférieures à 5 ms.

Le banc de réactivité mesurait aussi mal la latence HTTP : son client
tournait dans la même boucle que le serveur et n'envoyait ses requêtes
qu'entre deux blocages. Il tourne désormais dans un thread séparé, à
intervalles fixes, comme un navigateur : la latence réelle de l'ancien code
était d'environ 230 ms en médiane à 4096², contre 3 ms annoncées.

### Options comparées

| Option | Blocage max à 4096² | Débit | Mémoire | Garanties | Complexité | Décision |
|---|---|---|---|---|---|---|
| 1. Reconstruction progressive en blocs | inclus dans 3 et 4 | — | — | — | — | intégrée (la reconstruction est découpée comme le reste) |
| 2. Worker thread (seul le coût de transfert a été mesuré, aucun prototype) | ~22 ms par envoi d'instantané (copie de 64 Mio), ~0,5 ms en mémoire partagée (`bench/worker-transfer.bench.ts`) | inchangé (le cycle reste séquentiel) | +64 Mio par copie | à reconstruire (instantané, état incrémental et planificateur dans le worker, plantage du worker) | élevée : contrats du cœur asynchrones, chargement sous `dist` et `tsx`, mémoire partagée avec le simulateur | **écartée** pour cette version : aucun gain sur le découpage, coût structurel élevé |
| 3. Cache incrémental, vérifications partielles | le cache seul (sans découpage) : 969 ms (1 339 ms avant) | inchangé | +15 Mio | inchangées | faible | **retenu en partie** : correspondance pixel → couleur conservée, deux tampons alternés ; vérification toujours complète, mais découpée |
| 4. Vérifications complètes réparties sur plusieurs cycles | la reconstruction resterait un bloc | inchangé | — | détection plus tardive d'un écart | moyenne | **écartée** : le découpage obtient le même effet sans retarder la vérification |
| 5. Découpage coopératif de tout le cycle | **31 à 75 ms** | pas de différence de débit mesurable (un passage par configuration au calme ; deux passages de l'ancien code diffèrent déjà d'environ 10 %) ; −7 à −10 % sur une machine chargée à 87 % | +15 Mio | inchangées, testées | moyenne, sans changement d'architecture | **retenu** |

### Mise en œuvre

- `SchedulerDependencies.cooperative` (facultatif) : l'ordonnanceur cède la
  boucle (`yieldTo`) entre les phases d'un cycle, et les longs calculs
  (calcul complet, planificateur, progression incrémentale, reconstruction,
  vérification) cèdent tous les `slicePixels` pixels (262 144 par défaut
  dans le service, soit 5 à 15 ms de travail). Ces calculs sont écrits une
  seule fois, comme générateurs (`progress/slices.ts`) : exécutés d'un trait
  par les API synchrones, en tranches par l'ordonnanceur. Le résultat est
  identique, testé pour toutes les tailles de tranche.
- **Cohérence de l'instantané** : toutes les tranches d'un cycle travaillent
  sur la même copie de la toile, prise au début du cycle (la lecture du
  simulateur copie la région). Une modification arrivée entre deux tranches
  (acteur extérieur, écriture) est vue au cycle suivant, comme pour toute
  lecture. Une modification arrivée après la dernière lecture d'une course
  est vue à la lecture suivante (test « outside actor » : jamais perdue).
- **Avant tout bail, et avant de déclarer la fin** : pause, arrêt et
  nouvelle révision du modèle sont revérifiés après la dernière cession.
  Un plan calculé pour une ancienne position, ou avant une pause, n'est
  jamais loué. Contre-épreuves faites : retirer l'une ou l'autre
  vérification fait échouer les tests.
- **Progression atomique** : l'état (valeurs, compteurs, nombre d'appels)
  n'est remplacé qu'à la fin d'un appel ; un appel abandonné entre deux
  tranches (pause, arrêt, erreur) ne laisse jamais de compteurs à moitié
  appliqués ; `invalidate()` pendant un appel (restauration) n'est jamais
  écrasé.
- **Aucun doublon** : une tentative n'est louée qu'après la dernière
  cession ; le journal n'est jamais attendu pendant un calcul.
- Une vérification complète reste faite tous les 10 cycles et à chaque
  reconstruction (tous les 100 cycles, et à chaque changement de modèle,
  de révision ou de toile).

### Mesures avant / après (`npm run bench:responsiveness`)

Machine calme (charge 17 à 38 %), même machine, exécutions alternées entre
l'ancien code (`6bee19c`) et le nouveau. Blocage : plus longue attente de
la boucle d'événements mesurée par un battement de 2 ms (démarrage = premier
cycle ; établi = ensuite, reconstruction périodique comprise). HTTP : client
dans un thread séparé, une requête toutes les 100 ms.

| Modèle | Version | Premier lot | Cycle médian / p95 / p99 | Débit | Blocage max démarrage / établi | Boucle : attente max | HTTP médian / p95 / max | Mémoire |
|---|---|---|---|---|---|---|---|---|
| 256² | avant | 0,32 s | 17 / 24 / 162 ms | 45 889 px/s | 46 / 22 ms | 29 ms | 1,5 / 14 / 14 ms | 183 Mio |
| 256² | après | 0,33 s | 17 / 26 / 38 ms | 49 055 px/s | 22 / 0 ms | 22 ms | 2,2 / 16 / 16 ms | 151 Mio |
| 2000² | avant | 0,72 s | 134 / 244 / 376 ms | 6 512 px/s | 385 / 413 ms | 415 ms | 61 / 192 / 354 ms | 272 Mio |
| 2000² | après | 0,69 s | 141 / 250 / 265 ms | 6 457 px/s | 33 / 51 ms | 54 ms | 3,2 / 7 / 19 ms | 280 Mio |
| 4096² | avant | 1,81 s | 441 / 841 / 896 ms | 2 009 px/s | 1 356 / 1 339 ms | 1 360 ms | 234 / 692 / 1 311 ms | 605 Mio |
| 4096² | après | 1,50 s | 442 / 835 / 849 ms | 2 010 px/s | 52 / 75 ms | 82 ms | 2,9 / 7,7 / 32 ms | 620 Mio |

Avec un acteur extérieur (25 pixels effacés toutes les 2 s, détectés puis
repeints) :

| Modèle | Version | Débit | Blocage max établi | HTTP médian / p95 / max | Mémoire |
|---|---|---|---|---|---|
| 2000² | avant | 7 141 px/s | 338 ms | 60 / 175 / 446 ms | 414 Mio |
| 2000² | après | 6 941 px/s | 34 ms | 2,9 / 6,8 / 16 ms | 249 Mio |
| 4096² | avant | 1 892 px/s | 1 310 ms | 260 / 767 / 1 244 ms | 624 Mio |
| 4096² | après | 1 877 px/s | 31 ms | 3,1 / 9,1 / 29 ms | 620 Mio |

Le premier cycle (calcul complet et reconstruction) dure 1,2 à 1,25 s à
4096² (1,4 s avant), sans bloquer la boucle plus de 52 ms. Sur une machine
chargée (87 à 89 %, mesures de la même phase), le gain est du même ordre
(4096² : blocage établi 1 736 → 94 ms, HTTP médian 610 → 6 ms) mais le débit
baisse de 7 à 10 % : sous forte charge, chaque cession attend plus
longtemps son tour.

**Refaire la comparaison** : voir l'en-tête de
`bench/responsiveness.bench.ts` (copie de travail de l'ancien code à
`6bee19c`, `BENCH_COOPERATIVE=0` pour le nouveau code sans cession,
`BENCH_SLICE` pour la taille des tranches), en alternant les exécutions sur
une machine calme.

### Limite restante

Diagnostic du **code final** (`bench/blocking.bench.ts`, 4096², 60 s,
machine calme à 18-21 %, profileur actif) : 104 cycles, **un seul blocage de
plus de 50 ms** (moins de 100 ms) ; répartition du CPU : planificateur 69 %,
calcul complet de la progression (vérifications, reconstructions) 9 %,
lecture de la toile 5 %, mise à jour incrémentale 3 %, Node.js et
cessions 12 %, ramasse-miettes moins de 1 % ; mémoire maximale 554 Mio.

Le planificateur reclasse tout le modèle à chaque cycle : il ne bloque plus
la boucle, mais son coût CPU limite le débit sur les très grands modèles
(environ 2 000 pixels par seconde à 4096²). Un planificateur **à état**
(qui ne réexamine que les pixels changés, comme la progression
incrémentale) est la piste suivante. C'est un nouveau composant, proposé
pour une phase ultérieure et non pour une version candidate.
