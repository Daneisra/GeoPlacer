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

> **Phase 1B.7** : le journal est désormais compacté en générations, avec
> des checkpoints vérifiés, des lignes numérotées (format 2), un
> diagnostic et une réparation. L'historique est découpé en segments
> tournants. Voir [journal.md](journal.md). Cette section décrit les
> règles de ligne, qui restent valables.

| Fichier | Contenu |
|---|---|
| `<données>/journal/attempts.log` | Un événement de tentative par ligne. Depuis la 1B.7, c'est la génération 0, suivie de `attempts-<g>.log`. |
| `<données>/journal/history.log` | Une entrée d'historique par tentative close. Fichier séparé, jamais compacté avec le journal. Depuis la 1B.7, découpé en `history-<n>.log`. |

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

**Écriture** : une ligne complète (une écriture partielle est complétée),
puis `fsync`, avant de rendre la main. En cas d'erreur, le fichier est
rouvert avant l'ajout suivant : une ligne partielle est alors mise de
côté et coupée, au lieu d'être suivie d'une nouvelle ligne (testé par
injection : ligne partielle puis erreur ; mutation vérifiée). Les adaptateurs
exigent le verrou du répertoire de données.

**Durabilité** : elle est testée contre l'**arrêt brutal du processus**
(depuis la 1B.7, des processus réels s'arrêtent eux-mêmes à des étapes
nommées). Elle n'est **pas** démontrée
contre une coupure électrique : cela dépend du disque qui honore `fsync`,
et aucun test approprié n'existe.

## 6. Reprise après crash

Au démarrage, `recover(now)` est obligatoire avant toute autre opération
(sinon `NOT_RECOVERED`) :

1. **Relire le journal** et rejouer chaque événement avec la même machine
   d'états (`transition`, fonction pure). Depuis la 1B.7, la relecture
   part du checkpoint de la génération en usage, puis lit ses événements
   en flux (réducteur `JournalStateBuilder`).
2. **Identifier les tentatives incomplètes** :
   - une tentative **réservée jamais démarrée** est annulée (« libérée ») ;
     elle n'a rien envoyé, puisque le démarrage est journalisé avant
     l'écriture ;
   - une tentative **démarrée sans clôture** est envoyée en réconciliation.
3. **Journal endommagé** (lignes corrompues ou incohérentes, séquence
   manquante, checkpoint de repli) : un événement « démarrée », ou un
   bail entier, a pu être perdu. **Toutes** les tentatives ouvertes sont
   donc envoyées en réconciliation, et aucune n'est libérée. Depuis la
   1B.7, le compactage est refusé ; depuis la 1B.8, chaque bail porte une
   lecture postérieure au dommage qui couvre ses points (voir
   [journal.md](journal.md) § 4).
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
`corruptLines` et `inconsistentEvents`. Depuis la 1B.7, il contient aussi
`generation`, `fromCheckpoint`, `sequenceGaps`, `problems`, `damaged` et
`damage`. Une tentative close est conservée sous forme de
résumé, sans ses pixels (`get` renvoie ce résumé). La reprise est idempotente : une
deuxième reprise ne libère rien de plus (testé).

## 7. Plusieurs agents

La V1 n'active qu'un agent. Le modèle est **préparé** pour plusieurs
agents sur un même projet, sans être activé sur un service réel :

- les points en cours sont partagés, quel que soit l'agent ;
- l'énergie engagée et l'incertitude des ressources sont comptées par
  agent ;
- un test de propriétés fait travailler trois agents simulés sur une
  toile locale (30 toiles aléatoires, 300 actions chacune). Les actions
  sont tirées au hasard et **entrelacées** : bail pour n'importe quel
  agent pendant que d'autres tentatives sont ouvertes, bail qui réutilise
  un point en cours (doit être refusé), démarrage, écriture et clôture
  avec fautes injectées, écriture puis crash avant la clôture, expiration.
  Il vérifie :
  - qu'aucun point n'est dans deux tentatives ouvertes, après chaque
    action ;
  - que le planificateur ne propose jamais un point en cours ;
  - qu'aucun pixel n'est appliqué deux fois ;
  - que le travail éligible est conservé : tout pixel incorrect finit
    correct, appliqué une seule fois ;
  - qu'une dépense n'est enregistrée qu'une fois par identifiant.

  Le test vérifie aussi qu'il n'est pas vide : plusieurs tentatives
  ouvertes en même temps, des chevauchements refusés, des tentatives
  libérées et réconciliées après crash, des tentatives démarrées puis
  expirées. Retirer le refus `OVERLAP` du bail, ou l'exclusion des points
  en cours du planificateur, le fait échouer (mutations vérifiées).

## 8. Performances

Conditions : Windows 10, Node 22.23.2, machine de développement. Images :
- pixel art à 32 couleurs, avec environ 3 % de pixels transparents, à
  toutes les tailles ;
- bruit à 32 couleurs (1/8 transparent) et image uniforme, en 2000².

