# Ordonnanceur mono-agent (Phase 1B.8)

L'ordonnanceur (`createScheduler`, dans `@geoplacer/core`) assemble les
composants du moteur en une boucle de travail complète. Dans cette phase,
il tourne **uniquement sur le simulateur local** (`SimulatedCanvasProvider`).
Il n'est relié ni au serveur ni à l'interface.

## 1. Principe : coordonner, sans dupliquer

L'ordonnanceur n'a **aucune règle propre** : il appelle les composants
existants.

| Étape d'un cycle | Composant |
|---|---|
| Révision courante du modèle | `TemplateSource` (un `TemplateManager` : `(await load(ref)).template`), puis `prepareTemplate` |
| Baux expirés | `AttemptManager.expire` |
| Lecture de la toile (rectangle du modèle) | `CanvasReader.readRegion` |
| Tentatives incertaines | `AttemptManager.reconcile`, avec une lecture qui couvre leurs pixels |
| Ressources, si inconnues, incertaines ou trop anciennes | `ResourceSource.observe`, puis `ResourceManager.observe` |
| Progression et ETA | `computeProgress`, `estimateEta` |
| Prochain lot | `nextBatch` (WorkPlanner) |
| Bail, avec la lecture comme preuve | `AttemptManager.lease` |
| Démarrage, journalisé **avant** l'écriture | `AttemptManager.start` |
| Écriture | `CanvasWriter.applyPixels` |
| Clôture, avec l'observation renvoyée | `AttemptManager.finish` ou `fail` |

**Énergie** : le `ResourceManager` reste le **seul modèle d'énergie**. Le
coût par pixel, la régénération, la capacité et la palette de chaque agent
viennent des règles et des observations, jamais de l'ordonnanceur.

**Un seul agent actif** (V1) : la configuration garde une liste d'agents
pour le cas multi-agent, mais l'ordonnanceur refuse plus de
`maxActiveAgents` agents (1 en production), et refuse plus d'un agent
dans cette version.

## 2. Machine d'états

| État | Sens |
|---|---|
| `stopped` | À l'arrêt (état initial et final). |
| `initializing` | Reprise du journal (`recover`). |
| `running` | Planifie et écrit. |
| `paused` | Mis en pause sur demande : aucune nouvelle tentative. |
| `waiting-resources` | Énergie insuffisante, agent indisponible, ou observation des ressources trop ancienne, jusqu'à une date calculée. |
| `waiting-reconciliation` | Des tentatives incertaines attendent une lecture qui les couvre. |
| `completed` | La toile correspond au modèle : couverture complète, aucun pixel incorrect, aucune tentative ouverte. |
| `error` | Une intervention est nécessaire (voir ci-dessous). |

Transitions (testées) :

| De | Vers | Cause |
|---|---|---|
| `stopped` | `initializing` | `start()` ou `step()` : reprise du journal |
| `initializing` | `running` | Reprise terminée |
| `running` | `waiting-resources` | Plan en attente d'énergie, agent indisponible jusqu'à une date, ressources incertaines |
| `running` | `waiting-reconciliation` | Écriture sans réponse fiable ; plus rien à planifier tant que des tentatives sont ouvertes |
| `waiting-*` | `running` | Le cycle suivant peut écrire |
| `running`, `waiting-*` | `paused` | `pause()`, après l'écriture en cours |
| `paused` | `running` | `resume()` |
| tout état | `stopped` | `stop()` |
| `running`, `waiting-*` | `completed` | La toile correspond au modèle |
| tout état actif | `error` | Voir ci-dessous |

**Erreurs nécessitant une intervention** :

| Code | Cause |
|---|---|
| `BLOCKED` | Du travail reste dans des couleurs non débloquées, ou sur des pixels jamais observés. Ce n'est jamais présenté comme terminé. |
| `AGENT_UNAVAILABLE` | Agent indisponible sans date de fin. |
| `ENERGY_NEVER_SUFFICIENT` | La régénération ne suffit jamais pour un pixel, ou pour le lot minimal. |
| `JOURNAL_UNAVAILABLE` | Journal dans un état inconnu, par exemple après une publication interrompue : il faut redémarrer. |
| `PLAN_REFUSED` | Refus du planificateur autre qu'une attente (repère différent, ressources invalides…). |
| `TEMPLATE_UNAVAILABLE` | Le modèle ne peut pas être chargé. |
| `CYCLE_BUDGET` | Garde-fou : plus de `maxCycles` cycles (sert surtout aux tests). |

## 3. Commandes

L'interface est indépendante du frontend. Elle n'est pas encore reliée aux
anciens boutons du tableau de bord.

