# Ressources des agents et améliorations

État : **Phase 1B.5**. Les ressources des agents (`src/resources/`) et le
planificateur d'améliorations (`src/upgrades/`) sont implémentés dans
`@geoplacer/core`, purs et déterministes. Aucun achat réel, aucune
boutique, aucun service externe : toutes les opérations sont simulées.

## 1. Modèle

### Règles du fournisseur (`ResourceRules`, schéma 1)

Un document explicite, versionné (`id`, `version`) et validé
strictement : un champ inconnu ou une valeur incohérente est refusé
(`INVALID_RULES`). **Aucune valeur par défaut** n'existe dans le code, et
aucune valeur de GeoPixels ou de Wplace n'y figure. En V1, les règles
sont fournies à la main ou par des scénarios simulés ; les règles des
tests portent un identifiant `test-…` et sont signalées comme
synthétiques.

| Champ | Contenu |
|---|---|
| `energy.costPerPixel` | énergie dépensée par pixel peint |
| `energy.baseCapacity`, `energy.capacityLimit` | capacité sans amélioration ; plafond facultatif, améliorations comprises |
| `energy.regenAmount`, `energy.regenIntervalMs` | +quantité à chaque intervalle |
| `energy.aboveCapacity` | énergie au-delà de la capacité (paquets) : `keep` (conservée, pas de régénération) ou `cap` (plafonnée) |
| `palette.initialColors`, `palette.unlockable` | couleurs de départ ; couleurs débloquables et leur prix |
| `upgrades.maxEnergy` | paliers successifs : prix, capacité ajoutée |
| `upgrades.regenSpeed` | paliers successifs : prix, nouvel intervalle (strictement décroissant) |
| `upgrades.energyPack` | prix, énergie, nombre d'achats maximal facultatif |
| `currency.maxSpendPerOperation` | plafond facultatif d'une dépense de monnaie |

### État d'un agent (`AgentResourceState`, schéma 1)

Chaque agent a son propre état : identifiant, énergie, monnaie, couleurs
débloquées (triées), niveaux d'amélioration, disponibilité, progression
de la régénération, date de l'état et de l'observation d'origine,
opérations simulées appliquées. Il est valable pour **un** jeu de règles
(`rules.id` et `version` vérifiés : `RULES_MISMATCH`). La capacité et
l'intervalle de régénération sont dérivés des règles et des niveaux.

| Nature (`kind`) | Origine | Remarque |
|---|---|---|
| `observed` | rapport du fournisseur ou de l'utilisateur (`ResourceObservation`) | la seule entrée de `ResourceManager.observe` ; jamais écrasé par un calcul |
| `computed` | observation + dépenses enregistrées, régénérée jusqu'à une date ≤ maintenant | |
| `projected` | même calcul pour une date future | |
| `simulated` | résultat d'une opération hypothétique (amélioration, dépense simulée) | reste `simulated` quand on le projette |

Sérialisation canonique (`serializeResourceState`) : clés dans un ordre
fixe, deux états égaux donnent le même texte. `parseResourceState`
valide tout et peut exiger une nature : un état projeté ne se relit pas
comme une observation.

## 2. Règles de régénération

- **Pas entiers** : tant que l'énergie est sous la capacité, +`regenAmount`
  à chaque intervalle complet. Une fraction d'intervalle ne donne rien ;
  elle est **conservée** (`regenProgressMs`, dans [0, intervalle)).
- **Composition** : avancer jusqu'à t1 puis jusqu'à t2 donne exactement le
  même état qu'avancer directement jusqu'à t2 (vérifié sur 400 cas). Toutes
  les fonctions sont pures : interroger deux fois le même état ne
  régénère jamais deux fois.
- **À capacité** : le minuteur est arrêté (progression 0). Il repart de 0
  quand l'énergie repasse sous la capacité (dépense, ou capacité
  augmentée). Au-dessus de la capacité (`keep`), aucune régénération.
- **Phase inconnue** : un fournisseur qui n'indique pas la progression
  donne `regenPhase: 'lower-bound'`, progression 0 comme borne basse.
  Toutes les prévisions sont alors pessimistes : jamais plus d'énergie,
  jamais une attente plus courte que la réalité.
- **Entre deux observations** : sans progression rapportée, la
  progression prévue est **reportée** si l'observation confirme la
  prévision (même énergie, mêmes niveaux) ; sinon elle repart comme borne
  basse. Testé avec deux observations distantes de moins d'un intervalle.
- **Changement de vitesse** : la progression est conservée mais plafonnée
  sous le nouvel intervalle : aucun pas n'est crédité à l'instant du
  changement.