Médiane de 5 exécutions après un échauffement, un processus par taille et
par image. Les instantanés sont en mémoire, avec `readRow`. Les
fourchettes réunissent deux passes complètes du banc.

### Premier lot de 1 000 pixels (`npm run bench:planner`)

Le modèle est déjà préparé. La toile est vide : tout est à peindre. Le
temps est celui de `nextBatch`.

| Stratégie | Pixel art 1000² | Pixel art 2000² | Pixel art 4096² | Bruit 2000² | Uniforme 2000² |
|---|---|---|---|---|---|
| Haut vers le bas | 31–34 ms | 80–83 ms | 312–331 ms | 143 ms | 77 ms |
| Bas vers le haut | 25–30 ms | 93–99 ms | 363–405 ms | 158 ms | 98 ms |
| Gauche vers la droite | 25–27 ms | 97–101 ms | 361–397 ms | 149 ms | 94 ms |
| Droite vers la gauche | 27–28 ms | 101–103 ms | 356–409 ms | 155 ms | 95 ms |
| Centre vers l'extérieur | 33–38 ms | 119–133 ms | 445–449 ms | 181 ms | 112 ms |
| Aléatoire | 23–27 ms | 85–99 ms | 345–353 ms | 147 ms | 77 ms |
| Couleur par couleur | 31–35 ms | 140–167 ms | 522–523 ms | **256 ms** | 117 ms |
| Contours d'abord | 42 ms | 149–177 ms | 640–699 ms | **202 ms** | 152 ms |

**Objectif de moins de 200 ms en 2000²**, une fois le modèle préparé :
- **atteint** par les huit stratégies sur le pixel art et l'image
  uniforme ;
- **dépassé sur l'image bruitée** par deux stratégies :
  - **couleur par couleur** (256 ms) : la couleur change presque à chaque
    pixel, donc la mémoire de la dernière couleur ne sert plus, et les
    clés arrivent dans le désordre (nombreux remplacements dans le tas) ;
  - **contours d'abord** (202 ms) : presque tous les pixels d'une image
    bruitée sont des contours ;
- **centre vers l'extérieur** (181 ms) est proche du seuil.