| Commande | Effet |
|---|---|
| `start()` | Reprend le journal, puis lance la boucle en arrière-plan. Se résout une fois la boucle lancée. |
| `pause()` | Aucune nouvelle tentative après l'opération en cours. Se résout quand l'état passe à `paused`. Réveille une attente en cours. |
| `resume()` | Reprend la boucle. |
| `stop({ abort? })` | Arrête après l'opération en cours, ou pendant celle-ci avec `abort` : l'écriture reçoit le signal d'abandon. Une tentative démarrée n'est **jamais abandonnée silencieusement** : elle est réconciliée si une lecture la couvre, sinon signalée ouverte dans le statut, puis réconciliée au démarrage suivant. Se résout avec le statut final. |
| `status()` | Statut structuré (§ 5). |
| `subscribe(listener)` | Événements ; renvoie la fonction de désabonnement. |
| `done()` | Se résout à la fin de la boucle : terminé, erreur ou arrêt. |
| `step()` | Un seul cycle, sans boucle (tests et diagnostic). |

**Reprise** : un nouveau processus (nouveau `ResourceManager` et nouvel
`AttemptManager` sur le même journal) restaure l'état depuis le journal et
les observations :

- les tentatives réservées jamais démarrées sont libérées ;
- les tentatives démarrées sont réconciliées par une lecture postérieure à
  la reprise ;
- les ressources sont observées à nouveau avant toute dépense.

## 4. Temps, ressources et attentes

- **Horloge injectée** (`Clock`) : `sleep(ms, signal)` pour toute attente.
  Avec l'horloge virtuelle du simulateur, une attente est instantanée, ce
  qui permet de simuler des heures sans attendre réellement.
- **Pas de boucle active** : quand l'énergie manque, l'ordonnanceur calcule
  avec le `ResourceManager` le temps nécessaire pour réunir le lot minimal
  (`minBatchSize`, ou les pixels restants s'ils sont moins nombreux), puis
  fait **une seule** attente. C'est vérifié par le compte des attentes :
  100 pixels, 5 au départ, 1 par seconde et des lots de 5 donnent environ
  19 attentes.
- **Indisponibilité** : attente jusqu'à la date annoncée, ou erreur s'il n'y
  en a pas.
- **Pause et arrêt** réveillent une attente en cours.
- **Ressources incertaines** (réponse perdue, résultat inconnu,
  redémarrage) : une nouvelle observation est exigée avant le bail suivant.
- **Lot** : au plus `maxBatchSize` pixels, limité par l'énergie (budget du
  WorkPlanner).

## 5. Suivi : statut et événements

`status()` renvoie à chaque cycle :

| Champ | Contenu |
|---|---|
| `templateId`, `revision`, `state`, `reason` | Modèle, révision, état de l'ordonnanceur et raison |
| `workPixels` | File de travail estimée : pixels incorrects, plus pixels inconnus comptés comme travail |
| `correct`, `incorrect`, `unknown`, `progressPercent` | Progression |
| `openAttempts`, `uncertainAttempts` | Tentatives ouvertes, et celles dont le résultat est incertain |
| `energy`, `nextAvailabilityAt` | Énergie, et date de la prochaine disponibilité quand l'ordonnanceur attend |
| `eta` | Durée, date de fin, ou raisons d'indisponibilité |
| `observations.canvas`, `observations.resources` | Date et origine des observations utilisées |
| `applied`, `attemptsClosed`, `cycles` | Compteurs |
| `recentErrors` | Dernières erreurs : date, code, message |

**Événements** (`subscribe`), prêts pour une future diffusion WebSocket :

| Événement | Contenu |
|---|---|
| `state` | Changement d'état, avec la raison |
| `cycle` | Statut de fin de cycle |
| `attempt` | Tentative close : état, pixels, pixels appliqués |
| `progress` | Progression |
| `error` | Erreur |

Un abonné qui lève une exception n'interrompt pas la boucle.

## 6. Résilience et limites de la réconciliation

- Une écriture sans réponse fiable (panne, réponse perdue, abandon) n'est
  **jamais relancée** ni tenue pour réussie : sa tentative reste ouverte
  et ses points restent réservés jusqu'à une lecture qui la couvre.
- **Envoyer une requête ne prouve rien.** Seuls comptent la réponse de la
  toile, ou ce qu'une lecture postérieure observe.
- **Limite** : observer la bonne couleur (`observed-correct`) ne prouve pas
  **quelle** opération l'a placée. Un autre acteur a pu peindre le pixel,
  ou l'écriture a pu aboutir malgré une réponse perdue.
- **Dépenses** : une réponse avec l'observation des ressources remplace la
  dépense, ce qui évite de compter deux fois. Un résultat inconnu rend les
  ressources incertaines jusqu'à une nouvelle observation.