- **Temps explicite** : chaque fonction reçoit les dates (`at`, `now`) ;
  aucune ne lit l'horloge. Une date antérieure à l'état est refusée
  (`TIME_BEFORE_STATE`).

Fonctions : `advance`, `timeUntilEnergy` (attente pour une quantité :
0, une durée, ou `null` si elle dépasse la capacité), `checkEnergy`
(disponible maintenant ? atteignable un jour ?), `applyOperation`,
`consumeEnergy`, `paintingCapacity` (partagée avec l'ETA).

## 3. Opérations et gestionnaire

**Opérations** (`applyOperation`) : dépense d'énergie, capacité, vitesse,
paquet d'énergie, déblocage de couleur. Chacune vérifie le niveau
suivant, le prix, la monnaie, les plafonds, et porte un identifiant
appliqué **une seule fois** (`DUPLICATE_OPERATION`). Jamais d'énergie,
de capacité ou de monnaie négative (propriétés sur 150 séquences de 25
opérations aléatoires). Les améliorations ne produisent que des états
`simulated`.

**`ResourceManager`** (`createResourceManager`), source unique de vérité :

| Situation | Comportement |
|---|---|
| Observation plus ancienne que celle connue | refusée (`STALE_OBSERVATION`) |
| Observation à la même date, différente | refusée ; identique : acceptée telle quelle |
| Dépense datée au plus tard de l'observation | non appliquée, signalée `absorbed-by-observation` (déjà reflétée) |
| Dépenses absorbées par une nouvelle observation | listées dans `absorbedSpends` |
| Même identifiant, même contenu | `duplicate`, non réappliquée |
| Même identifiant, autre contenu | refusée (`DUPLICATE_OPERATION`) |
| Dépense plus ancienne que la dernière enregistrée | refusée (`OUT_OF_ORDER`) |
| Énergie insuffisante | refusée (`INSUFFICIENT_ENERGY`) |
| Dépense contredite par une observation plus récente | ne consomme que l'énergie disponible ; listée dans `inconsistentSpends` |

Les dépenses enregistrées sont gardées dans un registre (avec leurs
identifiants), lisible par `recordedSpends(agent)` : c'est leur
traçabilité. Les états calculés ne les répètent pas dans `operations`,
qui ne liste que les opérations appliquées par `applyOperation`
(simulations). Un état de tête, après la dernière dépense, rend une
requête récente ou une nouvelle dépense constante en temps. Une requête
antérieure rejoue le registre, sans copie.

## 4. Améliorations simulables (`UpgradePlanner`)

Quatre étapes séparées :

1. **Analyse** (`analyzeUpgrade`) : prix, conditions, effets attendus
   (capacité, intervalle, énergie, monnaie, couleur), ou raison
   d'impossibilité : `NOT_CONFIGURED`, `MAX_LEVEL`, `NOT_UNLOCKABLE`,
   `INSUFFICIENT_CURRENCY`, `LIMIT_EXCEEDED`.
2. **Simulation** (`proposeUpgrades`) : état simulé, ETA avant et après,
   bénéfice, recommandation, rang, avertissements de l'ETA.
3. **Confirmation** (`confirmUpgrade`) : seulement `confirmedBy: 'user'`,
   pour cette proposition précise, après son calcul, et si elle est
   possible.
4. **Application** (`applyConfirmedUpgrade`) : à un état **simulé**,
   uniquement sur l'état exact de la proposition (`STALE_PROPOSAL` sinon),
   une seule fois (identifiant de la proposition).

Options d'un agent : capacité, vitesse de régénération, paquet
d'énergie, et chaque couleur débloquable qu'il n'a pas.

| Bénéfice | Sens |
|---|---|
| `enables-estimate` | l'ETA était indisponible et le devient (par exemple une couleur manquante) |
| `reduces-eta` | l'ETA raccourcit |
| `no-measurable-benefit` | pas d'ETA plus court : **jamais recommandée** pour la seule raison qu'elle existe |
| `not-evaluable` | non simulée (impossible), ou ETA indisponible avant comme après pour des raisons que l'amélioration ne touche pas |

**Classement** (total et déterministe) :
1. possibles d'abord ;
2. ordre des bénéfices ci-dessus ;
3. `enables-estimate` : ETA obtenu le plus court ; `reduces-eta` : temps
   gagné par unité de monnaie décroissant (comparé exactement par
   produits croisés en entiers longs ; une amélioration gratuite passe
   devant), puis temps gagné ;
4. prix croissant, type (capacité, vitesse, paquet, couleur), couleur.

## 5. Intégration avec l'ETA

- **Une seule implémentation de la régénération** : l'ETA prend l'énergie
  de départ par `advance` et la capacité de peinture par
  `paintingCapacity` ; il ne garde que l'ordonnancement (disponibilité,
  pauses, répartition par flot, recherche de la durée).
