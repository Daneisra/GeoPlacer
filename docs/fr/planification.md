# Planification du travail, tentatives et reprise après crash (Phase 1B.6)

Ce document décrit comment le moteur choisit les prochains pixels à
peindre (`WorkPlanner`), comment il suit chaque envoi (`AttemptManager`,
journal, historique) et comment il reprend après un arrêt brutal.

Tout se déroule sur une **toile simulée locale**. Aucun appel à un service
réel n'existe dans le code, ni dans les tests.

## 1. Principe : le travail est dérivé, jamais stocké pixel par pixel

Le travail restant n'est **pas** enregistré comme une liste de tâches. Il
est recalculé à chaque lot à partir de trois éléments :

- la **révision** du modèle (image quantifiée, placement) ;
- l'**ordre de la stratégie**, sous forme de clé de classement par pixel
  (voir [strategies.md](strategies.md), § 4) ;
- un **instantané de la toile**, qui fait foi.

Seules les **tentatives** (journal) et l'**historique** sont persistés.
Un pixel abîmé n'importe où dans l'ordre, même déjà dépassé, est donc
retrouvé au lot suivant. Aucune liste n'est à réparer après un crash.

## 2. Préparer un modèle

| Fonction | Rôle |
|---|---|
| `prepareTemplateSync(template)` | Construit les clés d'ordre (sans cache). |
| `prepareTemplate(template, { hasher, orderCache? })` | Idem. Pour l'aléatoire, lit ou écrit le cache vérifié de l'ordre PCG32 V1. |

La préparation se fait **une fois par révision**. Pour sept stratégies, la
clé se calcule en O(1) sans mémoire. Pour l'aléatoire, une table des rangs
de 4 octets par pixel est nécessaire.

`PreparedTemplate.keySource` indique `computed`, `cache` ou `generated`. En
cas de cache absent ou corrompu, `keyProblem` en donne la raison. Un cache
**manquant ou corrompu ne rend jamais le modèle inutilisable** : l'ordre
est régénéré, puis le cache réécrit au mieux.

## 3. `nextBatch` : le prochain lot

`nextBatch(prepared, request)` renvoie les k premiers pixels, dans l'ordre
de la stratégie, qui remplissent toutes ces conditions :

- **à peindre** : mauvaise couleur ou vide dans l'instantané. Les pixels
  **inconnus** ne sont retenus qu'avec la politique `unknownPixels: 'include'`.
  La politique `'skip'` les laisse de côté. Un pixel inconnu n'est jamais
  tenu pour correct.
- **couleur disponible** pour l'agent. Les autres sont comptés par couleur
  dans `unavailableColors`.
- **pas en cours** : aucun point d'une tentative ouverte, quels que soient
  le modèle, la révision ou l'agent (`inFlight`).
- **dans le budget** : `budget = floor((énergie − énergie engagée) / coût)`.
  `k = min(maxBatch, budget)`.

Le parcours lit l'instantané ligne par ligne (`readRow` quand il existe,
sinon `get`, avec des résultats identiques). Il garde les k plus petites
clés dans un tas borné en tableaux typés. **L'ordre complet n'est jamais
généré.**

**Identifiants déterministes** : `taskId = projet/modèle@révision:x,y:#rrggbb`.
Ils ne sont construits que pour les k pixels retenus. Le même pixel,
redevenu incorrect, garde le même `taskId`, mais il est envoyé par une
**nouvelle** tentative avec un nouvel identifiant.

### Statuts et refus

