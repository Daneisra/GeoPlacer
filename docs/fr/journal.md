# Journal des tentatives : compactage, reprise, diagnostic (Phase 1B.7)

Ce document décrit comment le journal des tentatives reste borné
(checkpoints et générations), ce que garantit la reprise après un crash, et
comment diagnostiquer puis réparer un journal endommagé. Les tentatives
elles-mêmes sont décrites dans [planification.md](planification.md).

## 1. Deux fichiers, deux rôles

| | Journal transactionnel | Historique |
|---|---|---|
| Rôle | **Fait foi** pour les tentatives : baux, démarrages, résultats, réconciliations | Statistiques et interface |
| Fichiers | `journal/attempts*.log`, `journal/checkpoint-*.ckpt`, `journal/CURRENT` | `journal/history-*.log` |
| Taille | Bornée par le compactage | Bornée par la rotation |
| Après un crash | Relu et rejoué | Peut perdre sa dernière entrée ; jamais utilisé pour reconstruire une tentative |

## 2. État logique et checkpoints

L'**état logique** (`JournalState`) contient tout ce qu'un rejeu complet du
journal produit et dont la reprise a besoin :

- les **tentatives ouvertes**, complètes : pixels, baux, état (réservée,
  démarrée, à réconcilier) et dates ;