- **Nouvelle révision du modèle** : les tentatives non démarrées sont
  annulées, les tentatives démarrées réconciliées, puis le nouveau modèle
  est préparé et peint.
- **Journal endommagé** : chaque bail apporte la lecture d'où il vient comme
  preuve (voir [journal.md](journal.md) § 4).

## 7. Paramètres

`SchedulerConfig` ; valeurs utilisées dans les tests du simulateur :

| Paramètre | Rôle | Valeur de test |
|---|---|---|
| `agents`, `maxActiveAgents` | Agents (un seul en V1) | `[agent]`, 1 |
| `maxBatchSize`, `minBatchSize` | Taille maximale et minimale d'un lot | 20, 1 |
| `leaseTtlMs` | Durée d'un bail | 600 000 |
| `unknownPixels` | Politique des pixels inconnus | `skip` |
| `freshness`, `maxResourceAgeMs` | Fraîcheur de la toile et des ressources | 60 s |
| `eta` | Cadence, couverture minimale, pauses | 0, 0 % |
| `reconcileRetryMs` | Délai avant de réessayer une réconciliation | 500 |
| `maxWaitMs` | Attente la plus longue (la révision et la toile sont revues au moins aussi souvent) | 1 h |
| `maxRecentErrors`, `maxCycles` | Erreurs gardées, garde-fou de cycles | 20, 5 000 |

Le compactage automatique du journal relève de l'`AttemptManager` :
`DEFAULT_AUTO_COMPACTION`, voir [journal.md](journal.md) § 3.

## 8. Tests et scénarios

- **`scheduler.test.ts`** (simulateur) :
  - exécution complète et statut ; `step` déterministe ; refus du
    multi-agent ;
  - attente d'énergie sans boucle active, indisponibilité datée ou
    indéfinie, palette individuelle ;
  - pause pendant une écriture ; arrêt avec abandon (tentative
    réconciliée) ; arrêt sans lecture possible (tentative signalée
    ouverte, puis réconciliée au démarrage suivant) ; arrêt sans abandon ;
    abonnés ;
  - toutes les pannes du simulateur en cours d'exécution, redémarrage du
    processus pendant une écriture, panne pendant la journalisation, panne
    pendant un compactage automatique, nouvelle révision, compactage
    automatique au long cours ;
  - mutations vérifiées : relance aveugle, arrêt sans réconciliation.
- **`scenarios.test.ts`** :
  - **A** : modèle de 100 × 100 créé et chargé par un vrai
    `TemplateManager`, énergie limitée. Terminé en environ 9 800 s
    virtuelles, aucun pixel appliqué deux fois.
  - **C** : plantage pendant une écriture, puis arrêt propre au milieu,
    avec deux redémarrages.
  - **D** : un acteur modifie une zone déjà conforme ; seule cette zone
    est repeinte.
  - **E** : réponse perdue puis observation ; aucune consommation en
    double.

## 9. Performances (`npm run bench:scheduler`, scénario B : 2000 × 2000)

Le modèle complet compte 4 millions de pixels et ne peut pas être peint
dans un banc : on mesure un nombre fixe de cycles.

| Mesure | B1, énergie abondante, lots de 1 000 | B2, énergie de 1 000, 1 par seconde |
|---|---|---|
| Premier lot (reprise, préparation, lecture, progression, plan, écriture) | 261 ms | 456 ms |
| Cycle réel (médiane / p95 / max) | 238 / 277 / 277 ms | 231 / 292 / 292 ms |
| dont lecture de la toile | ~8 ms | ~8 ms |
| dont calcul de la progression | 109 à 142 ms | 109 à 112 ms |
| Cadence | ~3 450 pixels par seconde réelle | — |
| Attente des ressources | aucune | 1 attente de 1 000 s virtuelles par lot |
| Pic de mémoire résidente | ~172 Mio | ~175 Mio |

La progression et le WorkPlanner parcourent tous deux le modèle entier à
chaque cycle. Ce sont les deux postes principaux, de l'ordre de 100 ms
chacun en 2000².

## 10. Limites

- **Calcul à chaque cycle** : la progression et l'ETA sont recalculées à
  chaque cycle, ce qui représente environ 110 à 140 ms en 2000². Un calcul
  moins fréquent ou incrémental n'est pas fait.
- **Un seul agent et un seul modèle par ordonnanceur** : le choix entre
  plusieurs modèles (priorités) n'est pas fait.
- **Contexte local uniquement** : aucun branchement au serveur, au
  WebSocket ou au tableau de bord.
- **Arrêt d'une écriture en cours** : il dépend du fournisseur. Le
  simulateur honore le signal pendant une écriture suspendue ; un vrai
  fournisseur devra le faire aussi.