- **Entrées** : chaque agent porte son état de ressources
  (`etaAgentsFrom(manager, now)`), les paramètres portent les règles (le
  coût par pixel n'est plus un paramètre séparé). Palettes individuelles
  et niveaux d'amélioration simulés sont pris en compte ; un état simulé
  ajoute l'avertissement `SIMULATED_RESOURCES`.
- **Porte d'équivalence** : la version 1B.4 est figée dans les tests.
  Avec une régénération de 1, les résultats sont **identiques sur les
  corpus essayés** : 2 000 cas aléatoires à chaque exécution (graine fixe),
  40 000 sur 20 graines, et 3 000 sur 3 000 identiques aux sorties
  enregistrées au commit 1B.4. Ils peuvent différer dans un cas rare, où
  la 1B.4 sous-estimait (voir ci-dessous) : deux exemples sont épinglés
  par des tests, avec leurs valeurs 1B.4 et simulées.
- **Accord avec `ResourceManager.timeUntil`** (testé sur 200 cas) : l'ETA
  n'est jamais plus court que l'attente de l'énergie nécessaire, et lui
  est égal quand la progression de régénération est 0. Quand une
  progression exacte est connue, l'ETA l'ignore après l'énergie initiale
  (phase traitée comme inconnue, pessimiste) : il peut dépasser l'attente
  réelle d'au plus un intervalle. Utiliser la progression connue serait
  plus juste, mais romprait l'équivalence stricte avec la 1B.4 : décision
  à prendre.
- **Âge des observations de ressources** : l'énergie est projetée depuis
  la dernière observation, et une dépense faite ailleurs depuis serait
  inconnue. Avec `maxResourceAgeMs`, une observation plus ancienne lève
  l'avertissement `STALE_RESOURCES` ; sans politique, un âge non nul lève
  `RESOURCE_AGE_NOT_EVALUATED`. Ce sont des avertissements, pas des refus.
- **Régénération de plusieurs unités** (nouveau) : le gain utile par pas
  est min(quantité, capacité − coût + 1), car l'énergie est plafonnée à la
  capacité ; avec 1, rien ne change. Vérifié empiriquement (simulation,
  quantités 1 à 3, un agent), non démontré.
- **Deux défauts de borne corrigés**, trouvés par la simulation
  indépendante : la régénération plafonnée (cas nouveau, quantité > 1) ;
  un pixel instantané (cadence 0) compté à l'instant où commence une pause
  (présent en 1B.4, cas rare, absent des corpus).
- **Hypothèses** : pessimistes (pixels inconnus à repeindre, phase
  inconnue, régénération ignorée pendant la rafale et les pauses, reste
  d'énergie compté nul) ; optimistes (répartition idéale entre agents,
  exacte avec un seul agent ; aucune écriture refusée). Elles sont
  renvoyées avec chaque résultat.

## 6. Performances (`npm run bench:resources`)

Windows 10, Node 22.23.2, règles synthétiques, médiane de 7.

| Mesure | Durée |
|---|---|
| `advance`, 100 000 appels | 5,4 à 6,6 ms |
| `stateAt` après 10 000 dépenses enregistrées | ≈ 1 µs |
| `stateAt` au milieu de 10 000 dépenses (rejeu) | 1,7 ms |
| ETA, 3 agents, 32 couleurs | 8 à 9 ms |
| Planificateur : 11 options, chacune avec un ETA avant / après | 96 à 97 ms |
| ETA dans `bench:progress` (3 agents, 32 couleurs, une pause) | 13 à 21 ms (7 ms en 1B.4 : validation des états et avertissements en plus) |

Le benchmark a révélé un coût cubique du premier registre (copie de la
liste des opérations à chaque dépense rejouée) : bloqué au-delà de
quelques milliers de dépenses. Corrigé (état de tête, `consumeEnergy`).

## 7. Limites

- Persistance des états de ressources : sérialisation prête, mais aucun
  stockage ni reprise après arrêt dans cette phase (pas d'opération
  persistée).
- Le registre garde tous les identifiants de dépenses vus (détection des
  doublons) : il grandit avec le temps ; une purge sera nécessaire avec
  la file persistante (1B.6+).
- L'âge d'une observation de ressources est signalé, jamais jugé
  bloquant : à décider s'il doit rendre l'ETA indisponible.
- Les règles d'un fournisseur réel restent à saisir par l'utilisateur ;
  rien n'est lu d'un service.