Pistes non réalisées : une table compacte des couleurs débloquées (index
de couleur au lieu d'un `Set`), et une sélection par seuil plutôt qu'un
tas. Aucune ne justifiait de toucher à la fiabilité dans cette phase.

Avant deux optimisations, trois stratégies dépassaient le seuil en 2000²
sur le pixel art :

| Stratégie | Avant | Après |
|---|---|---|
| Bas vers le haut | 266 ms | 93–99 ms |
| Contours d'abord | 212 ms | 149–177 ms |
| Couleur par couleur | 204 ms | 140–167 ms |

Les deux optimisations ne changent pas le résultat (test de propriété et
mutation vérifiée) :
- parcours des lignes de bas en haut pour la stratégie bas vers le haut,
  ce qui évite de remplacer le tas à presque chaque pixel ;
- mémoire de la dernière couleur testée contre la palette, et aucun test
  des points en cours quand il n'y en a pas.

**Préparation, une fois par révision** :

| Stratégie | 1000² | 2000² | 4096² |
|---|---|---|---|
| Aléatoire, ordre généré | 131–146 ms | 724–731 ms | 2,96–3,18 s |
| Aléatoire, depuis le cache vérifié | 34–43 ms | 265–308 ms | 1,15–1,19 s |
| Couleur par couleur | 12–14 ms | 32–42 ms | 119–132 ms |
| Autres stratégies | moins de 0,1 ms | moins de 0,1 ms | moins de 0,1 ms |

Le cache de l'aléatoire est vérifié par SHA-256 et contrôle de
permutation. La table des rangs occupe 3,8 Mio en 1000², 15,3 Mio en
2000² et 64 Mio en 4096².

**Au-delà du seuil** : le **tout premier lot d'une révision aléatoire**.
Il inclut la préparation : environ 0,8 s en 2000² avec génération de
l'ordre, environ 0,4 s depuis le cache. Les lots suivants réutilisent la
préparation. En 4096², aucun objectif n'est fixé : de 312 à 699 ms selon
la stratégie.

**Mémoire supplémentaire pendant `nextBatch`** : de 1 à 3 Mio, quelle que
soit la taille. Elle comprend le tas des k meilleurs en tableaux typés,
une ligne d'états et les écritures retenues. Rien n'est alloué par pixel.
Seule la table des rangs de l'aléatoire grandit avec l'image.

### Optimisation ciblée de la Phase 1B.7 (`npm run bench:planner-focus`)

Sont visés « couleur par couleur » et « contours d'abord », qui
dépassaient 200 ms sur une image bruitée en 2000². Trois changements
sont faits, sans modifier l'ordre (propriétés et mutation vérifiées) :

- **couleur par couleur** : le rang de couleur est lu dans une table
  typée à adressage ouvert, au lieu d'une `Map` ;
- **contours d'abord** : une carte des contours est calculée une fois par
  révision. Elle occupe 1 bit par pixel, soit 0,5 Mio en 2000² et 2 Mio
  en 4096², et sa préparation prend 16 à 19 ms en 2000² ;
- **palette** : les couleurs débloquées sont lues dans la même table
  typée, au lieu d'un `Set`. Ce changement touche toutes les stratégies,
  ce que justifie un gain mesuré sans régression.

**Comparaison fiable** : A/B alterné dans un même processus, sur le même
`nextBatch`, avec un lot identique vérifié. Médianes de 3 alternances
de 30 tours, en 2000² :

| Stratégie | Image | 1B.6 | Clés 1B.7 | Plus palette typée |
|---|---|---|---|---|
| Couleur par couleur | Bruit | 244 à 251 ms | 213 à 221 ms | 158 à 164 ms |
| Contours d'abord | Bruit | 205 à 209 ms | 180 à 188 ms | 152 à 156 ms |
| Contours d'abord | Pixel art | 145 à 150 ms | 114 à 116 ms | — |
| Couleur par couleur | Pixel art | 122 à 129 ms | 126 à 127 ms (sans effet) | — |

La palette typée, mesurée par alternance de processus (3 × 2), gagne
aussi sur les autres stratégies : de 15 à 17 % sur le bruit (haut vers le
bas : 166–174 → 139–146 ms ; centre : 238–250 → 204–206 ms) et de 3 à 7 %
sur le pixel art.

**Valeurs absolues de la version finale** : banc ciblé, 2000², 25 tours,
machine plus chargée que pendant la 1B.6.

| Stratégie | Image | Médiane | p95 | Max | Préparation |
|---|---|---|---|---|---|
| Couleur par couleur | Bruit | 166 ms | 182 ms | 191 ms | 73 ms |
| Contours d'abord | Bruit | 157 ms | 180 ms | 215 ms | 17 ms |
| Couleur par couleur | Pixel art | 105 ms | 119 ms | 138 ms | 31 ms |
| Contours d'abord | Pixel art | 130 ms | 139 ms | 143 ms | 19 ms |

**Allocations** : 1,3 à 2,5 Mio transitoires par appel, sans croissance
avec la taille. Le surplus d'environ 1 Mio, avec la palette typée, sur
certaines stratégies n'est **pas expliqué** : la table elle-même fait
quelques centaines d'octets. **Constat hors périmètre** : « centre vers
l'extérieur » alloue 9 à 15 Mio par appel, probablement parce que ses
clés dépassent les petits entiers de V8. Ce point n'a pas été modifié.

**Variabilité** : sur ce poste, deux passes du banc complet diffèrent
jusqu'à environ 30 %. Dans un passage chargé, « couleur par couleur » et
« centre » sur bruit en 2000² ont encore donné 210 et 217 ms. Le seuil
de 200 ms n'est donc pas garanti pour une image bruitée. Il l'est pour
le pixel art et pour l'image uniforme.

### Reprise d'un modèle presque terminé, pixels inconnus

| Scénario | 1000² | 2000² | 4096² |
|---|---|---|---|
| Environ 99,9 % correct : 957, 3 873 et 16 280 pixels faux dispersés (pixel art) | 11 à 17 ms | 41 à 61 ms | 169 à 226 ms |
| Idem, bruit et uniforme (2000²) | — | 40 à 55 ms | — |
| 50 % des lignes inconnues, politique `skip` | 18 à 34 ms | 64 à 114 ms | 276 à 429 ms |
| 50 % des lignes inconnues, politique `include` | 21 à 41 ms | 80 à 187 ms | 335 à 636 ms |

Un modèle presque terminé est **le cas le moins cher** : peu de pixels
passent dans le tas. Le temps restant est celui de la comparaison avec la
toile, qui doit couvrir tout le modèle pour fournir les compteurs
(`candidates`, couleurs indisponibles, pixels inconnus).

### Journal et reprise (`npm run bench:journal`, disque réel, une exécution)

> Mesures de la 1B.6, **avant le compactage**. Depuis la 1B.7, la reprise
> du même journal de 146 Mio prend 22 ms après compactage (3,2 à 3,7 s
> avant), avec un pic de mémoire résidente de 64 Mio au lieu de 420 Mio.
> Voir [journal.md](journal.md) § 8.

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
- Le journal grossissait sans compactage : c'est résolu en 1B.7
  (compactage, résumés des tentatives closes, lecture en flux), voir
  [journal.md](journal.md). Le compactage reste à déclencher par
  l'appelant.
- En 2000², sur une image **bruitée**, le premier lot dépasse 200 ms pour
  « couleur par couleur » (256 ms) et « contours d'abord » (202 ms). Le
  tout premier lot d'une révision aléatoire dépasse aussi le seuil
  (préparation de la table des rangs). Voir § 8.
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