| Statut | Sens |
|---|---|
| `ok` | Des pixels sont proposés. |
| `waiting` | Du travail existe, mais le budget est nul. `waitMs` donne le délai avant un pixel de plus (`null` si la régénération n'y suffira jamais). |
| `nothing-to-do` | Aucun candidat : tout est correct, ou bien les pixels sont inconnus et ignorés, de couleur indisponible ou déjà en cours. |
| `refused` | Aucune écriture n'est proposée. Voir les refus ci-dessous. |

Les refus sont vérifiés **avant** tout parcours :

| Code | Cause |
|---|---|
| `STALE_SNAPSHOT` | Instantané plus vieux que la politique de fraîcheur de sa source. |
| `FUTURE_SNAPSHOT` | Instantané daté dans le futur. |
| `COORDINATE_SYSTEM_MISMATCH` | Le repère de l'instantané diffère de celui du modèle. |
| `INVALID_RESOURCES` | État de ressources invalide. |
| `STALE_RESOURCES` | Observation des ressources plus vieille que `maxResourceAgeMs`. |
| `RESOURCES_UNCERTAIN` | Une tentative s'est terminée sans dépense connue, et aucune observation plus récente n'existe. |
| `AGENT_UNAVAILABLE` | Agent indisponible. |
| `INVALID_REQUEST` | Paramètres invalides. |

**Nouvelle révision** : un `PreparedTemplate` correspond à une révision.
Après une modification, il faut préparer la nouvelle révision et appeler
`AttemptManager.revisionChanged` (§ 4).

## 4. Tentatives (`AttemptManager`)

Une tentative regroupe les pixels d'un lot envoyés ensemble par un agent.
Elle porte :

- un identifiant unique et durable (UUID, jamais réutilisé) ;
- l'agent, le projet, le modèle et la révision ;
- les pixels et l'énergie engagée ;
- les dates de réservation, d'expiration du bail, de démarrage, d'envoi en
  réconciliation et de clôture ;
- l'état, les résultats connus et la raison.

### États

| Code | État | Sens |
|---|---|---|
| `leased` | Réservée | Bail pris, rien n'est envoyé. |
| `started` | Démarrée | Journalisée **avant** l'écriture sur la toile. |
| `finished` | Terminée | Résultats connus, ou constatés par réconciliation. |
| `failed` | Échouée | Échec signalé par l'écrivain, avec les résultats connus. |
| `cancelled` | Annulée | Uniquement si elle n'a jamais été démarrée. |
| `needs-reconciliation` | À réconcilier | Démarrée, mais son résultat est incertain : crash, bail expiré ou nouvelle révision. |

Transitions permises (les autres sont refusées avec `INVALID_TRANSITION`) :

| Depuis | Vers |
|---|---|
| Réservée | Démarrée, Échouée, Annulée, À réconcilier (reprise d'un journal endommagé) |
| Démarrée | Terminée, Échouée, À réconcilier, Terminée par réconciliation |
| À réconcilier | Terminée par réconciliation |
| Terminée, Échouée, Annulée | aucune (états finaux) |

### Ce qui est garanti

- **Bail** : il est refusé en entier si un seul point est déjà en cours
  (`OVERLAP`), si une couleur n'est pas débloquée, si l'agent est
  indisponible ou si l'énergie est déjà engagée par d'autres tentatives
  ouvertes. Les opérations d'un gestionnaire sont **sérialisées** : de
  deux baux simultanés qui se chevauchent, un seul est accordé (testé).
- **Journal d'abord** : chaque transition est écrite dans le journal
  (durable) avant de modifier l'état en mémoire. Si l'écriture échoue,
  l'état ne change pas (test par injection de fautes).
- **Jamais de relance aveugle** : le gestionnaire n'envoie jamais deux fois
  la même tentative. Un résultat incertain se règle par **réconciliation**,
  c'est-à-dire une lecture fraîche de la toile qui donne `observed-correct`,
  `observed-incorrect` ou `observed-unknown`, et jamais `applied`. Un pixel
  constaté incorrect est replanifié par une **nouvelle** tentative.
- **Lecture de réconciliation récente** : elle doit être postérieure au
  démarrage et, si la tentative a été envoyée en réconciliation, à cet
  envoi. Une lecture prise entre le démarrage et un crash peut en effet
  précéder l'écriture.
- **Énergie** :
  - la dépense des pixels **appliqués** est enregistrée **une fois**, à la
    clôture, auprès du `ResourceManager`, avec l'identifiant de la
    tentative comme identifiant d'opération ;
  - si l'écrivain renvoie une observation de ressources avec son résultat,
    on la passe à `finish` : elle est observée **à la place** de la dépense,
    jamais les deux, et il n'y a donc pas de double consommation (testé
    dans les deux ordres) ;
  - un résultat inconnu, un pixel sans résultat ou une réconciliation
    rendent les ressources de l'agent **incertaines** jusqu'à une
    observation plus récente (`RESOURCES_UNCERTAIN`).
- **Bail expiré** (`expire`) : une tentative réservée est annulée, une
  tentative démarrée est envoyée en réconciliation. Elle n'est jamais
  libérée.
- **Nouvelle révision** (`revisionChanged`) : les tentatives réservées des
  révisions antérieures sont annulées. Les tentatives démarrées sont
  envoyées en réconciliation.

### Ce qui n'est pas garanti

- **Pas d'exécution « exactement une fois »**. Une écriture dont la
  réponse est perdue a pu être appliquée. Le gestionnaire ne la renvoie
  pas, mais la réconciliation constate seulement l'état de la toile :
  `observed-correct` ne prouve pas que *cette* tentative a peint le pixel.
  Un écrivain qui respecte l'identifiant de tentative comme clé
  d'idempotence (`CanvasWriter.idempotentWrites`) rendrait un renvoi sans
  effet. Le simulateur de test le permet, mais le gestionnaire n'en dépend
  pas.
- **Un seul gestionnaire par répertoire de données** : le verrou du
  répertoire est celui de l'appelant.

## 5. Journal et historique

| Fichier | Contenu |
|---|---|
| `<données>/journal/attempts.log` | Un événement de tentative par ligne. |
| `<données>/journal/history.log` | Une entrée d'historique par tentative close. Fichier séparé, jamais compacté avec le journal. |

**Format de ligne** (partagé par les deux fichiers, défini dans le cœur) :
`<CRC-32 en 8 chiffres hexadécimaux> {"v":1,"event":…}\n`. La ligne est en
ASCII pur (caractères non ASCII échappés). Le CRC-32 est celui des PNG,
déjà présent dans le cœur, et couvre le JSON.

À la relecture :

- **Fin déchirée** : une dernière ligne sans fin de ligne correspond à un
  ajout interrompu. Elle est ignorée et mesurée (`discardedTailBytes`).
  Avant l'ajout suivant, elle est mise de côté dans
  `attempts.log.torn-<uuid>`, puis coupée, afin que les nouvelles lignes ne
  la suivent jamais.
- **Ligne endommagée avant la fin** : erreur de CRC, de format, de version
  ou événement invalide. Elle est **signalée** (`corruptLines`) à chaque
  relecture et n'est jamais supprimée. Le fichier est conservé tel quel.
- Un événement valide mais qui n'est pas une transition permise est
  ignoré et compté (`inconsistentEvents`).

**Écriture** : une seule écriture de ligne complète, puis `fsync`, avant
de rendre la main. Les adaptateurs exigent le verrou du répertoire de
données.

**Durabilité** : elle est testée contre l'**arrêt brutal du processus**
(processus réels tués pendant les ajouts). Elle n'est **pas** démontrée
contre une coupure électrique : cela dépend du disque qui honore `fsync`,
et aucun test approprié n'existe.

## 6. Reprise après crash

Au démarrage, `recover(now)` est obligatoire avant toute autre opération
(sinon `NOT_RECOVERED`) :

1. **Relire le journal** et rejouer chaque événement avec la même machine
   d'états (`transition`, fonction pure).
2. **Identifier les tentatives incomplètes** :
   - une tentative **réservée jamais démarrée** est annulée (« libérée ») ;
     elle n'a rien envoyé, puisque le démarrage est journalisé avant
     l'écriture ;
   - une tentative **démarrée sans clôture** est envoyée en réconciliation.
3. **Journal endommagé** (lignes corrompues ou incohérentes) : un
   événement « démarrée » a pu être perdu. **Toutes** les tentatives
   ouvertes sont donc envoyées en réconciliation, et aucune n'est libérée.
4. **Ressources incertaines** : le registre des dépenses du
   `ResourceManager` ne survit pas au redémarrage. Chaque agent ayant
   démarré une tentative exige une observation plus récente que sa
   dernière clôture journalisée.
5. **Vérifier sur la toile** : l'appelant lit une région fraîche, prise
   après la reprise, puis appelle `reconcile` pour chaque tentative de
   `toReconcile`.
6. **Replanifier** : `nextBatch` ne propose que le travail nécessaire,
   puisque la toile fait foi.

`RecoveryReport` contient `released`, `toReconcile`, `discardedTailBytes`,
`corruptLines` et `inconsistentEvents`. La reprise est idempotente : une
deuxième reprise ne libère rien de plus (testé).

## 7. Plusieurs agents

La V1 n'active qu'un agent. Le modèle est **préparé** pour plusieurs
agents sur un même projet, sans être activé sur un service réel :

- les points en cours sont partagés, quel que soit l'agent ;
- l'énergie engagée et l'incertitude des ressources sont comptées par
  agent ;
- un test de propriétés fait travailler trois agents simulés sur une
  toile locale, avec fautes injectées et crashs simulés. Il vérifie :
  - qu'aucun point n'est dans deux tentatives ouvertes ;
  - qu'aucun pixel n'est appliqué deux fois ;
  - que le travail éligible est conservé (tout pixel incorrect finit
    correct) ;
  - qu'une dépense n'est enregistrée qu'une fois par identifiant.

## 8. Performances

Conditions : Windows 10, Node 22.23.2, machine de développement. Image en
pixel art à 32 couleurs, avec environ 3 % de pixels transparents.
Médiane de 5 exécutions après un échauffement, un processus par taille.
Les instantanés sont en mémoire, avec `readRow`.

### Premier lot de 1 000 pixels (`npm run bench:planner`)

Le modèle est déjà préparé. La toile est vide : tout est à peindre. Le
temps est celui de `nextBatch`.

| Stratégie | 1000² | 2000² | 4096² |
|---|---|---|---|
| Haut vers le bas | 31 ms | 83 ms | 312 ms |
| Bas vers le haut | 25 ms | 99 ms | 363 ms |
| Gauche vers la droite | 27 ms | 97 ms | 361 ms |
| Droite vers la gauche | 27 ms | 101 ms | 356 ms |
| Centre vers l'extérieur | 38 ms | 119 ms | 449 ms |
| Aléatoire | 27 ms | 85 ms | 353 ms |
| Couleur par couleur | 35 ms | 140 ms | 522 ms |
| Contours d'abord | 42 ms | 149 ms | 699 ms |

**Objectif de moins de 200 ms en 2000²** : atteint par les huit stratégies
une fois le modèle préparé.

Avant deux optimisations, trois stratégies le dépassaient en 2000² :

| Stratégie | Avant | Après |
|---|---|---|
| Bas vers le haut | 266 ms | 99 ms |
| Contours d'abord | 212 ms | 149 ms |
| Couleur par couleur | 204 ms | 140 ms |

Les deux optimisations ne changent pas le résultat (test de propriété et
mutation vérifiée) :
- parcours des lignes de bas en haut pour la stratégie bas vers le haut,
  ce qui évite de remplacer le tas à presque chaque pixel ;
- mémoire de la dernière couleur testée contre la palette, et aucun test
  des points en cours quand il n'y en a pas.

**Préparation, une fois par révision** :

| Stratégie | 1000² | 2000² | 4096² |
|---|---|---|---|
| Aléatoire, ordre généré | 146 ms | 724 ms | 3,18 s |
| Aléatoire, depuis le cache vérifié | 43 ms | 265 ms | 1,19 s |
| Couleur par couleur | 12 ms | 32 ms | 132 ms |
| Autres stratégies | moins de 0,1 ms | moins de 0,1 ms | moins de 0,1 ms |

Le cache de l'aléatoire est vérifié par SHA-256 et contrôle de
permutation. La table des rangs occupe 3,8 Mio en 1000², 15,3 Mio en
2000² et 64 Mio en 4096².

**Au-delà du seuil** : le **tout premier lot d'une révision aléatoire**.
Il inclut la préparation : 808 ms en 2000² avec génération de l'ordre,
environ 350 ms depuis le cache. Les lots suivants réutilisent la
préparation. En 4096², aucun objectif n'est fixé : de 312 à 699 ms selon
la stratégie.

**Mémoire supplémentaire pendant `nextBatch`** : de 1 à 3 Mio, quelle que
soit la taille. Elle comprend le tas des k meilleurs en tableaux typés,
une ligne d'états et les écritures retenues. Rien n'est alloué par pixel.
Seule la table des rangs de l'aléatoire grandit avec l'image.

### Reprise d'un modèle presque terminé, pixels inconnus

| Scénario | 1000² | 2000² | 4096² |
|---|---|---|---|
| 99,9 % correct (0,1 % de pixels faux dispersés) | 11 à 17 ms | 41 à 47 ms | 172 à 196 ms |
| 50 % des lignes inconnues, politique `skip` | 19 à 27 ms | 64 à 104 ms | 277 à 429 ms |
| 50 % des lignes inconnues, politique `include` | 24 à 39 ms | 80 à 160 ms | 335 à 636 ms |

Un modèle presque terminé est **le cas le moins cher** : peu de pixels
passent dans le tas. Le temps restant est celui de la comparaison avec la
toile, qui doit couvrir tout le modèle pour fournir les compteurs
(`candidates`, couleurs indisponibles, pixels inconnus).

### Journal et reprise (`npm run bench:journal`, disque réel, une exécution)

| Opération | Taille de ligne | Durée |
|---|---|---|
| Ajout d'un bail de 1 pixel (fsync) | 0,4 Ko | 1,7 ms |
| Ajout d'un bail de 100 pixels | 8,3 Ko | 1,8 ms |
| Ajout d'un bail de 1 000 pixels | 82 Ko | 3,1 ms |
| Cycle complet de 1 000 pixels : bail, démarrage, clôture, historique (4 fsync) | — | 10 ms |

| Reprise (`recover`) | Taille du journal | Durée | Mémoire supplémentaire |
|---|---|---|---|
| 100 tentatives de 1 000 pixels | 14 Mio | 0,44 s | 55 Mio |
| 1 000 tentatives de 1 000 pixels | 146 Mio | 3,8 s | 420 Mio |
| 10 000 tentatives de 10 pixels | 19 Mio | 0,71 s | 77 Mio |

Le décodage des lignes par blocs a ramené la reprise de 146 Mio de 5,8 s
à 3,8 s. Le reste du coût vient de la lecture JSON et de la vérification
de chaque événement. La mémoire vient des tentatives closes, qui restent
en mémoire avec leurs pixels.

**Limite** : sans compactage, le journal d'un modèle de 1000² peint par
lots de 1 000 pixels atteint environ 146 Mio. Sa reprise prend alors
quelques secondes et environ 420 Mio. Le compactage atomique prévu par
l'ADR 0002 § 3, qui ne garderait que les tentatives ouvertes, reste à
faire. Il est proposé pour la phase suivante.

## 9. Limites connues

- Pas d'exécution « exactement une fois » (§ 4).
- Durabilité non démontrée contre une coupure électrique (§ 5).
- Le journal **grossit sans compactage**, et les tentatives closes restent
  en mémoire après la reprise : 146 Mio, 3,8 s et 420 Mio pour 1 000
  tentatives de 1 000 pixels (§ 8).
- Le tout premier lot d'une révision aléatoire dépasse 200 ms en 2000²
  (préparation de la table des rangs, § 8).
- **Historique** : une entrée peut manquer si le crash survient entre la
  clôture journalisée et l'ajout à l'historique. Le journal fait foi. Si
  l'ajout à l'historique échoue, `finish` rejette alors que la tentative
  est déjà close : un nouvel appel à `finish` donne `INVALID_TRANSITION`.
  L'historique se lit en entier à chaque requête (aucun index).
- **Journal endommagé** : si la ligne perdue est un bail, ses points ne
  sont plus « en cours ». Seule une lecture de la toile prise après la
  reprise les protège : le planificateur repart de la toile, et un pixel
  déjà correct n'est pas repeint.
- Une ligne endommagée reste signalée à chaque reprise. Les tentatives
  ouvertes sont alors toujours réconciliées, jamais libérées (choix
  prudent). Aucun outil de réparation du journal n'existe encore.