- les **tentatives closes** sous forme de **résumés** sans pixels :
  identifiant, agent, modèle, révision, état, dates, nombre de pixels
  appliqués (les dépenses enregistrées ont pour identifiant d'opération
  l'identifiant de la tentative) ;
- par agent, la **dernière clôture d'une tentative démarrée** (`lastSpendAt`) :
  les dépenses enregistrées en mémoire ne survivent pas à un redémarrage,
  donc une observation des ressources plus récente est exigée. Cette
  donnée est **explicite** et survit à la purge des résumés ;
- l'exigence d'une **lecture de la toile** après un dommage
  (`canvasReadRequiredAfter`) ;
- les **générations endommagées à préserver** ;
- la **position de reprise** : `lastSeq`, le numéro du dernier événement
  inclus.

Un seul réducteur pur (`JournalStateBuilder`) sert au gestionnaire en
marche, au rejeu complet et à la reprise depuis un checkpoint. Rejouer
« checkpoint + événements postérieurs » et rejouer « tout le journal »
passent donc par le même code. Les tests le vérifient (§ 7).

**Checkpoint** (`checkpoint-<g>.ckpt`) : `GPCKPT1`, puis un en-tête
(format, génération, `lastSeq`, longueur du corps, SHA-256 du corps), puis
l'état en JSON ASCII. Il est **vérifié avant usage** : longueur, SHA-256,
génération attendue, puis validation structurelle de chaque tentative et
de chaque résumé.

**Lignes du journal** (format 2) : `<CRC-32> {"v":2,"seq":n,"event":…}`.
Le numéro de séquence est **global** à toutes les générations : un
événement manquant au milieu se voit, même si chaque ligne a un CRC
correct. Les lignes de la Phase 1B.6 (format 1, sans numéro) restent
lisibles.

## 3. Générations et compactage

```
journal/
  CURRENT                      pointeur : « generation 3 » + CRC
  checkpoint-000000000003.ckpt état au début de la génération 3
  attempts-000000000003.log    événements depuis ce checkpoint
  checkpoint-000000000002.ckpt génération précédente (rétention)
  attempts-000000000002.log
  attempts.log                 génération 0 (journal de la 1B.6), tant qu'elle est conservée
```

**Compactage** (`AttemptManager.compact`). Les écritures du gestionnaire
sont **bloquées** pendant toute l'opération, qui est sérialisée avec les
autres. Les étapes sont les suivantes, avec g la génération en cours :

1. Si aucun pointeur n'existe encore, écrire `CURRENT` → g. Un pointeur
   existe ainsi avant tout fichier de génération.
2. Supprimer les fichiers orphelins de g+1 laissés par un compactage
   interrompu : ils ne peuvent jamais l'emporter.
3. Écrire le checkpoint g+1 : fichier temporaire, écriture complète, fsync,
   renommage, fsync du répertoire là où c'est possible.
4. Créer le journal vide de g+1.
5. **Relire** le checkpoint et le comparer à l'état.
6. **Publier** : remplacer `CURRENT` par g+1, de la même façon que pour le
   checkpoint. Si le remplacement échoue, relire le pointeur pour savoir
   quelle génération est réellement en usage. Si le pointeur ne peut pas
   être relu, refuser tout ajout jusqu'au prochain chargement.
7. Basculer les ajouts vers g+1.
8. **Rétention**, seulement maintenant : supprimer les générations au-delà
   de `retainGenerations` (2 par défaut : la génération courante et la
   précédente), sauf les générations préservées. Un échec de suppression
   n'est pas un échec du compactage : il est reporté au compactage suivant.

Le compactage est **refusé** si la génération en cours est endommagée
(`JOURNAL_DAMAGED`), car il effacerait la trace du dommage. Seule une
réparation confirmée (§ 6) peut écrire la génération suivante.

**Reprise** : lire `CURRENT`, vérifier le checkpoint de la génération,
puis lire en flux (par blocs de 4 Mio, mémoire bornée) les événements de
la génération.

| Situation | Comportement |
|---|---|
| Pas de pointeur ni de fichier de génération | Génération 0 (journal de la 1B.6, ou journal neuf) |
| Pas de pointeur, mais des fichiers de génération | **Refus** (`NO_POINTER`) : situation ambiguë, aller au diagnostic |
| Pointeur illisible | **Refus** (`BAD_POINTER`) |
| Fichiers d'une génération au-dessus du pointeur (compactage interrompu) | Ignorés pour l'état ; signalés |
| Checkpoint inutilisable, génération précédente conservée | Reconstruction depuis la génération précédente, **signalée comme dommage** |
| Checkpoint inutilisable, rien avant | **Refus** (`CHECKPOINT_UNUSABLE`) : aller au diagnostic |
| Ligne endommagée, séquence manquante, événement incohérent | Dommage : tentatives ouvertes réconciliées, lecture de la toile exigée, compactage refusé |
| Dernière ligne coupée | Ignorée (ajout interrompu), mise de côté et coupée avant l'ajout suivant |

## 4. Garanties après un crash

Les garanties de la 1B.6 sont conservées :

- une tentative **réservée jamais démarrée** est libérée : le démarrage est
  journalisé avant l'écriture sur la toile ;
- une tentative **démarrée sans résultat confirmé** reste **à réconcilier**,
  par une lecture de la toile prise après l'envoi en réconciliation ;
- une tentative incertaine n'est **jamais considérée comme réussie** : la
  réconciliation donne `observed-*`, jamais `applied` ;
- une dépense n'est **jamais comptée deux fois** : une seule opération
  d'identifiant donné, ou bien l'observation renvoyée avec l'écriture, mais
  pas les deux ;
- une tentative inconnue n'est **jamais relancée aveuglément**.

Après un redémarrage, les réservations (tentatives ouvertes, points en
cours, énergie engagée) sont reconstruites à l'identique. Les **ressources**
sont **incertaines jusqu'à une nouvelle observation**. Le moteur ne
reconstruit pas l'énergie de lui-même : il exige une observation plus
récente que la dernière dépense journalisée.

**Journal endommagé** : comme une ligne perdue a pu être un bail, la
reprise exige une **lecture de la toile postérieure** à elle avant **tout**
bail, sur tous les points (`CANVAS_READ_REQUIRED`, levé par
`confirmCanvasRead`, qui est journalisé). Les points lus au mieux dans les
lignes endommagées ne sont qu'un détail du rapport : ils ne servent jamais
de garantie.

## 5. Durabilité : ce qui est démontré, ce qui ne l'est pas

- **Démontré par les tests** : l'arrêt brutal d'un **processus**. Des
  processus réels s'arrêtent eux-mêmes à 10 étapes nommées : écriture
  partielle d'une ligne, avant un fsync, avant et après l'écriture du
  checkpoint, après son renommage, après la création du journal vide,
  après la relecture, après l'écriture et le renommage du pointeur, au
  début de la rétention. Le journal se rouvre alors dans l'état du journal
  complet, sans perdre de tentative ouverte.
- **Pas démontré** : la coupure électrique. Les écritures suivent
  « fichier temporaire, fsync, renommage », mais leur durabilité dépend du
  disque et du système, qui doivent honorer fsync et l'ordre des
  métadonnées. Aucune écriture n'est présentée comme une garantie absolue.
- **Windows et Linux** :
  - sous **Linux**, le répertoire est synchronisé (fsync) après un
    renommage ou une création, ce qui est nécessaire pour qu'un renommage
    survive à une coupure ;
  - sous **Windows**, un répertoire ne peut pas être synchronisé : le
    renommage repose sur la journalisation des métadonnées de NTFS.
    `FileAttemptJournal.status().dirSync` indique `unsupported` ;
  - le chemin Linux **n'a pas été exécuté** ici : seul Windows est testé ;
  - sous Windows, on ne peut pas couper un fichier ouvert en mode ajout,
    ni supprimer un fichier encore ouvert. Le journal coupe la fin
    déchirée par un descripteur séparé et ferme le segment avant la
    rotation ou la suppression.

## 6. Diagnostic et réparation

```powershell
npm run journal:diagnose -- <répertoire de données>          # lecture seule
npm run journal:diagnose -- <répertoire de données> --json
npm run journal:repair   -- <répertoire de données>          # affiche le plan, n'écrit rien
npm run journal:repair   -- <répertoire de données> --apply <identifiant du plan>
```

**Diagnostic**, strictement en lecture seule : il ne prend aucun verrou,
n'écrit rien et n'emprunte pas le chemin d'ajout, qui couperait une fin
déchirée. Un test le vérifie en comparant l'empreinte de tout le
répertoire avant et après. Il rapporte :

- le pointeur et la génération en usage ;
- chaque fichier avec sa taille et son SHA-256 ;
- pour chaque génération : nombre de lignes, lignes endommagées (numéro,
  position, longueur), séquences manquantes, lignes sans numéro, fin
  déchirée, checkpoint et sa validité ;
- les orphelins et l'état reconstruit ;
- les **tentatives affectées** : ouvertes dans un journal endommagé,
  nommées dans une ligne endommagée, ou concernées par un événement
  incohérent ;
- un verdict : `empty`, `healthy`, `torn-tail`, `damaged` ou `unreadable`,
  avec les recommandations.

Les noms sont **relatifs** au répertoire de données. Le rapport ne contient
ni octet brut d'une ligne endommagée ni texte libre des événements (raisons
d'échec) : il n'expose aucun secret.

**Réparation** :

1. Le plan (`repair` sans `--apply`) liste les opérations et calcule un
   **identifiant** à partir des opérations et des empreintes des fichiers.
2. `--apply <identifiant>` prend le verrou (refusé si le moteur tourne),
   refait le plan et le **refuse** si un fichier a changé (`PLAN_CHANGED`).
3. Il crée une **sauvegarde vérifiée** de tous les fichiers du journal dans
   `journal-backups/<date>-<plan>/`, avec un `SHA256SUMS` relu.
4. Il applique le plan par **le même chemin de publication** que le
   compactage, puis écrit une **trace** dans `journal/repairs/<date>.json`
   (plan, empreintes avant et après, emplacement de la sauvegarde).

| Diagnostic | Réparation |
|---|---|
| Fin déchirée seule | La mettre de côté puis la couper (même règle que l'ajout) |
| Journal endommagé | Nouvelle génération : toute tentative ouverte passe **à réconcilier**, une lecture de la toile est exigée avant tout bail, les ressources de chaque agent sont incertaines, et la génération endommagée et la précédente sont **préservées** (jamais supprimées par la rétention) |
| Pointeur absent ou illisible | Rétablir le pointeur vers la plus haute génération au checkpoint valide, puis réparer comme un journal endommagé |
| Checkpoint inutilisable, rien avant | Reconstruire depuis les seuls événements de la génération ; le plan l'annonce (`stateCertain: false`), car les tentatives ouvertes du checkpoint perdu ne peuvent pas toutes être connues. La lecture de la toile exigée protège tous les points |

Une corruption au milieu du journal n'est **jamais ignorée
automatiquement** : seule la réparation confirmée la traite, et la
génération endommagée est conservée.

## 7. Tests

- **A et B équivalents** :
  - 25 scénarios aléatoires, plus de 50 compactages, avec crashs ;
  - l'état reconstruit depuis le journal complet (A) est égal à celui
    reconstruit depuis le checkpoint et les événements postérieurs (B) ;
  - deux gestionnaires repris sur un journal compacté et sur un journal
    complet donnent les mêmes rapports, points en cours, énergie engagée
    et incertitude ;
  - mutations vérifiées (oubli de `lastSpendAt` à la reprise ou à la
    clôture).
- **Injection de fautes**, avant puis après chaque opération de fichier du
  compactage : l'état ne change jamais, une reprise le retrouve à
  l'identique, et le journal continue de fonctionner (ou refuse jusqu'au
  rechargement). Un compactage ultérieur réussit, sans fichier temporaire
  restant. Chaque étape a été interrompue au moins une fois.
- **Processus réels arrêtés** aux 10 étapes nommées (§ 5), synchronisés
  explicitement : l'enfant s'arrête lui-même, sans minuteur.
- **Diagnostic** : journal sain, endommagé (aucun contenu ni chemin
  exposé), orphelins, pointeur absent, checkpoint invalide.
- **Réparation** :
  - plan, identifiant faux refusé, sauvegarde vérifiée, trace, garanties
    après réparation, rétention qui respecte les générations préservées ;
  - fin déchirée, pointeur absent, checkpoint inutilisable sans génération
    antérieure, journal modifié après le plan ;
  - **injection de fautes à chaque opération de la réparation**. Elle a
    trouvé un défaut, corrigé : une panne d'entrée-sortie pendant le
    chargement faisait reconstruire l'état depuis les seuls événements, ce
    qui perdait les tentatives ouvertes du checkpoint.
- **Ligne de commande** : diagnostic en lecture seule, plan sans
  modification, application.

## 8. Performances (`npm run bench:journal`)

Le scénario reprend celui mesuré en 1B.6 : 1 000 tentatives de
1 000 pixels, dont 5 laissées ouvertes, soit un journal de 146 Mio. Deux
passes. « À froid » désigne un nouveau processus : le cache de fichiers du
système ne peut pas être vidé ici, donc le fichier peut déjà être en
mémoire. « À chaud » désigne une deuxième reprise dans le même processus.

| Mesure | 1B.6 | 1B.7, avant compactage | 1B.7, après compactage |
|---|---|---|---|
| Reprise à froid | 3,8 s | 3,2 à 3,7 s | **22 à 23 ms** |
| Reprise à chaud | — | 2,9 à 3,0 s | **18 à 20 ms** |
| Du lancement du processus à la reprise terminée | — | 6,9 à 7,4 s | **0,74 à 0,77 s** |
| Mémoire supplémentaire | 420 Mio | pic résident 106 Mio, 5 à 8 Mio conservés | pic résident 64 Mio, 1 Mio conservé |
| Journal actif | 146 Mio | 146 Mio | **0** (après le compactage) |

| Compactage du journal de 146 Mio | Valeur |
|---|---|
| Durée, écritures bloquées pendant toute l'opération | 70 à 87 ms |
| Taille du checkpoint (5 ouvertes, 995 résumés) | 0,6 Mio |
| Pic résident du processus (chargement compris) | 102 Mio |
| Ajout d'un bail de 1 000 pixels (fsync) | 3,4 ms |

La mémoire baisse avant même le compactage, grâce à la lecture en flux et
aux résumés de tentatives closes. Le temps de reprise **avant** compactage
reste proportionnel à la taille du journal : il faut compacter
régulièrement. Le déclenchement automatique du compactage relève de
l'ordonnanceur, qui n'est pas fait.

## 9. Historique : rotation et rétention

- **Segments** `history-<n>.log`. Un nouveau segment commence au-delà de
  `maxSegmentBytes` (8 Mio par défaut). Au-delà de `maxSegments` (8 par
  défaut), le plus ancien est supprimé. Le `history.log` de la 1B.6 est lu
  comme le segment le plus ancien.
- **Requêtes** : elles lisent les segments du plus récent au plus ancien et
  s'arrêtent dès que la limite est atteinte, ou dès qu'un segment commence
  avant `since`. Il n'y a **jamais de chargement intégral**.
- **Conséquences de la rétention** :
  - les entrées des segments supprimés sont **perdues** pour les
    statistiques ;
  - avec les réglages par défaut, il reste environ 64 Mio d'historique, à
    raison d'environ 300 octets par tentative close, soit environ
    200 000 tentatives ;
  - les tentatives elles-mêmes ne sont pas concernées : le journal fait
    foi.
- **Résumés des tentatives closes** dans le journal : par défaut, tous
  sont gardés. `compact(now, { maxClosedSummaries })` supprime les plus
  anciens. `get(id)` ne les retrouve alors plus, mais l'incertitude des
  ressources est conservée, grâce à `lastSpendAt`. Un événement tardif
  pour une tentative purgée serait incohérent, donc traité comme un
  dommage : c'est le côté prudent.
- **Reconstruction** de l'historique : possible à partir des générations
  de journal encore conservées (événements de clôture). Elle n'est pas
  outillée dans cette phase.
- Une entrée d'historique peut manquer après un crash survenu entre la
  clôture journalisée et l'ajout à l'historique (testé). Le journal fait
  foi.

## 10. Limites

- Le compactage est **manuel** (`compact`) : son déclenchement
  automatique sera fait avec l'ordonnanceur.
- Il bloque les écritures pendant toute sa durée (70 à 87 ms pour le
  journal de 146 Mio). Il n'existe pas de compactage concurrent.
- La durabilité n'est pas démontrée contre une coupure électrique, et le
  chemin Linux (fsync du répertoire) n'est pas exécuté ici.
- Aucun outil ne reconstruit l'historique.
- La réparation d'un checkpoint inutilisable, sans génération antérieure,
  ne peut pas retrouver les tentatives ouvertes perdues. Elle l'annonce,
  et la lecture de la toile exigée protège tous les points.
